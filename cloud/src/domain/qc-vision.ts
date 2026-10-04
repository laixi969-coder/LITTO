import type { Scope } from "../db.ts";
import { parseJson, runText } from "../llm.ts";
import { OBSERVATION_KINDS } from "./qc.ts";
import { storage } from "../storage.ts";
import { probeFile, runCmd } from "../media-tools.ts";
import { mkdtemp, readFile, rm, writeFile } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

type VisionRequest = { workspaceId: string; projectId: string; actor: string; providerId: string; modelId: string; system: string; prompt: string; frames: { data: Buffer; mime: string }[] };
let workspaceVision: ((input: VisionRequest) => Promise<{ text: string; modelId: string; jobId: string }>) | undefined;
export function configureWorkspaceVision(execute: NonNullable<typeof workspaceVision>) { workspaceVision = execute; }

// ACT: 八个时间采样只辅助发现漂移，不声称验证完整动作或音画同步；审批仍须人工播放。
export async function autoObserve(s: Scope, shotId: string, type: "keyframe" | "take", id: string, actor: string, model?: { providerId: string; modelId: string }) {
  const shot = s.get("shots", shotId);
  const obj = s.get(type === "take" ? "takes" : "keyframes", id);
  if (!shot || obj?.shotId !== shotId || !obj.mediaId) return { used: false, reason: "检查对象不属于当前镜头或没有媒体" };
  const media = s.get("media", obj.mediaId);
  if (!media) return { used: false, reason: "媒体不可读" };
  const frames: { data: Buffer; mime: string }[] = [];
  const timestamps: number[] = [];
  if (/^image\/(png|jpeg|webp)$/.test(media.mime)) frames.push({ data: await storage.get(media.storageKey), mime: media.mime });
  else if (/^video\/(mp4|webm)$/.test(media.mime)) {
    const directory = await mkdtemp(join(tmpdir(), "littoQc"));
    try {
      const source = join(directory, "source");
      await writeFile(source, await storage.get(media.storageKey));
      const probe = await probeFile(source);
      if (!probe?.duration || !probe.hasVideo) return { used: false, reason: "无法读取视频时长或缺少 ffprobe，请人工播放检查" };
      for (let index = 0; index < 8; index++) {
        const seconds = probe.duration * index / 8;
        const frame = join(directory, `frame${index}.jpg`);
        const result = await runCmd("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", source, "-frames:v", "1", "-vf", "scale=960:-2", frame]);
        if (result.code !== 0) return { used: false, reason: "视频抽帧失败，请人工播放检查" };
        frames.push({ data: await readFile(frame), mime: "image/jpeg" });
        timestamps.push(Number(seconds.toFixed(3)));
      }
    } catch {
      return { used: false, reason: "视频抽帧不可用，请人工播放检查" };
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else return { used: false, reason: `尚不支持自动观察 ${media.mime}` };
  const kinds = OBSERVATION_KINDS.filter(kind => kind !== "capability_mismatch");
  const references = s.list("reference_bindings", { targetType: "shot", targetId: shotId })
    .map(binding => s.get("refs", binding.referenceId)?.mediaId)
    .filter((id): id is string => !!id && /^image\/(png|jpeg|webp)$/.test(s.get("media", id)?.mime ?? "")).slice(0, 4);
  const input = { workspaceId: s.workspaceId, projectId: shot.projectId, actor, frames, imageMediaIds: references,
    json: true, label: "qc.observe", system: `Inspect actual film imagery, not prompt quality. First ${frames.length} images are outputs in temporal order; remaining images are references. Report only visible defects using ${kinds.join(", ")}. Check waxy/plastic skin, erased texture, implausible material highlights, exposure and focus, spatial contact, temporal identity/layout drift, performance. Sampled frames cannot prove biomechanics, lip sync or sound quality. Cite frame/time and visible evidence. Return JSON {"observations":[{"kind":"...","note":"..."}]}; do not claim a complete pass.`,
    prompt: JSON.stringify({ shot: { action: shot.action, camera: shot.camera, lighting: shot.lighting, realism: shot.realism, performance: shot.performance }, timestamps, referenceCount: references.length }),
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
    return { used: true, model: result.modelId, jobId: result.jobId, coverage: timestamps.length ? "sampledFrames" : "stillImage", timestamps, observations: parsed.observations };
  } catch { return { used: false, model: result.modelId, reason: "视觉模型返回格式无效，不能作为通过依据" }; }
}
