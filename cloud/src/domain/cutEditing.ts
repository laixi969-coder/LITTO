import { mkdtemp, readFile, writeFile, rm } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "../db.ts";
import { bad, conflict, sha256 } from "../util.ts";
import { storage, saveMedia, mediaView } from "../storage.ts";
import { probeFile, runCmd } from "../media-tools.ts";
import { adjacentClips, applyOps, editView, end, getEdit, resolveClip } from "./nle.ts";
import type { EClip } from "./nle.ts";
import { renderTimeline } from "./nle-render.ts";

function currentPair(s: Scope, sequenceId: string, leftId: string, rightId: string, version: number) {
  const edit = getEdit(s, sequenceId, true);
  if (edit.version !== version) throw conflict("时间线已改变，请刷新后重试", "stale");
  const pair = adjacentClips(edit, leftId, rightId);
  return { edit, ...pair, sourceIds: [resolveClip(s, pair.left).mediaId, resolveClip(s, pair.right).mediaId] };
}

async function sourceFile(s: Scope, clip: EClip, directory: string) {
  const source = resolveClip(s, clip);
  const media = source.mediaId ? s.get("media", source.mediaId) : null;
  if (!media?.mime.startsWith("video/")) throw bad("相邻片段需要真实视频素材");
  const file = join(directory, clip.id);
  await writeFile(file, await storage.get(media.storageKey));
  const probe = await probeFile(file);
  if (!probe?.duration || !probe.hasVideo) throw bad("无法读取片段时长");
  return { file, probe: { ...probe, duration: probe.duration } };
}

export async function suggestCuts(s: Scope, sequenceId: string, leftId: string, rightId: string, version: number) {
  const { edit, left, right, sourceIds } = currentPair(s, sequenceId, leftId, rightId, version);
  if (right.transition.type !== "cut" || Math.abs(end(left) - right.start) > 0.001) throw bad("剪点候选需要相邻连续硬切");
  const directory = await mkdtemp(join(tmpdir(), "littoCuts"));
  try {
    const samples = async (clip: EClip, outgoing: boolean) => {
      const { file, probe } = await sourceFile(s, clip, directory);
      const center = outgoing ? clip.in + clip.duration * clip.speed : clip.in;
      const lower = Math.max(outgoing ? clip.in + 0.15 * clip.speed : 0, center - 0.6 * clip.speed);
      const upper = Math.min(probe.duration - 0.05, outgoing ? center + 0.6 * clip.speed : clip.in + (clip.duration - 0.15) * clip.speed);
      if (upper <= lower) throw bad("素材没有足够区间分析剪点");
      const output = join(directory, `${clip.id}.gray`);
      const result = await runCmd("ffmpeg", ["-y", "-v", "error", "-ss", String(lower), "-i", file, "-t", String(upper - lower), "-vf", "fps=8,scale=64:36,format=gray", "-frames:v", "12", "-f", "rawvideo", output]);
      if (result.code !== 0) throw bad("剪点抽帧失败");
      const bytes = await readFile(output), frameBytes = 64 * 36;
      return Array.from({ length: Math.floor(bytes.length / frameBytes) }, (_, index) => ({
        time: Math.min(upper, lower + index / 8), pixels: bytes.subarray(index * frameBytes, (index + 1) * frameBytes),
      }));
    };
    const a = await samples(left, true), b = await samples(right, false);
    const difference = (x: Uint8Array, y: Uint8Array) => x.reduce((sum, value, index) => sum + Math.abs(value - y[index]), 0) / x.length / 255;
    // ACT: 每侧最多 12 帧，只比较低清外观与局部变化量；不识别人脸、对白或动作语义。
    const candidates = a.flatMap((x, i) => b.map((y, j) => {
      const appearance = difference(x.pixels, y.pixels);
      const motion = Math.abs((i ? difference(x.pixels, a[i - 1].pixels) : 0) - (j ? difference(y.pixels, b[j - 1].pixels) : 0));
      const displacement = Math.abs(x.time - (left.in + left.duration * left.speed)) + Math.abs(y.time - right.in);
      return { sourceOut: Math.round(x.time * edit.fps) / edit.fps, sourceIn: Math.round(y.time * edit.fps) / edit.fps, score: appearance + motion * 0.3 + displacement * 0.05 };
    })).filter(item => item.sourceOut > left.in + 0.1 * left.speed && item.sourceIn < right.in + (right.duration - 0.1) * right.speed).sort((x, y) => x.score - y.score);
    if (JSON.stringify(currentPair(s, sequenceId, leftId, rightId, version).sourceIds) !== JSON.stringify(sourceIds)) throw conflict("源素材已更换，请刷新后重试", "stale");
    return { version, method: "appearanceAndMotion", note: "按画面差异与局部变化量排序，仅作剪点候选；不代表动作、视线或对白语义匹配。请连播听音后采用。", candidates: candidates.slice(0, 5) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function soundBridge(s: Scope, sequenceId: string, input: { leftId: string; rightId: string; expectedVersion: number; mode: "jCut" | "lCut" | "crossfade" | "none"; duration: number }) {
  const { left, right, sourceIds } = currentPair(s, sequenceId, input.leftId, input.rightId, input.expectedVersion);
  const directory = await mkdtemp(join(tmpdir(), "littoSound"));
  try {
    for (const clip of [left, right]) {
      const { probe } = await sourceFile(s, clip, directory);
      if (!probe.hasAudio) throw bad("片段没有原生音轨，请先使用独立声音素材");
      const extension = input.mode === "lCut" && clip.id === left.id ? input.duration * clip.speed : 0;
      if (clip.in + clip.duration * clip.speed + extension > probe.duration + 0.001) throw bad("素材尾部没有足够声音余量，请先缩短画面使用区间");
    }
    if (JSON.stringify(currentPair(s, sequenceId, input.leftId, input.rightId, input.expectedVersion).sourceIds) !== JSON.stringify(sourceIds)) throw conflict("源素材已更换，请刷新后重试", "stale");
    return editView(s, applyOps(s, sequenceId, [{ ...input, type: "bridge_audio" }], input.expectedVersion));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function previewCut(s: Scope, sequenceId: string, leftId: string, rightId: string, version: number) {
  const { left, right, edit, sourceIds } = currentPair(s, sequenceId, leftId, rightId, version);
  const sequence = s.get("sequences", sequenceId)!;
  const source = `seamPreview:${sha256(JSON.stringify([sequenceId, version, leftId, rightId, edit.clips.map(c => resolveClip(s, c).mediaId)]))}`;
  const existing = s.list("media", { projectId: sequence.projectId, source })[0];
  if (existing) return { media: mediaView(existing), version };
  const directory = await mkdtemp(join(tmpdir(), "littoSeam"));
  try {
    const window = { start: Math.max(left.start, right.start - 1.5), end: Math.min(end(right), Math.max(end(left), right.start) + 1.5) };
    const resolved = resolveClip(s, left), media = resolved.mediaId && s.get("media", resolved.mediaId);
    const portrait = media && media.height > media.width;
    const output = await renderTimeline(s, sequenceId, directory, { width: portrait ? 360 : 640, height: portrait ? 640 : 360, normalizeAudio: false }, window);
    if (JSON.stringify(currentPair(s, sequenceId, leftId, rightId, version).sourceIds) !== JSON.stringify(sourceIds)) throw conflict("源素材已更换，请刷新后重试", "stale");
    const saved = await saveMedia(s.workspaceId, sequence.projectId, await readFile(output.file), { source, duration: output.duration });
    return { media: mediaView(saved), version };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
