import { readdir, readFileSync } from "@toonflow/file";
import { join } from "node:path";
import { resolveWorkspacePath } from "@/utils/workspace/files";

/**
 * 资产契约：项目资产到底齐没齐，只在这里判一次。
 *
 * 之前流程报告与生成门禁各写一套判断，判据还不一样（都只看 references 非空），
 * 结果就是「flow 说资产齐了、生成也放行」，但四视图根本没做——换模特那次就是这么漏的。
 * 任何新判据只加在这个文件里，flow 与 generate 都读同一份结论。
 */

export type AssetProblemCode =
  | "no-plan"
  | "missing-cast"
  | "no-fourview"
  | "missing-scene"
  | "no-scene-image"
  | "empty-cast-references";

export interface AssetProblem {
  code: AssetProblemCode;
  subject?: string;
  message: string;
  hint: string;
}

export interface CharacterContract {
  name: string;
  references: string[];
  wardrobe: string;
  identity: string;
  quality: string;
  hasFourView: boolean;
  usable: boolean;
}

export interface ProjectAssets {
  plan: { characters: string[]; scenes: string[]; props: string[] } | null;
  characters: CharacterContract[];
  scenes: { name: string; image: string | null }[];
  props: string[];
  problems: AssetProblem[];
  /** 能不能进视频生成：角色问题一律硬阻断，场景问题只提示 */
  ready: boolean;
  /** 与 flow 一致的下一步建议 */
  next: string;
}

async function list(dir: string, ext: string) {
  try {
    return (await readdir(dir)).filter(name => name.endsWith(ext));
  } catch { return []; }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch { return null; }
}

/** 清单里的名字常带描述（「女主 · 26岁东亚女性」），按首个分隔段互相包含来认。 */
export function sameSubject(castName: string, planName: string) {
  const head = (value: string) => value.split(/[·・|｜\s（(]/).filter(Boolean)[0] ?? value;
  return head(castName) === head(planName) || castName === planName;
}

export async function inspectAssets(cwd: string, options: { needsLowerBody?: boolean } = {}): Promise<ProjectAssets> {
  const planPath = await resolveWorkspacePath(cwd, "assets/assetPlan.json").then(item => item.path).catch(() => "");
  const rawPlan = planPath ? await readJson<{ items?: { kind: string; name: string }[] }>(planPath) : null;
  const items = rawPlan?.items ?? [];
  const plan = items.length
    ? {
        characters: items.filter(item => item.kind === "character").map(item => item.name),
        scenes: items.filter(item => item.kind === "scene").map(item => item.name),
        props: items.filter(item => item.kind === "prop").map(item => item.name),
      }
    : null;

  const castDir = await resolveWorkspacePath(cwd, "assets/cast", true).then(item => item.path).catch(() => "");
  const characters: CharacterContract[] = [];
  for (const file of castDir ? await list(castDir, ".json") : []) {
    const record = await readJson<{ references?: string[]; wardrobe?: string; identity?: string; quality?: string; fourView?: boolean }>(join(castDir, file));
    if (!record) continue;
    const references = Array.isArray(record.references) ? record.references : [];
    characters.push({
      name: file.replace(/\.json$/, ""),
      references,
      wardrobe: record.wardrobe ?? "",
      identity: record.identity ?? "",
      quality: record.quality ?? "ready",
      hasFourView: record.fourView === true,
      usable: references.length > 0 && record.quality !== "draft",
    });
  }

  const sceneDir = await resolveWorkspacePath(cwd, "assets/scenes", true).then(item => item.path).catch(() => "");
  const sceneFiles = sceneDir ? [...await list(sceneDir, ".png"), ...await list(sceneDir, ".jpg")] : [];
  const sceneJson = sceneDir ? await list(sceneDir, ".json") : [];
  const scenes: { name: string; image: string | null }[] = [];
  for (const file of sceneJson) {
    const record = await readJson<{ name?: string; references?: string[] }>(join(sceneDir, file));
    const name = record?.name ?? file.replace(/\.json$/, "");
    scenes.push({ name, image: (record?.references ?? []).find(path => /\.(png|jpe?g)$/i.test(path)) ?? null });
  }
  // 只有图片没有 json 的场景也要算进来，否则手工放进来的定场图会被当成不存在。
  for (const file of sceneFiles) {
    const name = file.replace(/\.(png|jpe?g)$/i, "");
    if (!scenes.some(scene => sameSubject(scene.name, name))) scenes.push({ name, image: `assets/scenes/${file}` });
  }

  const propDir = await resolveWorkspacePath(cwd, "assets/props", true).then(item => item.path).catch(() => "");
  const props = propDir ? (await list(propDir, ".json")).map(file => file.replace(/\.json$/, "")) : [];

  const problems: AssetProblem[] = [];
  if (!plan) {
    problems.push({
      code: "no-plan",
      message: "还没有 assets/assetPlan.json，剧本没拆成资产清单",
      hint: "调 POST /api/ai/media/assets 从剧本拆出角色、场景、道具",
    });
  }
  for (const name of plan?.characters ?? []) {
    const contract = characters.find(item => sameSubject(item.name, name));
    if (!contract) {
      problems.push({
        code: "missing-cast",
        subject: name,
        message: `清单里的角色「${name}」没有角色卡`,
        hint: "用 assetSheet（kind=character）出四视图，或用 assetImport 导入已有角色图",
      });
      continue;
    }
    if (!contract.usable) {
      problems.push({
        code: "empty-cast-references",
        subject: name,
        message: `角色卡「${name}」没有可用参考图`,
        hint: "补 references（定妆图或四视图），否则每镜都会重新选角",
      });
    }
  }
  for (const contract of characters) {
    if (!contract.usable) continue;
    if (!contract.hasFourView) {
      problems.push({
        code: "no-fourview",
        subject: contract.name,
        message: `角色卡「${contract.name}」只有单张参考，四视图没做`,
        hint: "用 assetSheet（kind=character，reference 指向现有定妆图）出正/侧/背三张全身 + 头颈特写；导入的图不算四视图",
      });
    }
  }
  for (const name of plan?.scenes ?? []) {
    if (!scenes.some(scene => sameSubject(scene.name, name))) {
      problems.push({
        code: "missing-scene",
        subject: name,
        message: `清单里的场景「${name}」没有定场图`,
        hint: "用 assetSheet（kind=scene）出无人空镜，交代空间结构、时间与光源",
      });
    }
  }
  for (const scene of scenes) {
    if (!scene.image) {
      problems.push({
        code: "no-scene-image",
        subject: scene.name,
        message: `场景「${scene.name}」登记了但没有图片`,
        hint: "补一张定场图，或删掉这条空登记",
      });
    }
  }

  // 硬阻断只看「角色有没有可用参考、要不要四视图」。
  // 清单（no-plan）、场景（missing-scene）不硬拦：清单是组织工具，场景图还能靠提示词撑；
  // 一刀切会把没拆清单的老项目与已完成资产的手工项目全部挡住，人就会绕开流程。
  const blocking = problems.filter(problem => {
    if (problem.code === "no-plan" || problem.code === "missing-scene" || problem.code === "no-scene-image") return false;
    if (problem.code === "no-fourview") return options.needsLowerBody === true;
    return true;
  });
  return {
    plan,
    characters,
    scenes,
    props,
    problems,
    ready: blocking.length === 0,
    next: problems[0] ? `${problems[0].message}：${problems[0].hint}` : "资产已齐，可以进分镜与生成",
  };
}

/** 门禁文案：优先说硬问题，没有硬问题时说四视图，并给出可执行的补法。 */
export function assetGateMessage(assets: ProjectAssets, options: { needsLowerBody?: boolean } = {}) {
  const blocking = assets.problems.filter(problem => {
    if (problem.code === "no-plan" || problem.code === "missing-scene" || problem.code === "no-scene-image") return false;
    if (problem.code === "no-fourview") return options.needsLowerBody === true;
    return true;
  });
  const problem = blocking[0];
  if (!problem) return "";
  const reason = problem.code === "no-fourview"
    ? "这一镜有人物的下半身动作，单张定妆撑不住：蹲下、起身、走远时模型会自己补下半身，裤子与鞋会丢"
    : "这一步没过就进生成，每一镜都会重新选角，肤色与服装必然漂";
  return `${problem.message}。${problem.hint}。${reason}。要强推就先写「ASSETGATE: 理由」。`;
}
