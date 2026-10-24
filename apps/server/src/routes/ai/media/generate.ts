import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir, readFile } from "@toonflow/file";
import type { FfprobeData } from "@toonflow/ffmpeg/types";
import { Router } from "express";
import { z } from "zod";
import { audioGenerationSchema, imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import conf from "@/utils/conf";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { looksLikePersonShot } from "@/utils/media/generation";
import { assertAssetsReady } from "@/utils/media/flow";
import { authEnabled } from "@/utils/tenant";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { translateMessage, validationOptions } from "@/lib/i18n";

const imageMime = (path: string) => /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";

/**
 * 从上一镜末帧续拍：抽出真实末帧作为 firstFrame，让下一镜继承空间、光向与人物位置。
 * 只接受工作区内视频，抽帧失败明确报错，不静默降级成纯文本生成。
 */
async function lastFrameReference(cwd: string, source: string) {
  const file = await resolveWorkspacePath(cwd, source);
  if (!/\.(mp4|mov|webm|mkv|m4v)$/i.test(source)) throw Object.assign(new Error("续接素材必须是工作区内的视频文件"), { status: 400 });
  const ffmpeg = await createWorkspaceFfmpeg(cwd);
  const probe = await new Promise<FfprobeData>((resolve, reject) => ffmpeg.ffprobe(file.path, (probeError, data) => probeError ? reject(probeError) : resolve(data)));
  if (!probe.streams.some(stream => stream.codec_type === "video")) throw Object.assign(new Error("续接素材没有视频画面，无法取末帧"), { status: 400 });
  const duration = Number(probe.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error("无法读取续接素材的时长"), { status: 400 });
  const path = `assets/continuity/${createHash("sha256").update(`${source}:${duration}`).digest("hex").slice(0, 16)}-last.png`;
  const target = await resolveWorkspacePath(cwd, path, true);
  await mkdir(dirname(target.path), { recursive: true });
  await new Promise<void>((resolve, reject) => ffmpeg(file.path)
    .seekInput(Math.max(0, duration - 0.08))
    .frames(1)
    .on("error", reject)
    .on("end", () => resolve())
    .save(target.path));
  return { path, mimeType: "image/png" };
}

/** 影调参考只接受工作区内的图片；用途由 prompt 末尾的 STYLEONLY 段限定，不接管身份与场景。 */
async function styleReferenceInput(cwd: string, source: string) {
  await resolveWorkspacePath(cwd, source);
  if (!/\.(png|jpe?g|webp)$/i.test(source)) throw Object.assign(new Error("影调参考必须是工作区内的图片（png/jpg/webp）"), { status: 400 });
  return { path: source, mimeType: imageMime(source) };
}

interface WorldEntry {
  eras?: Record<string, { label?: string; must?: string[]; never?: string[]; garments?: string; spaces?: string; bannedWords?: string[] }>;
}

/**
 * 年代锚点：故事跨年代时，模型默认给出的「泛旧感」会把 2026 年拍成七八十年代。
 * 提示词写明年代后，按 assets/world.json 的清单把该年代必须有与绝不能有的物件注进去。
 */
async function eraAnchor(cwd: string, prompt: string): Promise<string> {
  const file = await resolveWorkspacePath(cwd, "assets/world.json").catch(() => null);
  if (!file) return "";
  let world: WorldEntry;
  try {
    world = JSON.parse(await readFile(file.path, "utf8")) as WorldEntry;
  } catch {
    return "";
  }
  const eras = world.eras ?? {};
  for (const [key, spec] of Object.entries(eras)) {
    if (!prompt.includes(key)) continue;
    const must = (spec.must ?? []).join("、");
    const never = (spec.never ?? []).join("、");
    const extra = spec as { garments?: string; spaces?: string; bannedWords?: string[] };
    return [
      `ERA ${key}：${spec.label ?? ""}`,
      must ? `必须出现该年代的物件：${must}` : "",
      never ? `不得出现：${never}` : "",
      extra.garments ? `服装：${extra.garments}` : "",
      extra.spaces ? `空间：${extra.spaces}` : "",
      extra.bannedWords?.length ? `以下词会把这幕带回旧年代，禁止使用：${extra.bannedWords.join("、")}` : "",
      "旧只属于建筑本身，不扩散到人物穿着、随身工具与日用品。",
    ].filter(Boolean).join("\n");
  }
  return "";
}

interface LookEntry {
  director?: string;
  name?: string;
  note?: string;
}

/**
 * 项目级影调：工作区 `assets/look.json` 里存一位导演，之后每次生成自动带上他的光影与色板约束，
 * 不用逐镜重复选风格。已经带 LOOK 标记的请求不重复叠加。
 */
async function projectLook(cwd: string): Promise<string> {
  // 新建项目还没有 assets 目录，缺省允许上级缺失，否则整个生成接口会被 ENOENT 打成 404。
  const file = await resolveWorkspacePath(cwd, "assets/look.json", true);
  let entry: LookEntry;
  try {
    entry = JSON.parse(await readFile(file.path, "utf8")) as LookEntry;
  } catch {
    return "";
  }
  if (!entry.director) return "";
  const base = join(dirname(conf.path), "skills", "directorPalettes", "palettes");
  try {
    const record = JSON.parse(readFileSync(join(base, entry.director.endsWith(".json") ? entry.director : `${entry.director}.json`), "utf8")) as {
      name?: string;
      palette?: { primary?: { hex: string; name?: string; ratio?: number }[] };
      lighting?: Record<string, string>;
      profile?: Record<string, string>;
    };
    const colors = (record.palette?.primary ?? []).slice(0, 4)
      .map(color => `${color.name ?? ""} ${color.hex}${color.ratio ? ` ${Math.round(color.ratio * 100)}%` : ""}`)
      .join("、");
    const light = record.lighting ?? {};
    return [
      `LOOK: 影调参照 ${record.name ?? entry.name ?? entry.director}${entry.note ? `（${entry.note}）` : ""}`,
      colors ? `主色与占比：${colors}` : "",
      light.key_light ? `主光：${light.key_light}` : "",
      light.highlight_tint ? `高光偏色：${light.highlight_tint}` : "",
      light.shadow_tint ? `阴影偏色：${light.shadow_tint}` : "",
      light.contrast_ratio ? `对比：${light.contrast_ratio}` : "",
      record.profile?.avoid ? `避免：${record.profile.avoid}` : "",
      "色彩由环境、光源与材质承载，按上述比例组织色块面积，不用全局滤镜替代。",
    ].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

interface CastEntry {
  name?: string;
  identity?: string;
  wardrobe?: string;
  references?: string[];
}

/**
 * 角色档案复用：`assets/cast/<角色名>.json` 保存长期身份与定妆参考，
 * 每次生成按名引用即可，不用重新挑脸，也不会因为重述文字而漂移。
 */
async function loadCast(cwd: string, names: string[]) {
  const images: { path: string; mimeType: string }[] = [];
  const notes: string[] = [];
  const wardrobes: string[] = [];
  for (const name of names) {
    const file = await resolveWorkspacePath(cwd, `assets/cast/${name}.json`);
    let entry: CastEntry;
    try {
      entry = JSON.parse(await readFile(file.path, "utf8")) as CastEntry;
    } catch {
      throw Object.assign(new Error(`角色档案 ${name}.json 无法解析`), { status: 400 });
    }
    const references = Array.isArray(entry.references) ? entry.references : [];
    if (!references.length) throw Object.assign(new Error(`角色档案 ${name} 没有 references，无法锁定身份`), { status: 400 });
    for (const reference of references) {
      await resolveWorkspacePath(cwd, reference);
      images.push({ path: reference, mimeType: imageMime(reference) });
    }
    const label = entry.name ?? name;
    notes.push(`${label}：${[entry.identity, entry.wardrobe].filter(Boolean).join("；")}`);
    if (entry.wardrobe?.trim()) wardrobes.push(`${label} 穿${entry.wardrobe.trim()}`);
  }
  return {
    images,
    note: notes.length ? `CAST: ${notes.join("；")}。以上参考图按顺序对应该角色的身份与定妆，脸型、年龄、服装以参考为准。` : "",
    wardrobe: wardrobes.join("；"),
  };
}

/**
 * 服装锁：图生视频在蹲下、起立、走远时会把下装与鞋履「省」掉，一句「保持同一服装」模型无法执行。
 * 有角色档案或提示词里写了 WARDROBE 就逐项列出；否则退回首帧可见服装，并禁止改短、赤脚、丢鞋。
 */
const lowerBodyAction = /蹲|坐|跪|起立|起身|站起|躺|爬|走|跑|跳|迈步|\bsquat\b|\bsit\b|\bkneel\b|\bwalk\b|\brun\b|\bstand up\b/i;

function withWardrobeLock(prompt: string, items: string) {
  if (/WARDROBELOCK\s*[:：]/.test(prompt)) return prompt;
  const body = items.trim()
    ? `WARDROBELOCK 本镜人物的完整着装固定为：${items.trim()}。上衣、下装、鞋履与配饰须逐帧保持，不得省略任何一件、不得替换、改色或改变版型；下装与鞋履进入画面时必须完整可见。`
    : "WARDROBELOCK 本镜人物按首帧里已出现的完整着装逐帧保持：上衣、下装、鞋履与配饰一件不少；不得把长裤改短、不得赤脚、不得让鞋履消失；蹲下、坐下、起身、走远之后仍须完整穿着。";
  return `${prompt}\n\n${body}`;
}

/**
 * 肤质路径：资产与定妆永远是 clean（干净基准，四视图必须能当长期参考）；
 * 其余镜头跟随项目 assets/visual.json 的 skinFinish，请求可临时覆盖。
 */
async function resolveSkinFinish(cwd: string, isAsset: boolean, override?: string) {
  if (isAsset) return "clean" as const;
  if (override === "clean" || override === "natural") return override;
  try {
    const file = await resolveWorkspacePath(cwd, "assets/visual.json");
    const config = JSON.parse(await readFile(file.path, "utf8")) as { skinFinish?: string };
    if (config.skinFinish === "natural" || config.skinFinish === "clean") return config.skinFinish;
  } catch { /* 没有配置文件就按资产口径 */ }
  return "clean" as const;
}

export default Router().post("/", validateFields({
  requestId: z.string().uuid().optional(), directory: z.string().min(1).max(4096), mediaType: z.enum(["image", "video", "audio"]),
}), async (req, res) => {
  const { directory, mediaType, requestId, continueFrom, styleReference, cast, skinFinish, ...raw } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  let request: Record<string, unknown> = { ...raw };
  const hasIdentityReference = (Array.isArray(raw.images) && raw.images.length > 0) || Boolean(raw.firstFrame) || typeof continueFrom === "string";

  // 肤质路径：资产与定妆固定 clean，其余按项目 assets/visual.json，请求可覆盖。
  if (mediaType !== "audio" && !String(request.prompt ?? "").includes("PHOTOGRAPHICBASELINE")) {
    const finish = await resolveSkinFinish(cwd, raw.purpose === "asset", typeof skinFinish === "string" ? skinFinish : undefined);
    request = { ...request, prompt: `SKIN: ${finish}\n\n${request.prompt ?? ""}` };
  }

  // 年代锚点：提示词写明年代才注入，避免把现代故事拍成旧年代。
  if (mediaType !== "audio" && !String(request.prompt ?? "").includes("ERA ")) {
    const era = await eraAnchor(cwd, String(request.prompt ?? ""));
    if (era) request = { ...request, prompt: `${era}\n\n${request.prompt ?? ""}` };
  }

  // 项目影调：整片只设一次，之后每镜自动继承，避免逐镜重复描述风格。
  if (mediaType !== "audio" && !String(request.prompt ?? "").includes("LOOK:")) {
    const look = await projectLook(cwd);
    if (look) request = { ...request, prompt: `${look}\n\n${request.prompt ?? ""}` };
  }

  // 角色档案：先按名解析，把定妆参考和身份说明并进请求。
  let castWardrobe = "";
  if (Array.isArray(cast) && cast.length && mediaType !== "audio") {
    const resolved = await loadCast(cwd, cast.map(String));
    castWardrobe = resolved.wardrobe;
    // 用 request.prompt 而不是 raw.prompt：年代锚点与项目影调已经写进去了，这里重建会把它们丢掉。
    request = {
      ...request,
      images: [...(Array.isArray(raw.images) ? raw.images : []), ...resolved.images],
      prompt: `${resolved.note}\n\n${request.prompt ?? raw.prompt ?? ""}`,
    };
  }

  // 影调参考不能顶替身份参考：先按原始请求判定，人物镜仍然要求真正的角色图。
  if (typeof styleReference === "string" && mediaType === "video" && raw.purpose !== "asset" && !hasIdentityReference && !(Array.isArray(cast) && cast.length) && looksLikePersonShot(String(raw.prompt ?? ""))) {
    throw Object.assign(new Error("人物镜头不能只给影调参考：请另传角色定妆图（images）、角色档案（cast）或上一镜末帧（continueFrom）"), { status: 400 });
  }
  // 影调图永远放在最后，STYLEONLY 的「最后一张」才指得准。
  if (typeof styleReference === "string" && mediaType !== "audio") {
    const style = await styleReferenceInput(cwd, styleReference);
    request = {
      ...request,
      images: [...(Array.isArray(request.images) ? request.images : []), style],
      prompt: `${request.prompt ?? ""}\n\nSTYLEONLY: 最后一张参考图只提供影调、对比、色彩与成像质感，不提供人物身份、服装、场景内容或构图；不得复制其中的人物与地点。`,
    };
  }
  if (mediaType === "video" && typeof continueFrom === "string" && !request.firstFrame) {
    request = { ...request, firstFrame: await lastFrameReference(cwd, continueFrom) };
  }

  // 资产门禁：拆过清单却还没建角色卡就进生成，等于让每一镜重新选角。
  // 要动下半身的镜头额外要求四视图，因为单张定妆撑不住蹲下、走远。
  if (mediaType === "video" && raw.purpose !== "asset" && !/ASSETGATE\s*[:：]/i.test(String(raw.prompt ?? ""))) {
    const gate = await assertAssetsReady(cwd, { needsLowerBody: lowerBodyAction.test(String(raw.prompt ?? "")) });
    if (!gate.ok) throw Object.assign(new Error(gate.message), { status: 400 });
  }

  // 服装锁：人物视频只要有下半身动作，就必须有服装依据，否则图生视频会把裤子和鞋省掉（实测：走远时整条裤子消失）。
  if (mediaType === "video" && raw.purpose !== "asset" && looksLikePersonShot(String(raw.prompt ?? ""))) {
    const declared = /WARDROBE\s*[:：]\s*([^\n]+)/.exec(String(raw.prompt ?? ""))?.[1] ?? "";
    const wardrobe = castWardrobe || declared;
    if (!wardrobe && lowerBodyAction.test(String(raw.prompt ?? ""))) {
      throw Object.assign(new Error("这一镜含人物的下半身动作（蹲下、坐下、起身、走动、奔跑等），但没有服装依据：图生视频会把下装与鞋履省掉，生成后才发现只能整段重做。请二选一——①建 assets/cast/<角色>.json，写清 wardrobe（上衣、下装、鞋履、配饰）并配定妆参考图，用 cast 传入；②在提示词里写一行「WARDROBE: 米白棉麻衬衫、浅蓝直筒牛仔裤、深棕皮质凉鞋」"), { status: 400 });
    }
    request = { ...request, prompt: withWardrobeLock(String(request.prompt ?? ""), wardrobe) };
  }

  const parsed = (mediaType === "image" ? imageGenerationSchema : mediaType === "audio" ? audioGenerationSchema : videoGenerationSchema).safeParse(request, validationOptions());
  if (!parsed.success) {
    res.status(400).json(error("参数错误", parsed.error.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400));
    return;
  }
  if (authEnabled() && mediaType !== "audio") {
    const job = await u.mediaJobs.enqueueMedia(cwd, mediaType, parsed.data, requestId ?? crypto.randomUUID());
    return res.status(202).json(success({ jobId: job.id }));
  }
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  req.once("aborted", close);
  req.socket.once("close", close);
  try {
    const files = await u.mediaGeneration.generateMedia(cwd, mediaType, parsed.data, controller.signal);
    if (!res.destroyed) res.json(success(files));
  } finally {
    res.off("close", close);
    req.off("aborted", close);
    req.socket.off("close", close);
  }
});
