import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { dirname } from "node:path";
import { resolveWorkspacePath } from "@/utils/workspace/files";

/** 一句台词：谁说、说什么。speaker 用角色档案里的名字，画外音也照写，靠 ownShot 区分。 */
export interface CoverageLine {
  speaker: string;
  line: string;
  lipSync?: "visible" | "offscreen";
  framing?: string;
}

/** 覆盖表的一行 = 一个计划中的镜头。 */
export interface CoverageShot {
  id: string;
  /** 计划时长（秒）。缺省时只做说话人校验，不判台词是否超长。 */
  duration?: number;
  /** 本镜画面里实际出现的人。 */
  visible?: string[];
  /** 本镜的说话人在别处有没有独立镜头；有就允许他画外发声。 */
  ownShot?: boolean;
  /** 结构化台词，优先使用；没有时退回 line + turns。 */
  lines?: CoverageLine[];
  /** 整段台词文本，与 lines 二选一。 */
  line?: string;
  /** 说话人轮换次数，只在没有 lines 时使用。 */
  turns?: number;
  /** 本镜来源，便于回溯（例如「正片 v1」）。 */
  note?: string;
}

export interface CoverageFile {
  note?: string;
  shots?: CoverageShot[];
}

export interface CoverageCheck {
  key: string;
  level: "block" | "warn" | "info";
  passed: boolean;
  detail: string;
  rule?: string;
}

export interface CoverageRow {
  id: string;
  speaker: string;
  visible: string[];
  ownShot: boolean;
  turns: number;
  chars: number;
  duration?: number;
  /** 判定结果，按严重程度取最重的一条。 */
  problem: "orphan" | "overloaded" | "offscreen" | "multi" | "crowded" | "";
  detail: string;
}

export interface CoverageSplit {
  from: string;
  shots: {
    id: string;
    speaker: string;
    text: string;
    duration: number;
    shotSize: string;
    foreground: string;
    note: string;
  }[];
}

const speechRate = 3.5;

export function countChars(text: string) {
  return String(text ?? "").replace(/[^\u4e00-\u9fa5]/g, "").length;
}

/** 按说话人连续段计轮换次数：A-A-B 是 2 轮，不是 3 轮。 */
export function countTurns(shot: CoverageShot) {
  const lines = Array.isArray(shot.lines) ? shot.lines.filter(item => item?.speaker) : [];
  if (!lines.length) return Math.max(0, Number(shot.turns ?? 0));
  let turns = 0;
  let previous = "";
  for (const item of lines) {
    if (item.speaker !== previous) {
      turns += 1;
      previous = item.speaker;
    }
  }
  return turns;
}

function shotText(shot: CoverageShot) {
  const lines = Array.isArray(shot.lines) ? shot.lines.filter(item => item?.speaker) : [];
  return lines.length ? lines.map(item => item.line).join("") : String(shot.line ?? "");
}

function leadSpeaker(shot: CoverageShot) {
  const lines = Array.isArray(shot.lines) ? shot.lines.filter(item => item?.speaker) : [];
  return lines[0]?.speaker ?? "";
}

/**
 * 覆盖表只拦未交代来源的声音；轮次与字数是设计提示，不能替代模型能力和真实音频时长。
 */
export function evaluateCoverage(shots: CoverageShot[]) {
  const rows: CoverageRow[] = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    if (!shot?.id) continue;
    const lines = Array.isArray(shot.lines) ? shot.lines.filter(item => item?.speaker) : [];
    const speaker = leadSpeaker(shot);
    const visible = Array.isArray(shot.visible) ? shot.visible.filter(Boolean) : [];
    const ownShot = shot.ownShot === true;
    const turns = countTurns(shot);
    const chars = countChars(shotText(shot));
    const duration = typeof shot.duration === "number" && shot.duration > 0 ? shot.duration : undefined;
    let problem: CoverageRow["problem"] = "";
    let detail = "";
    const orphan = lines.find(item => !visible.includes(item.speaker) && (item.lipSync === "visible"
      || !ownShot && !(item.lipSync === "offscreen" && item.framing?.trim())));
    if (orphan) {
      problem = "orphan";
      detail = `${shot.id}：${orphan.speaker} 不在画，请保留原句并补齐画内覆盖，或明确 offscreen 及 framing 声源依据`;
    } else if (turns >= 3) {
      problem = "overloaded";
      detail = `${shot.id}：一镜有 ${turns} 轮说话人，核对同框调度、逐句可见性、模型同步能力和实际声音容量；能完整执行的持续镜头可以保留，不强制拆镜`;
    } else if (turns >= 2 && visible.length === 1) {
      // 画面里只有一个人，却在和画外的人来回对话：观众听见对方说话，却始终看不见他。
      // 「对方在别处有镜头」只能让观众知道是谁在说，不解决这一句该给谁镜头。
      problem = "offscreen";
      detail = `${shot.id}：画面里只有 ${visible[0]}，却有 ${turns} 轮画外对答，观众会听见对方说话却看不见他`;
    } else if (duration && chars && chars / speechRate > duration) {
      problem = "crowded";
      detail = `${shot.id}：${chars} 字按 ${speechRate} 字/秒粗估 ${(chars / speechRate).toFixed(1)} 秒，计划 ${duration} 秒；仅提示容量风险，生成配音后以真实时长为准，不自动删词、加速或平均分秒`;
    } else if (turns === 2) {
      problem = "multi";
      detail = `${shot.id}：一镜里换了一轮说话人，同框长镜可以保留，但要给听者可见反应`;
    }
    rows.push({ id: shot.id, speaker, visible, ownShot, turns, chars, duration, problem, detail });
  }
  const orphans = rows.filter(row => row.problem === "orphan");
  const overloaded = rows.filter(row => row.problem === "overloaded");
  const offscreen = rows.filter(row => row.problem === "offscreen");
  const multi = rows.filter(row => row.problem === "multi");
  const crowded = rows.filter(row => row.problem === "crowded");
  return { rows, orphans, overloaded, offscreen, multi, crowded };
}

export function coverageCheck(shots: CoverageShot[] | undefined): CoverageCheck {
  if (!Array.isArray(shots) || !shots.length) {
    return {
      key: "coverage",
      level: "warn",
      passed: false,
      detail: "没有 assets/coverage.json，请核对逐句声音归属、画内/画外覆盖和实际时长；多轮持续镜头并非必然错位",
      rule: "对白覆盖与正反打",
    };
  }
  const { rows, orphans, overloaded, offscreen, multi, crowded } = evaluateCoverage(shots);
  const problems = [
    orphans.length ? `${orphans.length} 行说话人不在画且没有独立镜头（${orphans.slice(0, 3).map(row => row.id).join("、")}），成片会听见他说话却看不见他` : "",
    overloaded.length ? `${overloaded.length} 行有多轮对白（${overloaded.slice(0, 3).map(row => row.id).join("、")}），须核对同框调度、模型能力和真实声音容量，不强制每句切镜` : "",
    offscreen.length ? `${offscreen.length} 行是「画面一个人 + 画外对答」（${offscreen.slice(0, 4).map(row => row.id).join("、")}），对方说话时没有镜头，属于缺反打` : "",
    multi.length ? `${multi.length} 行换了一轮说话人，同框长镜可保留，但要确认听者有可见反应` : "",
    crowded.length ? `${crowded.length} 行存在粗估容量风险（${speechRate} 字/秒非硬性语速）：${crowded.slice(0, 3).map(row => row.id).join("、")}` : "",
  ].filter(Boolean);
  return {
    key: "coverage",
    level: orphans.length ? "block" : "warn",
    passed: problems.length === 0,
    detail: problems.join("；") || `${rows.length} 行对白已交代声音归属；实际声音、可见口型及动作容量仍需生成后检查`,
    rule: "对白覆盖与正反打",
  };
}

/**
 * 只对有覆盖/容量风险的段落给出备选拆镜，不自动执行，不删台词，不替代实际时长。
 */
export function suggestSplits(shots: CoverageShot[]): CoverageSplit[] {
  const splits: CoverageSplit[] = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    const lines = Array.isArray(shot.lines) ? shot.lines.filter(item => item?.speaker) : [];
    const problem = evaluateCoverage([shot]).rows[0]?.problem;
    if (!lines.length || !["orphan", "offscreen", "crowded"].includes(problem ?? "") || countTurns(shot) < 2) continue;
    const groups: { speaker: string; text: string }[] = [];
    for (const item of lines) {
      const last = groups[groups.length - 1];
      if (last && last.speaker === item.speaker) last.text += item.line;
      else groups.push({ speaker: item.speaker, text: item.line });
    }
    const counterpart = (Array.isArray(shot.visible) ? shot.visible : []).find(name => name !== groups[0].speaker) ?? "";
    const pieces = groups.map((group, index) => {
      const chars = countChars(group.text);
      const duration = Math.max(0.5, Math.ceil(chars / speechRate * 10) / 10);
      const other = group.speaker === counterpart ? groups[0].speaker : counterpart;
      return {
        id: `${shot.id}${String.fromCharCode(97 + index)}`,
        speaker: group.speaker,
        text: group.text,
        duration,
        shotSize: "近景",
        foreground: other ? `${other}的肩（虚焦，占画面一条边）` : "",
        note: "备选覆盖，不自动应用；时长仅为粗估，沿用原句与实际声音，保留触发、反应及动作接续，不强制一镜一个节拍",
      };
    });
    splits.push({ from: shot.id, shots: pieces });
  }
  return splits;
}

/** 读取覆盖表；文件不存在返回 null，不抛错。 */
export async function readCoverage(directory: string): Promise<CoverageFile | null> {
  const resolved = await resolveWorkspacePath(directory, "assets/coverage.json", true).catch(() => null);
  if (!resolved) return null;
  const content = await readFile(resolved.path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (content === null || content === undefined) return null;
  try {
    const parsed = JSON.parse(content) as CoverageFile;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCoverage(directory: string, file: CoverageFile) {
  const resolved = await resolveWorkspacePath(directory, "assets/coverage.json", true);
  await mkdir(dirname(resolved.path), { recursive: true });
  await writeAtomic(resolved.path, JSON.stringify(file, null, 1));
  return resolved.path;
}

/**
 * 生成闸门：覆盖表判 block 的项目不放行视频生成。
 * 只在项目里存在覆盖表时生效——没排过表的项目保持旧行为，不因为规则升级突然跑不动。
 */
export async function coverageGate(directory: string): Promise<string | null> {
  const file = await readCoverage(directory);
  if (!file || !Array.isArray(file.shots) || !file.shots.length) return null;
  const check = coverageCheck(file.shots);
  if (check.level === "block" && !check.passed) {
    return `${check.detail}。先核对画内/画外计划及真实声源，必要时补覆盖；不删台词或关闭检查绕过。`;
  }
  return null;
}
