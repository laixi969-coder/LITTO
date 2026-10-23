import { readdir, readFileSync } from "@toonflow/file";
import { join } from "node:path";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { assetGateMessage, inspectAssets } from "@/utils/media/assetContract";

export type FlowStageKey = "script" | "asset" | "cast" | "scene" | "product" | "music" | "storyboard" | "clips" | "final";

export interface FlowStage {
  key: FlowStageKey;
  label: string;
  done: boolean;
  detail: string;
  /** 该阶段没完成时，下一步该做什么；已完成则不填 */
  next?: string;
  /** 能不能跳到下一阶段；false 表示后面所有生成都会被这道门挡住 */
  blocking: boolean;
}

async function listFiles(directory: string, extension: string) {
  try {
    return (await readdir(directory)).filter(name => name.endsWith(extension));
  } catch { return []; }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch { return null; }
}

/**
 * 制作流程状态。资产部分的判据全部来自 assetContract，与生成门禁是同一份结论——
 * 之前两处各写一套，才会出现「flow 说齐了、四视图其实没做」。
 */
export async function readFlow(cwd: string, workKind?: string) {
  const assets = await inspectAssets(cwd);
  const briefPath = await resolveWorkspacePath(cwd, "assets/brief.json").then(item => item.path).catch(() => "");
  const brief = briefPath ? await readJson<{ kind?: string }>(briefPath) : null;
  const kind = workKind?.trim() || brief?.kind || "drama";

  const plannedCharacters = assets.plan?.characters ?? [];
  const plannedScenes = assets.plan?.scenes ?? [];
  const usableCast = assets.characters.filter(item => item.usable);
  const fourViewMissing = usableCast.filter(item => !item.hasFourView).map(item => item.name);
  const sceneWithImage = assets.scenes.filter(scene => scene.image);

  const shotList = await resolveWorkspacePath(cwd, "assets/shotList.json").then(item => item.path).catch(() => "");
  const shots = shotList ? await readJson<{ shots?: unknown[] }>(shotList) : null;
  const shotCount = Array.isArray(shots?.shots) ? shots!.shots!.length : 0;
  // 分镜与提示词允许落在根目录或 assets 下（Agent 交付时常用 Markdown），按文件名认，不强制固定路径。
  let hasStoryboard = false;
  for (const folder of [cwd, join(cwd, "assets")]) {
    try {
      hasStoryboard = hasStoryboard || (await readdir(folder)).some(name => name.endsWith(".md") && /分镜|提示词|storyboard|prompt/i.test(name));
    } catch { /* 目录不存在就跳过 */ }
  }

  const generatedDir = await resolveWorkspacePath(cwd, "assets/generated", true).then(item => item.path).catch(() => "");
  const clips = generatedDir ? await listFiles(generatedDir, ".mp4") : [];
  let finalFiles: string[] = [];
  try {
    finalFiles = (await readdir(cwd)).filter(name => name.endsWith(".mp4"));
  } catch { /* 根目录读不到就按没有成片算 */ }

  const stages: FlowStage[] = [
    {
      key: "script",
      label: "剧本与设定",
      done: Boolean(assets.plan),
      detail: assets.plan
        ? `已有 ${plannedCharacters.length + plannedScenes.length + assets.plan.props.length} 项资产清单，说明剧本已拆过`
        : "还没有 assets/assetPlan.json",
      next: "先有定稿剧本或故事，再调 POST /api/ai/media/assets 拆资产清单",
      blocking: false,
    },
    {
      key: "asset",
      label: "资产清单",
      done: Boolean(assets.plan),
      detail: assets.plan
        ? `角色 ${plannedCharacters.length}、场景 ${plannedScenes.length}、道具 ${assets.plan.props.length}`
        : "清单为空",
      next: "拆出角色、场景、道具三类，按 角色 → 场景 → 道具 的顺序做",
      blocking: false,
    },
    {
      key: "cast",
      label: "角色卡（含四视图与定妆参考）",
      done: usableCast.length > 0 && fourViewMissing.length === 0,
      detail: fourViewMissing.length
        ? `${usableCast.map(item => item.name).join("、")} 已建档，但 ${fourViewMissing.join("、")} 还没有四视图（只有单张参考）`
        : usableCast.length
          ? `可用角色卡 ${usableCast.length} 份：${usableCast.map(item => item.name).join("、")}${plannedCharacters.length ? `（清单需要 ${plannedCharacters.length} 个）` : ""}`
          : "还没有可用角色卡",
      next: "调 POST /api/ai/media/assetSheet（kind=character）出四视图：正/侧/背三张踩同一水平线 + 头颈特写；导入的图不算四视图",
      blocking: plannedCharacters.length > 0 || usableCast.length > 0,
    },
    {
      key: "scene",
      label: "场景与道具资产",
      done: plannedScenes.length ? sceneWithImage.length >= plannedScenes.length : sceneWithImage.length > 0,
      detail: `assets/scenes 里可用定场图 ${sceneWithImage.length} 张${plannedScenes.length ? `，清单需要 ${plannedScenes.length} 个` : ""}`,
      next: "调 POST /api/ai/media/assetSheet（kind=scene）出无人空镜，交代空间结构、时间与光源",
      blocking: false,
    },
  ];

  // 类型专属资产：广告要产品与品牌参考，MV 要原曲；剧情沿用角色与场景，不额外加门。
  const productDir = await resolveWorkspacePath(cwd, "assets/products", true).then(item => item.path).catch(() => "");
  const products = productDir ? [...await listFiles(productDir, ".json"), ...await listFiles(productDir, ".png"), ...await listFiles(productDir, ".jpg")] : [];
  const audioFiles = [...await listFiles(join(cwd, "assets"), ".mp3"), ...await listFiles(join(cwd, "assets"), ".wav")];
  const extra: FlowStage[] = [];
  if (/^(ad|adfilm|brandFilm|commercial)$/i.test(kind)) {
    extra.push({
      key: "product",
      label: "产品与品牌资产",
      done: products.length > 0,
      detail: `assets/products 里有 ${products.length} 项`,
      next: "用 assetSheet（kind=prop）或 assetImport 登记产品与品牌参考；产品必须在真实参考上生成，不能靠文字描述",
      blocking: false,
    });
  }
  if (/^(music|musicFilm|mv)$/i.test(kind)) {
    extra.push({
      key: "music",
      label: "原曲与演唱规划",
      done: audioFiles.length > 0,
      detail: audioFiles.length ? `assets 下有 ${audioFiles.length} 段音频` : "还没有原曲",
      next: "先 importAudio 把真实原曲放进项目，演唱段与乐句要对齐实际音频，不能凭想象写",
      blocking: true,
    });
  }

  stages.push(
    {
      key: "storyboard",
      label: "分镜与五板块提示词",
      done: shotCount > 0 || hasStoryboard,
      detail: shotCount ? `assets/shotList.json 有 ${shotCount} 个镜头` : hasStoryboard ? "已有分镜或提示词文件" : "还没有分镜与提示词",
      next: "补齐当前镜头必需的参考，按五板块写生成段，提交前调用 preflight 检查 prompt 与 duration",
      blocking: true,
    },
    {
      key: "clips",
      label: "分段视频",
      done: clips.length > 0,
      detail: `已生成 ${clips.length} 段`,
      next: "按生成段提交，段间优先用上一段真实末帧续接",
      blocking: false,
    },
    {
      key: "final",
      label: "成片",
      done: finalFiles.length > 0,
      detail: finalFiles.length ? `成片：${finalFiles.join("、")}` : "还没有成片",
      next: "concat 不重编码拼接后统一 loudnorm 与影调",
      blocking: false,
    },
  );

  // 类型专属阶段插在场景之后、分镜之前：资产没齐就写分镜，分镜里的空间与人物都会自己发明。
  const allStages = [...stages.slice(0, 4), ...extra, ...stages.slice(4)];
  const blocked = allStages.filter(stage => stage.blocking && !stage.done);
  return {
    kind,
    current: allStages.find(stage => !stage.done)?.key ?? "final",
    stages: allStages,
    next: allStages.find(stage => !stage.done)?.next ?? "已完成全流程，可以交付",
    missing: blocked.map(stage => ({ key: stage.key, label: stage.label, detail: stage.detail })),
    // 结构化缺口：机器读这个，不用再从 detail 文案里猜。
    problems: assets.problems,
    ready: assets.ready,
  };
}

/**
 * 资产门禁：与 readFlow 共用 inspectAssets 的结论，不再各写一套判据。
 * 角色问题一律拦；素材没拆清单的项目不受限，保留快速试片。
 */
export async function assertAssetsReady(cwd: string, options: { needsLowerBody?: boolean } = {}) {
  const assets = await inspectAssets(cwd, options);
  if (assets.ready) return { ok: true as const };
  const message = assetGateMessage(assets, options);
  if (!message) return { ok: true as const };
  return { ok: false as const, message };
}
