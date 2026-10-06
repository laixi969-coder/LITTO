import type { Scope } from "../db.ts";
import { parseJson, runText } from "../llm.ts";
import { OBSERVATION_KINDS } from "./qc.ts";
import { storage } from "../storage.ts";
import { probeFile, runCmd } from "../media-tools.ts";
import { mkdtemp, readFile, rm, writeFile } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { referenceCropSchema } from "./schema.ts";

type VisionRequest = { workspaceId: string; projectId: string; actor: string; providerId: string; modelId: string; system: string; prompt: string; frames: { data: Buffer; mime: string }[] };
let workspaceVision: ((input: VisionRequest) => Promise<{ text: string; modelId: string; jobId: string }>) | undefined;
export function configureWorkspaceVision(execute: NonNullable<typeof workspaceVision>) { workspaceVision = execute; }

// ACT: 短片约每秒四帧、最多 48 帧辅助发现多肢与漂移；长片为均匀抽样，不证明完整动作或音画同步。
export async function autoObserve(s: Scope, shotId: string, type: "keyframe" | "take", id: string, actor: string, model?: { providerId: string; modelId: string }) {
  const shot = s.get("shots", shotId);
  const obj = s.get(type === "take" ? "takes" : "keyframes", id);
  if (!shot || obj?.shotId !== shotId || !obj.mediaId) return { used: false, reason: "检查对象不属于当前镜头或没有媒体" };
  const media = s.get("media", obj.mediaId);
  if (!media) return { used: false, reason: "媒体不可读" };
  const frames: { data: Buffer; mime: string }[] = [];
  const timestamps: number[] = [];
  const regions: { frameIndex: number; seconds: number | null; region: unknown }[] = [];
  const region = shot.inspectionRegion ? referenceCropSchema.parse(shot.inspectionRegion) : null;
  const cropFilter = region ? region.unit === "normalized"
    ? `crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y}:exact=1`
    : `crop=${region.width}:${region.height}:${region.x}:${region.y}:exact=1` : "";
  const addRegion = async (source: string, directory: string, seek: string[], seconds: number | null, tail = false) => {
    if (!region) return;
    const output = join(directory, `region${regions.length}.png`);
    const probe = await probeFile(source);
    const regionWidth = region.width * (region.unit === "normalized" ? probe?.width ?? 0 : 1);
    const regionHeight = region.height * (region.unit === "normalized" ? probe?.height ?? 0 : 1);
    if (regionWidth < 1 || regionHeight < 1 || regionWidth > 2048 || regionHeight > 2048) throw new Error("请将原尺寸检查区域限定在 1–2048 像素宽高内");
    if (region.unit === "pixels" && (!probe?.width || !probe.height || region.x + region.width > probe.width || region.y + region.height > probe.height)) throw new Error("检查区域超出原图");
    const result = await runCmd("ffmpeg", ["-v", "error", ...seek, "-i", source, "-vf", cropFilter + (tail ? ",reverse" : ""), "-frames:v", "1", output]);
    if (result.code !== 0) throw new Error("原尺寸检查区域提取失败");
    regions.push({ frameIndex: frames.length, seconds, region });
    frames.push({ data: await readFile(output), mime: "image/png" });
  };
  if (/^image\/(png|jpeg|webp)$/.test(media.mime)) {
    const data = await storage.get(media.storageKey);
    frames.push({ data, mime: media.mime });
    if (region) {
      const directory = await mkdtemp(join(tmpdir(), "littoRegion"));
      try { const source = join(directory, "source"); await writeFile(source, data); await addRegion(source, directory, [], null); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
  else if (/^video\/(mp4|webm)$/.test(media.mime)) {
    const directory = await mkdtemp(join(tmpdir(), "littoQc"));
    try {
      const source = join(directory, "source");
      await writeFile(source, await storage.get(media.storageKey));
      const probe = await probeFile(source);
      if (!probe?.duration || !probe.hasVideo) return { used: false, reason: "无法读取视频时长或缺少 ffprobe，请人工播放检查" };
      const sampleCount = Math.min(48, Math.max(8, Math.ceil(probe.duration * 4) + 1));
      for (let index = 0; index < sampleCount; index++) {
        const seconds = probe.duration * index / (sampleCount - 1);
        const frame = join(directory, `frame${index}.jpg`);
        // ACT: 尾部最多解码一秒，缩放后倒序取得真实末帧；末帧时间以片尾边界标记。
        const seek = index === sampleCount - 1 ? ["-sseof", String(-Math.min(1, probe.duration))] : ["-ss", String(seconds)];
        const filter = "scale=w='min(960,iw)':h=-2" + (index === sampleCount - 1 ? ",reverse" : "");
        const result = await runCmd("ffmpeg", ["-v", "error", ...seek, "-i", source, "-frames:v", "1", "-vf", filter, frame]);
        if (result.code !== 0) return { used: false, reason: "视频抽帧失败，请人工播放检查" };
        frames.push({ data: await readFile(frame), mime: "image/jpeg" });
        timestamps.push(Number(seconds.toFixed(3)));
      }
      await addRegion(source, directory, ["-ss", String(probe.duration / 2)], probe.duration / 2);
      await addRegion(source, directory, ["-sseof", String(-Math.min(1, probe.duration))], probe.duration, true);
    } catch (cause) {
      return { used: false, reason: `视频抽帧不可用：${cause instanceof Error ? cause.message : String(cause)}；请人工播放检查` };
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else return { used: false, reason: `尚不支持自动观察 ${media.mime}` };
  const kinds = OBSERVATION_KINDS.filter(kind => kind !== "capability_mismatch");
  const references = s.list("reference_bindings", { targetType: "shot", targetId: shotId })
    .map(binding => s.get("refs", binding.referenceId)?.mediaId)
    .filter((id): id is string => !!id && /^image\/(png|jpeg|webp)$/.test(s.get("media", id)?.mime ?? "")).slice(0, 4);
  const input = { workspaceId: s.workspaceId, projectId: shot.projectId, actor, frames, imageMediaIds: references,
    json: true, label: "qc.observe", system: `Inspect actual film imagery, not prompt quality. First ${frames.length} images are output images; full frames are in temporal order, with additional native-resolution regions indexed in the prompt; remaining images are references. Report only visible defects using ${kinds.join(", ")}. Explicitly count visible limbs and track them through occlusion; duplicated arms/legs or impossible mirror anatomy are anatomy_failure. Compare wardrobe/product length, seams and shape against references and earlier frames; unexplained changes are wardrobe_drift. Check waxy/plastic skin, erased texture, implausible material highlights, exposure and focus, spatial contact, temporal identity/layout drift, performance. Sampled frames cannot prove biomechanics, lip sync or sound quality. Cite frame/time and visible evidence. Return JSON {"observations":[{"kind":"...","note":"..."}]}; do not claim a complete pass.`,
    prompt: JSON.stringify({ shot: { action: shot.action, camera: shot.camera, lighting: shot.lighting, realism: shot.realism, performance: shot.performance }, timestamps, regions, referenceCount: references.length }),
  };
  for (const id of model ? references : []) {
    const media = s.get("media", id)!;
    input.frames.push({ data: await storage.get(media.storageKey), mime: media.mime });
  }
  if (model && !workspaceVision) return { used: false, reason: "当前服务未连接工作区视觉模型" };
  const result = model ? await workspaceVision!({ ...input, ...model }) : await runText(input);
  if (!result) return { used: false, reason: "未配置可用的视觉模型，须人工检查" };
  try {
    const parsed = z.object({ observations: z.array(z.object({ kind: z.string().refine(kind => kinds.includes(kind)), note: z.string().min(1).max(4000) })).max(40) }).parse(parseJson(result.text));
    return { used: true, model: result.modelId, jobId: result.jobId, coverage: timestamps.length ? "sampledFrames" : "stillImage", timestamps, regions, observations: parsed.observations };
  } catch { return { used: false, model: result.modelId, reason: "视觉模型返回格式无效，不能作为通过依据" }; }
}
