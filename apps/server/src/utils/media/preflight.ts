import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir, readdir, stat } from "@toonflow/file";
import conf from "@/utils/conf";
import { getStatus } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";

export type CheckLevel = "block" | "warn" | "info";

export interface CheckItem {
  key: string;
  level: CheckLevel;
  passed: boolean;
  detail: string;
  /** 该检查对应哪条技能规则，便于回溯为什么要有这一项 */
  rule?: string;
}

async function exists(path: string) {
  return stat(path).then(info => info.isFile()).catch(() => false);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * 开拍前检查：把技能里靠人记的规则变成可执行的清单。
 * 技能文档写得再好，不落到「不满足就拦」这一步就只是摆设；
 * 这里只查能用文件与配置验证的事实，不猜创作意图。
 */
export async function preflight(cwd: string, options: { shotSpec?: Record<string, string | undefined>; clips?: string[] } = {}) {
  const items: CheckItem[] = [];
  const skills = join(dirname(conf.path), "skills");

  // 1. 项目影调是否已定：没有 look 就每镜各写各的，全片会散。
  const lookPath = await resolveWorkspacePath(cwd, "assets/look.json").then(item => item.path).catch(() => "");
  const look = lookPath ? await readJson<{ director?: string; note?: string }>(lookPath) : null;
  const paletteDir = join(skills, "directorPalettes", "palettes");
  const paletteFile = look?.director ? join(paletteDir, look.director.endsWith(".json") ? look.director : `${look.director}.json`) : "";
  items.push({
    key: "look",
    level: "warn",
    passed: Boolean(look?.director && paletteFile && await exists(paletteFile)),
    detail: look?.director
      ? (await exists(paletteFile) ? `影调参照 ${look.director}，色卡已找到` : `look.json 指向的色卡 ${look.director} 不存在`)
      : "未设 assets/look.json，全片缺少统一影调，各镜会各写各的",
    rule: "导演色卡库 → 项目级影调",
  });

  // 2. 角色档案：有 draft 标记的参考图会把上一版的缺陷带进新片。
  const castDir = await resolveWorkspacePath(cwd, "assets/cast", true).then(item => item.path).catch(() => "");
  let castFiles: string[] = [];
  try {
    castFiles = castDir ? (await readdir(castDir)).filter(name => name.endsWith(".json")) : [];
  } catch { castFiles = []; }
  let usable = 0;
  const drafts: string[] = [];
  for (const name of castFiles) {
    const record = await readJson<{ quality?: string; references?: string[] }>(join(castDir, name));
    if (!record) continue;
    const references = Array.isArray(record.references) ? record.references : [];
    const missing = references.filter(reference => !reference);
    if (record.quality === "draft") drafts.push(name.replace(/\.json$/, ""));
    else if (references.length && !missing.length) usable += 1;
  }
  items.push({
    key: "cast",
    level: castFiles.length ? (usable ? "info" : "block") : "warn",
    passed: usable > 0,
    detail: castFiles.length
      ? `${castFiles.length} 份角色档案，可用 ${usable} 份${drafts.length ? `，草稿 ${drafts.join("、")}` : ""}`
      : "没有角色档案，人物镜将无法锁定身份",
    rule: "角色档案 cast",
  });

  // 3. 资产先行：没有资产清单就等于没有做前置拆解，直接进分镜必然漂移。
  const planPath = await resolveWorkspacePath(cwd, "assets/assetPlan.json").then(item => item.path).catch(() => "");
  const plan = planPath ? await readJson<{ items?: { kind: string; name: string }[] }>(planPath) : null;
  const planned = plan?.items ?? [];
  const plannedCharacters = planned.filter(item => item.kind === "character").length;
  items.push({
    key: "assetPlan",
    level: planned.length ? "info" : "warn",
    passed: planned.length > 0,
    detail: planned.length
      ? `资产清单 ${planned.length} 项（角色 ${plannedCharacters}），其中角色档案 ${castFiles.length} 份`
      : "没有 assets/assetPlan.json，说明还没从剧本拆资产；先拆再进分镜，否则每镜重新选角搭景",
    rule: "资产先行：角色卡／场景／道具 → 分镜",
  });
  if (planned.length && plannedCharacters > 0 && castFiles.length < plannedCharacters) {
    items.push({
      key: "castCoverage",
      level: "warn",
      passed: false,
      detail: `清单里 ${plannedCharacters} 个角色，只有 ${castFiles.length} 份档案，缺的会在分镜阶段每镜漂移`,
      rule: "角色卡先于分镜",
    });
  }

  // 4. 镜头规格完整度：缺项会让模型自己猜景别与运镜。
  if (options.shotSpec) {
    const required = ["shotSize", "cameraMove", "lighting", "action"];
    const missing = required.filter(key => !String(options.shotSpec?.[key] ?? "").trim());
    items.push({
      key: "shotSpec",
      level: missing.length ? "warn" : "info",
      passed: missing.length === 0,
      detail: missing.length ? `缺少 ${missing.join("、")}，模型会自行补空` : "景别/运镜/光线/动作齐备",
      rule: "镜头规格 shotSpec",
    });
  }

  // 5. 合成前置：片段是否都存在且能在本地处理。
  if (options.clips?.length) {
    const missing: string[] = [];
    for (const clip of options.clips) {
      const resolved = await resolveWorkspacePath(cwd, clip).then(item => item.path).catch(() => "");
      if (!resolved || !await exists(resolved)) missing.push(clip);
    }
    items.push({
      key: "clips",
      level: missing.length ? "block" : "info",
      passed: missing.length === 0,
      detail: missing.length ? `${missing.length} 个片段不存在：${missing.slice(0, 3).join("、")}` : `${options.clips.length} 个片段均可读`,
      rule: "composeFilm 合成",
    });
  }

  // 6. 本地渲染能力：没有 ffmpeg 就连自检都跑不了。
  const { tools } = await getStatus().catch(() => ({ tools: { ffmpeg: { path: "" }, ffprobe: { path: "" } } })) as { tools: { ffmpeg: { path?: string }; ffprobe: { path?: string } } };
  const ffmpegReady = Boolean(tools.ffmpeg.path && tools.ffprobe.path);
  items.push({
    key: "ffmpeg",
    level: "info",
    passed: ffmpegReady,
    detail: ffmpegReady ? "本地 ffmpeg 可用，可做末帧续接、自检与合成" : "缺少 ffmpeg，续接、自检、合成三项都不可用",
    rule: "composeFilm / qc",
  });

  const blockers = items.filter(item => item.level === "block" && !item.passed);
  const warnings = items.filter(item => item.level === "warn" && !item.passed);
  return {
    ready: blockers.length === 0,
    summary: { total: items.length, blocked: blockers.length, warned: warnings.length },
    items,
  };
}
