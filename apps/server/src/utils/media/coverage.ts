import { readFile, writeAtomic } from "@toonflow/file";
import { resolveWorkspacePath } from "@/utils/workspace/files";

/** 一句台词：谁说、说什么。speaker 用角色档案里的名字，画外音也照写，靠 ownShot 区分。 */
export interface CoverageLine {
  speaker: string;
  line: string;
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

const SPEECH_RATE = 3.5;

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
 * 覆盖表校验：说话人不在画又没有独立镜头、一轮以上的说话人交替、台词超出时长容量。
 * 这三条都能在开拍前判死，不必等成片出来才发现「听见 B 的声音却一直看着 A 的脸」。
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
    if (speaker && !visible.includes(speaker) && !ownShot && lines.length) {
      problem = "orphan";
      detail = `${shot.id}：${speaker} 说话但不在画，也没有他的独立镜头`;
    } else if (turns >= 3) {
      problem = "overloaded";
      detail = `${shot.id}：一镜里换了 ${turns} 轮说话人（${lines.map(item => item.speaker).filter((name, index, list) => list.indexOf(name) === index).join("、")}），必须拆成正反打`;
    } else if (turns >= 2 && visible.length === 1) {
      // 画面里只有一个人，却在和画外的人来回对话：观众听见对方说话，却始终看不见他。
      // 「对方在别处有镜头」只能让观众知道是谁在说，不解决这一句该给谁镜头。
      problem = "offscreen";
      detail = `${shot.id}：画面里只有 ${visible[0]}，却有 ${turns} 轮画外对答，观众会听见对方说话却看不见他`;
    } else if (turns === 2) {
      problem = "multi";
      detail = `${shot.id}：一镜里换了一轮说话人，同框长镜可以保留，但要给听者可见反应`;
    } else if (duration && chars && chars / SPEECH_RATE > duration) {
      problem = "crowded";
      detail = `${shot.id}：${chars} 字台词按 ${SPEECH_RATE} 字/秒需要 ${(chars / SPEECH_RATE).toFixed(1)} 秒，计划只有 ${duration} 秒`;
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
      detail: "没有 assets/coverage.json，对白镜没有排过覆盖表；一轮以上的说话人交替会变成画外音错位",
      rule: "对白覆盖与正反打",
    };
  }
  const { rows, orphans, overloaded, offscreen, multi, crowded } = evaluateCoverage(shots);
  const problems = [
    orphans.length ? `${orphans.length} 行说话人不在画且没有独立镜头（${orphans.slice(0, 3).map(row => row.id).join("、")}），成片会听见他说话却看不见他` : "",
    overloaded.length ? `${overloaded.length} 行在一镜里换了三轮以上说话人（${overloaded.slice(0, 3).map(row => row.id).join("、")}），等于把对话戏塞进一个机位，必须拆成正反打` : "",
    offscreen.length ? `${offscreen.length} 行是「画面一个人 + 画外对答」（${offscreen.slice(0, 4).map(row => row.id).join("、")}），对方说话时没有镜头，属于缺反打` : "",
    multi.length ? `${multi.length} 行换了一轮说话人，同框长镜可保留，但要确认听者有可见反应` : "",
    crowded.length ? `${crowded.length} 行台词超出时长容量（按 ${SPEECH_RATE} 字/秒）：${crowded.slice(0, 3).map(row => row.id).join("、")}` : "",
  ].filter(Boolean);
  return {
    key: "coverage",
    level: orphans.length || overloaded.length ? "block" : "warn",
    passed: problems.length === 0,
    detail: problems.join("；") || `${rows.length} 行对白均有人物归属、无多轮同镜，台词字数与时长匹配`,
    rule: "对白覆盖与正反打",
  };
}

/**
 * 拆镜建议：把一镜里的台词按说话人连续段切成正反打，配上近景与过肩前景。
 * 只给结构和时长建议，不改台词——台词是作者的东西，工具只负责让它有人演。
 */
export function suggestSplits(shots: CoverageShot[]): CoverageSplit[] {
  const splits: CoverageSplit[] = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    const lines = Array.isArray(shot.lines) ? shot.lines.filter(item => item?.speaker) : [];
    if (!lines.length || countTurns(shot) < 2) continue;
    const groups: { speaker: string; text: string }[] = [];
    for (const item of lines) {
      const last = groups[groups.length - 1];
      if (last && last.speaker === item.speaker) last.text += item.line;
      else groups.push({ speaker: item.speaker, text: item.line });
    }
    const counterpart = (Array.isArray(shot.visible) ? shot.visible : []).find(name => name !== groups[0].speaker) ?? "";
    const pieces = groups.map((group, index) => {
      const chars = countChars(group.text);
      const duration = Math.min(15, Math.max(4, Math.ceil(chars / SPEECH_RATE + 1.2)));
      const other = group.speaker === counterpart ? groups[0].speaker : counterpart;
      return {
        id: `${shot.id}${String.fromCharCode(97 + index)}`,
        speaker: group.speaker,
        text: group.text,
        duration,
        shotSize: "近景",
        foreground: other ? `${other}的肩（虚焦，占画面一条边）` : "",
        note: "首帧取「正在说这句」的那一瞬间；镜内只演这一个节拍",
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
    return `${check.detail}。先拆镜，或改 assets/coverage.json（可调 /api/ai/media/coverage 自动生成拆镜建议）`;
  }
  return null;
}
