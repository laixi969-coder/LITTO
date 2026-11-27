import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "@toonflow/file";
import type { Scope } from "../db.ts";
import { runCmd } from "../media-tools.ts";
import { storage } from "../storage.ts";
import { getEdit } from "./nle.ts";
import { measureMusicWindow } from "./musicAlignment.ts";

type Interval = { start: number; end: number };
type MusicSpan = Interval & { mediaId: string; sourceStart: number; speed: number };
type Coverage = Interval & { status: "covered" | "missing" | "uncertain" };
type Sample = { sourceMediaId: string; sourceLabel?: string; time: number; sourceTime: number; offsetMs: number | null; status: "aligned" | "offset" | "uncertain" | "missing"; reason?: string };
const seconds = (value: number) => Math.round(value * 1000) / 1000;

function sampleTimes(spans: MusicSpan[]) {
  // 按原曲的计划时长在开头、中间和结尾取样；比较窗不跨换歌、跳剪或留白。
  const total = spans.reduce((sum, span) => sum + span.end - span.start, 0);
  const inset = Math.min(2, total / 12);
  const targets = total < 12 ? [inset, total / 2, total - inset] : [inset, 3 * inset, total / 2 - inset, total / 2 + inset, total - 3 * inset, total - inset];
  const samples: { span: MusicSpan; length: number; time: number; sourceTime: number }[] = [];
  for (const target of targets) {
    let remaining = target;
    for (const span of spans) {
      const duration = span.end - span.start;
      if (remaining > duration) { remaining -= duration; continue; }
      const length = Math.min(2, duration);
      const time = seconds(Math.max(span.start, Math.min(span.end - length, span.start + remaining - length / 2)));
      const sourceTime = seconds(span.sourceStart + (time - span.start) * span.speed);
      if (!samples.some(sample => sample.span.mediaId === span.mediaId && sample.time === time && sample.sourceTime === sourceTime)) {
        samples.push({ span, time, sourceTime, length });
      }
      break;
    }
  }
  return samples;
}

export function musicInspectionPlan(s: Scope, sequenceId: string) {
  const sequence = s.get("sequences", sequenceId)!;
  const shots = new Map(s.list("shots", { sequenceId }).map(shot => [shot.id, shot]));
  const declared = new Set([...shots.values()].filter(shot => shot.musicVideo?.audioMode === "sourceTrack").map(shot => shot.musicVideo.sourceMediaId).filter(Boolean));
  const manual = sequence.kind === "musicFilm" && ![...shots.values()].some(shot => shot.musicVideo?.audioMode);
  if (!declared.size && !manual) return null;
  const edit = getEdit(s, sequenceId, false);
  const tracks = new Map(edit.tracks.map(track => [track.id, track]));
  const spans: MusicSpan[] = [];
  for (const clip of edit.clips) {
    const track = tracks.get(clip.trackId);
    if (!track || track.muted) continue;
    if (track.kind === "video") {
      const plan = shots.get(clip.shotId)?.musicVideo;
      if (plan?.audioMode === "sourceTrack" && plan.sourceMediaId && Number.isFinite(plan.sourceStart)) {
        spans.push({ mediaId: plan.sourceMediaId, start: clip.start, end: clip.start + clip.duration, sourceStart: plan.sourceStart + clip.in, speed: clip.speed });
      }
    } else if (clip.mediaId && clip.gainDb + track.gainDb > -60 && (declared.has(clip.mediaId) || (manual && track.role === "music"))) {
      spans.push({ mediaId: clip.mediaId, start: clip.start, end: clip.start + clip.duration, sourceStart: clip.in, speed: clip.speed });
    }
  }
  const ids = [...new Set(spans.map(span => span.mediaId))];
  // ACT: 旧 MV 没有逐镜原曲绑定时，仅识别时间线上唯一的音乐素材，多个配乐不猜主曲。
  if (!spans.length || (manual && ids.length !== 1)) return null;
  const merged: MusicSpan[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const match = merged.find(item => item.mediaId === span.mediaId && item.speed === span.speed && span.start <= item.end + 0.001
      && Math.abs(item.sourceStart + (span.start - item.start) * item.speed - span.sourceStart) < 0.001);
    if (match) match.end = Math.max(match.end, span.end);
    else merged.push({ ...span });
  }
  const refs = s.list("refs", { projectId: sequence.projectId });
  const samples = sampleTimes(merged);
  const sources = [...new Set(samples.map(sample => sample.span.mediaId))].map(id => {
    const media = s.get("media", id), ref = refs.find(item => item.mediaId === id);
    const storageKey = media?.mime?.startsWith("audio/") && (media.projectId === sequence.projectId || ref) ? media.storageKey as string : null;
    return { id, storageKey, hash: media?.hash as string | undefined, label: ids.length > 1 ? ref?.name || `原曲 ${ids.indexOf(id) + 1}` : undefined };
  });
  const key = createHash("sha256").update(JSON.stringify([2, edit.fps, merged, sources])).digest("hex");
  return { spans: merged, samples, sources, key, fps: edit.fps };
}

type MusicPlan = NonNullable<ReturnType<typeof musicInspectionPlan>>;

/** 复用诊断前也核对文件字节。同一轮测量只读这份快照。 */
export async function prepareInspectionSources(plan: { sources: { id: string; storageKey: string | null; hash?: string }[]; key: string }, directory: string, kind: "music" | "speech") {
  const label = kind === "music" ? "原曲" : "台词参考";
  const files = new Map<string, { path?: string; hash?: string; reason?: string }>();
  const key = createHash("sha256").update(plan.key);
  let available = true;
  for (const source of plan.sources) {
    const data = source.storageKey ? await storage.get(source.storageKey).catch(() => null) : null;
    const hash = data && createHash("sha256").update(data).digest("hex");
    if (!data || (source.hash && hash !== source.hash)) {
      available = false;
      files.set(source.id, { reason: data ? `${label}文件内容已变化，请核对素材版本` : `${label}文件不可读取` });
      continue;
    }
    const path = join(directory, `${kind}${files.size}`);
    await writeFile(path, data);
    key.update(hash!);
    files.set(source.id, { path, hash: hash! });
  }
  return { files, key: available ? key.digest("hex") : null };
}

/** 按解码帧的时间戳和实际采样长度检查覆盖；AAC 包的时长可能横跨没有采样的空档。 */
export async function readAudioIntervals(file: string): Promise<Interval[] | null> {
  const probe = await runCmd("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_frames", "-show_entries",
    "frame=best_effort_timestamp_time,nb_samples,duration_time:stream=sample_rate:format=start_time", "-of", "compact", file]);
  const origin = probe.out.match(/^format\|start_time=(-?[\d.]+)/m);
  const rate = Number(probe.out.match(/^stream\|sample_rate=(\d+)/m)?.[1]);
  if (probe.code !== 0 || !origin || !rate || probe.err.trim()) return null;
  const intervals: Interval[] = [];
  for (const line of probe.out.split("\n")) {
    if (!line.startsWith("frame|")) continue;
    const pts = line.match(/\bbest_effort_timestamp_time=(-?[\d.]+)/);
    const samples = Number(line.match(/\bnb_samples=(\d+)/)?.[1]);
    const duration = Number(line.match(/\bduration_time=([\d.]+)/)?.[1]);
    if (!pts || !samples) return null;
    const start = Number(pts[1]) - Number(origin[1]);
    const end = start + Math.min(samples / rate, duration > 0 ? duration : Infinity);
    const previous = intervals.at(-1);
    if (previous && start + 0.001 < previous.start) return null;
    if (previous && start <= previous.end + 0.001) previous.end = Math.max(previous.end, end);
    else intervals.push({ start, end });
  }
  return intervals;
}

function musicCoverage(spans: MusicSpan[], audio: Interval[] | null) {
  const expected: Interval[] = [];
  for (const span of spans) {
    const last = expected.at(-1);
    if (last && span.start <= last.end + 0.001) last.end = Math.max(last.end, span.end);
    else expected.push({ start: span.start, end: span.end });
  }
  const ranges: Coverage[] = [];
  for (const { start, end } of expected) {
    if (!audio) { ranges.push({ start, end, status: "uncertain" }); continue; }
    let cursor = start;
    for (const part of audio) {
      if (part.end <= cursor || part.start >= end) continue;
      if (part.start > cursor + 0.001) ranges.push({ start: cursor, end: part.start, status: "missing" });
      const from = Math.max(cursor, part.start);
      cursor = Math.min(end, part.end);
      ranges.push({ start: from, end: cursor, status: "covered" });
      if (cursor >= end) break;
    }
    if (end - cursor > 0.001) ranges.push({ start: cursor, end, status: "missing" });
  }
  return ranges.map(range => ({ ...range, start: seconds(range.start), end: seconds(range.end) }));
}

export async function inspectMusicAlignment(plan: MusicPlan, file: string, sources: Awaited<ReturnType<typeof prepareInspectionSources>>, audioRanges: Interval[] | null) {
  const ranges = musicCoverage(plan.spans, audioRanges);
  const windows: Sample[] = [];
  let retryable = false;
  for (const { span, time, sourceTime, length } of plan.samples) {
    const sample: Sample = { sourceMediaId: span.mediaId, sourceLabel: plan.sources.find(source => source.id === span.mediaId)?.label,
      time, sourceTime, status: "uncertain", offsetMs: null };
    windows.push(sample);
    if (ranges.some(range => range.status === "missing" && range.start < time + length - 0.001 && range.end > time + 0.001)) {
      sample.status = "missing"; sample.reason = "采样区间缺少成片音轨"; continue;
    }
    if (span.speed !== 1) { sample.reason = "原曲已变速，无法按原速波形判断"; continue; }
    if (plan.spans.some(other => other !== span && other.start < time + length - 0.001 && other.end > time + 0.001)) {
      sample.reason = "采样区间叠有不同原曲或不同入点，请复听"; continue;
    }
    const source = sources.files.get(span.mediaId)!;
    if (!source.path) { sample.reason = source.reason; continue; }
    try {
      const result = await measureMusicWindow(file, source.path, time, sourceTime, length);
      sample.offsetMs = result.offsetMs;
      sample.reason = result.reason;
      if (result.offsetMs !== null) sample.status = Math.abs(result.offsetMs) >= 1000 / plan.fps ? "offset" : "aligned";
    } catch (error) {
      sample.reason = error instanceof Error ? error.message : "采样窗解码失败";
      retryable = true;
    }
  }
  return { ranges, windows, key: retryable || ranges.some(range => range.status === "uncertain") ? null : sources.key };
}
