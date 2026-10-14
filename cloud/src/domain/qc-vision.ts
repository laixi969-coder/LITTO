import { qualityReviewPlan } from "@toonflow/tool-media-generation/runtime";
import { shotFingerprint } from "./realism.ts";
import type { Scope } from "../db.ts";
import { parseJson, runText } from "../llm.ts";
import { OBSERVATION_KINDS } from "./qc.ts";
import { storage } from "../storage.ts";
import { probeFile, runCmd, type Probe } from "../media-tools.ts";
import { mkdtemp, readFile, rm, writeFile } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { referenceCropSchema } from "./schema.ts";
import { sampleVideoFrames } from "./mediaInspection.ts";
import { createHash } from "node:crypto";

type VisionRequest = { workspaceId: string; projectId: string; actor: string; providerId: string; modelId: string; system: string; prompt: string; frames: { data: Buffer; mime: string }[]; label?: string; signal?: AbortSignal };
let workspaceVision: ((input: VisionRequest) => Promise<{ text: string; modelId: string; jobId: string }>) | undefined;
const visionResults = new Map<string, { text: string; modelId: string; jobId: string }>();
const pendingVision = new Map<string, { signal?: AbortSignal; task: Promise<{ text: string; modelId: string; jobId: string }> }>();
export function configureWorkspaceVision(execute: NonNullable<typeof workspaceVision>) { workspaceVision = execute; visionResults.clear(); pendingVision.clear(); }

export async function inspectVision(input: Omit<VisionRequest, "providerId" | "modelId">, model?: { providerId: string; modelId: string }, validate?: (text: string) => unknown) {
  input.signal?.throwIfAborted();
  if (model && !workspaceVision) throw new Error("当前服务未连接工作区视觉模型");
  // ACT: 仅缓存当前进程最近 32 次已校验结果，不缓存图片；未指定模型的动态路由不猜测模型身份。
  const key = model && validate ? createHash("sha256").update(JSON.stringify([
    input.workspaceId, input.projectId, input.actor, model.providerId, model.modelId, input.label, input.system, input.prompt,
    input.frames.map(frame => [frame.mime, createHash("sha256").update(frame.data).digest("hex")]),
  ])).digest("hex") : undefined;
  const cached = key ? visionResults.get(key) : undefined;
  if (cached) { validate!(cached.text); return { ...cached }; }
  const pending = key ? pendingVision.get(key) : undefined;
  // 不合并不同取消信号的请求，避免一个用户停止检查影响另一个请求。
  if (pending && pending.signal === input.signal) { const result = await pending.task; validate?.(result.text); return { ...result }; }
  const executor = workspaceVision;
  const task = (async () => {
    const result = model ? await executor!({ ...input, ...model }) : await runText({ ...input, json: true, label: input.label ?? "ad.inspect" });
    input.signal?.throwIfAborted();
    if (!result) throw new Error("未配置可用的视觉模型，检查未完成");
    validate?.(result.text);
    if (key && executor === workspaceVision) {
      visionResults.set(key, { ...result });
      if (visionResults.size > 32) visionResults.delete(visionResults.keys().next().value!);
    }
    return result;
  })();
  if (key) pendingVision.set(key, { signal: input.signal, task });
  try { return await task; }
  finally { if (key && pendingVision.get(key)?.task === task) pendingVision.delete(key); }
}

// ACT: 普通镜头三帧、重点镜头八帧辅助观察；抽样不证明完整动作或音画同步，有效观察按素材和规格复用。
export async function autoObserve(s: Scope, shotId: string, type: "keyframe" | "take", id: string, actor: string, model?: { providerId: string; modelId: string }) {
  const shot = s.get("shots", shotId);
  const obj = s.get(type === "take" ? "takes" : "keyframes", id);
  if (!shot || obj?.shotId !== shotId || !obj.mediaId) return { used: false, reason: "检查对象不属于当前镜头或没有媒体" };
  const media = s.get("media", obj.mediaId);
  if (!media) return { used: false, reason: "媒体不可读" };
  const frames: { data: Buffer; mime: string }[] = [];
  const timestamps: number[] = [];
  const plan = qualityReviewPlan(shot, type);
  const inspectionKey = model ? createHash("sha256").update(JSON.stringify([plan.interaction.required ? "physicalInteraction2" : "tieredVision2", media.id, media.hash, shotFingerprint(s, shotId, type), model])).digest("hex") : undefined;
  const cached = inspectionKey && s.list("qc_reports", { targetType: type, targetId: id }, "created_at DESC, rowid DESC")
    .find(report => report.evidence?.vision?.inspectionKey === inspectionKey)?.evidence?.vision;
  if (cached?.used) return { ...cached, reused: true };
  const regions: { frameIndex: number; seconds: number | null; region: unknown }[] = [];
  const region = shot.inspectionRegion ? referenceCropSchema.parse(shot.inspectionRegion) : null;
  const cropFilter = region ? region.unit === "normalized"
    ? `crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y}:exact=1`
    : `crop=${region.width}:${region.height}:${region.x}:${region.y}:exact=1` : "";
  const addRegion = async (source: string, directory: string, probe: Probe | null, seek: string[], seconds: number | null, tail = false) => {
    if (!region) return;
    const output = join(directory, `region${regions.length}.png`);
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
      try { const source = join(directory, "source"); await writeFile(source, data); await addRegion(source, directory, await probeFile(source), [], null); }
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
      const sampleCount = plan.sampleCount;
      const sampleTimes = Array.from({ length: sampleCount }, (_, index) => probe.duration! * index / (sampleCount - 1));
      // ACT: 最多补六帧覆盖接触段，连同八张全帧和两张局部不超过十六张；抽帧不替代动作播放。
      const contactTimes = plan.interaction.ranges.flatMap(range => [range.start, (range.start + range.end) / 2, range.end]);
      const candidates = [...new Set(contactTimes)].filter(time => time >= 0 && time <= probe.duration! && !sampleTimes.some(sample => Math.abs(sample - time) < 0.05)).sort((a, b) => a - b);
      const selected = candidates.length <= 6 ? candidates : Array.from({ length: 6 }, (_, index) => candidates[Math.round(index * (candidates.length - 1) / 5)]!);
      sampleTimes.push(...selected);
      sampleTimes.sort((a, b) => a - b);
      frames.push(...await sampleVideoFrames(source, directory, sampleTimes, probe.duration));
      timestamps.push(...sampleTimes.map(seconds => Number(seconds.toFixed(3))));
      await addRegion(source, directory, probe, ["-ss", String(probe.duration / 2)], probe.duration / 2);
      await addRegion(source, directory, probe, ["-sseof", String(-Math.min(1, probe.duration))], probe.duration, true);
    } catch (cause) {
      return { used: false, reason: `视频抽帧不可用：${cause instanceof Error ? cause.message : String(cause)}；请人工播放检查` };
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else return { used: false, reason: `尚不支持自动观察 ${media.mime}` };
  const kinds = OBSERVATION_KINDS.filter(kind => kind !== "capability_mismatch");
  const references = s.list("reference_bindings", { targetType: "shot", targetId: shotId })
    .map(binding => s.get("refs", binding.referenceId)?.mediaId)
    .filter((id): id is string => !!id && /^image\/(png|jpeg|webp)$/.test(s.get("media", id)?.mime ?? "")).slice(0, 4);
  const input = { workspaceId: s.workspaceId, projectId: shot.projectId, actor, frames, imageMediaIds: references,
    json: true, label: "qc.observe", system: `Inspect actual film imagery, not prompt quality. First ${frames.length} images are output images; full frames are in temporal order, with additional native-resolution regions indexed in the prompt; remaining images are references. Report only visible defects using ${kinds.join(", ")}. Explicitly count visible limbs and track them through occlusion; duplicated arms/legs or impossible mirror anatomy are anatomy_failure. Compare wardrobe/product length, seams and shape against references and earlier frames; unexplained changes are wardrobe_drift. Check waxy/plastic skin, erased texture, implausible material highlights, exposure and focus, spatial contact, temporal identity/layout drift, performance. Sampled frames cannot prove biomechanics, lip sync or sound quality. Cite frame/time and visible evidence. Separate confirmed visible defects from uncertainty caused by occlusion, missing references, sampling gaps or perspective. Do not treat plausible motion blur, lighting or foreshortening alone as defects. Return JSON {"observations":[{"kind":"...","note":"...","certainty":"defect or uncertain or clear"}]}; Use defect only for a confirmed visible defect, uncertain for insufficient evidence, and clear for normal behavior or absent defects. Normal motion, correct composition and no anomaly must never use defect. Do not claim a complete pass.`,
    prompt: JSON.stringify({ shot: { action: shot.action, camera: shot.camera, lighting: shot.lighting, realism: shot.realism, performance: shot.performance }, world: s.list("worlds", { projectId: shot.projectId }), looks: s.list("looks", { projectId: shot.projectId }).filter(look => look.scope === "project" || look.scope === "sequence" && look.scopeId === shot.sequenceId || look.scope === "shot" && look.scopeId === shotId),
      objectInteractionReview: plan.interaction.required ? { instruction: plan.interaction.instruction, ranges: plan.interaction.ranges,
        evidence: "Track the actual opening/support location and object through approach, contact, passage/transfer, release and settling. Compare earlier frames and references, including both sides of cuts. Visible entry through a closed surface or unsupported objects are motion_physics; an invented/moved opening or changing object geometry is scene_structure. Cite visible frame/time evidence. If the contact or opening is obscured or falls between samples, do not infer success from the final pose or prompt. Sampled images cannot establish complete physical correctness." } : undefined,
      surfaceReview: "Inspect the whole frame, not just faces: foliage, soil, walls, mountains, sky, water and props. Look for uniform waxy/glossy response across different materials, repeated or melted texture, implausibly equal foreground/background sharpness, HDR halos, flattened atmospheric depth and mismatched subject/environment lighting or contact shadows. Compare to the specified medium and references; intentional stylization, makeup, soft light or clean surfaces alone are not defects. Natural skin texture must be age- and shot-scale-appropriate; do not demand wrinkles, dirt or grain. Cite visible locations and evidence; a matching color palette is not proof of matching photographic texture.",
      timestamps, regions, referenceCount: references.length }),
  };
  for (const id of model ? references : []) {
    const media = s.get("media", id)!;
    input.frames.push({ data: await storage.get(media.storageKey), mime: media.mime });
  }
  if (model && !workspaceVision) return { used: false, reason: "当前服务未连接工作区视觉模型" };
  const observationSchema = z.object({ observations: z.array(z.object({ kind: z.string().min(1).max(200), note: z.string().min(1).max(4000), certainty: z.enum(["defect", "uncertain", "clear"]) })).max(40) });
  let result;
  try {
    result = model ? await inspectVision(input, model, text => observationSchema.parse(parseJson(text))) : await runText(input);
    if (!result) return { used: false, reason: "未配置可用的视觉模型，须人工检查" };
    const parsed = observationSchema.parse(parseJson(result.text));
    return { used: true, inspectionKey, reused: false, model: result.modelId, jobId: result.jobId, coverage: timestamps.length ? "sampledFrames" : "stillImage", timestamps, regions, observations: parsed.observations.filter(item => item.certainty === "defect" && kinds.includes(item.kind)), uncertainties: parsed.observations.filter(item => item.certainty === "uncertain" || item.certainty === "defect" && !kinds.includes(item.kind)) };
  } catch (error) { return { used: false, model: result?.modelId, reason: `视觉检查未完成，不能作为通过依据：${error instanceof Error ? error.message : String(error)}` }; }
}
