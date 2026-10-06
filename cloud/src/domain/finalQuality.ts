import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "@toonflow/file";
import { z } from "zod";
import type { Scope } from "../db.ts";
import { storage } from "../storage.ts";
import { probeFile, runCmd } from "../media-tools.ts";
import { bad, conflict, notFound, now } from "../util.ts";
import { getEdit, resolveClip } from "./nle.ts";

function sourceReviews(s: Scope, mediaId: string | null) {
  if (!mediaId) return [];
  return s.list("takes", { mediaId }).map(take => s.list("qc_reports", { targetType: "take", targetId: take.id }, "created_at DESC, rowid DESC")[0]).filter(Boolean);
}

export function sequenceFingerprint(s: Scope, sequenceId: string) {
  const { history, future, ...edit } = getEdit(s, sequenceId, false);
  const sources = edit.clips.map(clip => {
    const source = resolveClip(s, clip);
    return { source, shot: clip.shotId ? s.get("shots", clip.shotId) : null, reviews: sourceReviews(s, source.mediaId).map(report => report.id) };
  });
  const projectId = s.get("sequences", sequenceId)?.projectId;
  const context = projectId ? ["worlds", "looks", "assets", "reference_bindings"].map(table => s.list(table, { projectId })) : [];
  return createHash("sha256").update(JSON.stringify({ edit, sources, context })).digest("hex");
}

function renderMedia(s: Scope, id: string) {
  const render = s.get("renders", id);
  if (!render) throw notFound("render");
  const media = render.mediaId ? s.get("media", render.mediaId) : null;
  if (render.status !== "SUCCEEDED" || !media || media.projectId !== render.projectId) throw conflict("请先完成成片导出", "no_render");
  return { render, media };
}

export function finalQualityView(s: Scope, render: Record<string, any>) {
  const quality = render.manifest?.quality;
  if (!quality) return { status: "unverified" };
  const stale = !render.manifest?.sourceFingerprint || render.manifest.sourceFingerprint !== sequenceFingerprint(s, render.sequenceId) || quality.mediaId !== render.mediaId;
  return { ...quality, status: stale ? "stale" : quality.status };
}

export const finalReviewSchema = z.object({
  analysisId: z.string().min(1),
  fullPlayback: z.literal(true),
  checks: z.object({
    surface: z.enum(["pass", "fail", "unverified"]),
    motion: z.enum(["pass", "fail", "unverified"]),
    lighting: z.enum(["pass", "fail", "unverified"]),
    continuity: z.enum(["pass", "fail", "unverified"]),
    sound: z.enum(["pass", "fail", "unverified"]),
  }),
  note: z.string().trim().min(10).max(4000),
  acknowledgements: z.array(z.object({ id: z.string(), reason: z.string().trim().min(10).max(1000) })).max(300).default([]),
});

type Finding = { id: string; seconds?: number; severity: "block" | "review"; message: string };

/** 检测最终编码文件；信号阈值只产生复听提示，不自动给内容打分。 */
export async function inspectFinalQuality(s: Scope, id: string) {
  const { render, media } = renderMedia(s, id);
  const directory = await mkdtemp(join(tmpdir(), "littoFinalQuality"));
  try {
    const file = join(directory, "output.mp4");
    const data = await storage.get(media.storageKey);
    await writeFile(file, data);
    const hash = createHash("sha256").update(data).digest("hex");
    const probe = await probeFile(file);
    if (!probe?.hasVideo || !probe.duration) throw bad("最终文件不可解码或没有视频");
    const findings: Finding[] = [];
    for (const clip of render.manifest?.clips ?? []) {
      for (const report of sourceReviews(s, clip.mediaId)) {
        if (report.findings.some((finding: any) => finding.severity === "high")) findings.push({ id: `source${report.id}`, seconds: clip.start, severity: "block", message: "源素材仍有严重质检缺陷，请先修复或逐项复核源素材告警" });
      }
    }
    const decode = await runCmd("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
    if (decode.code !== 0) findings.push({ id: "decode", severity: "block", message: "最终文件完整解码失败" });
    const duration = probe.duration;
    if (Math.abs(duration - Number(render.manifest?.duration ?? duration)) > 0.15) findings.push({ id: "duration", severity: "review", message: "导出时长与剪辑计划相差超过 0.15 秒，请检查截断或声音尾部" });
    const cuts = [...new Set<number>((render.manifest?.clips ?? []).map((clip: any) => Number(clip.start)).filter((t: number) => Number.isFinite(t) && t > 0 && t < duration))];
    if (cuts.length > 200) throw bad("当前接缝检测每次最多覆盖 200 个切点，请分序列检查");
    const seams: { seconds: number; beforeDb: number | null; afterDb: number | null }[] = [];
    const silences: { start: number; end: number }[] = [];
    if (!probe.hasAudio) findings.push({ id: "noAudio", severity: "review", message: "最终文件没有音轨；有意无声需注明，不能视为听审通过" });
    else {
      const audio = await runCmd("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "silencedetect=noise=-50dB:d=0.1", "-f", "null", "-"]);
      if (audio.code !== 0) throw bad("最终文件声音检测失败");
      let start: number | undefined;
      for (const match of audio.err.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
        if (match[1] === "start") start = Number(match[2]);
        else if (start !== undefined) { silences.push({ start, end: Number(match[2]) }); start = undefined; }
      }
      if (start !== undefined) silences.push({ start, end: duration });
      const level = async (from: number, to: number) => {
        const result = await runCmd("ffmpeg", ["-hide_banner", "-nostats", "-ss", String(from), "-i", file, "-t", String(to - from), "-vn", "-af", "aformat=channel_layouts=mono,astats=reset=0", "-f", "null", "-"]);
        if (result.code !== 0) throw bad("接点电平检测失败");
        const value = [...result.err.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)].at(-1)?.[1];
        if (!value) throw bad("接点电平不可读");
        return value === "-inf" ? null : Number(value);
      };
      for (const [index, t] of cuts.entries()) {
        const beforeDb = await level(Math.max(0, t - 0.5), t);
        const afterDb = await level(t, Math.min(duration, t + 0.5));
        seams.push({ seconds: t, beforeDb, afterDb });
        // ACT: 12 dB 差或接点附近 0.25 秒低电平仅筛查突变；有意静默由听审说明，不自动填声。
        if (Math.abs((beforeDb ?? -120) - (afterDb ?? -120)) > 12) findings.push({ id: `level${index}`, seconds: t, severity: "review", message: "切点前后半秒电平差超过 12 dB，请复听音乐进入、环境声与对白" });
        if (silences.some(gap => gap.end - gap.start >= 0.25 && gap.start < t + 0.25 && gap.end > t - 0.25)) findings.push({ id: `gap${index}`, seconds: t, severity: "review", message: "切点附近存在至少 0.25 秒低于 −50 dBFS 的区间，请确认是否有意静默" });
      }
    }
    const latest = s.get("renders", id)!;
    if (latest.mediaId !== media.id) throw conflict("导出文件已变更，请重新检测", "stale");
    const quality = { analysisId: randomUUID(), mediaId: media.id, hash, checkedAt: now(), status: findings.some(item => item.severity === "block") ? "fail" : "unverified", coverage: "decodeAndAudioSignals", duration, hasAudio: probe.hasAudio, findings, seams, silences };
    s.update("renders", id, { manifest: { ...latest.manifest, quality } });
    return finalQualityView(s, s.get("renders", id)!);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function reviewFinalQuality(s: Scope, id: string, input: unknown, actor: string) {
  const review = finalReviewSchema.parse(input);
  const { render } = renderMedia(s, id);
  const quality = finalQualityView(s, render);
  if (!quality.analysisId || quality.analysisId !== review.analysisId || quality.status === "stale") throw conflict("检测记录已过期，请重新导出或检测", "stale");
  const passing = Object.values(review.checks).every(value => value === "pass");
  if (passing && quality.findings.some((item: Finding) => item.severity === "block")) throw conflict("最终文件或源素材存在阻断问题", "qc_blocked");
  if (passing && quality.findings.some((item: Finding) => !review.acknowledgements.some(ack => ack.id === item.id))) throw bad("请逐项填写声音/时长告警的复核依据；尚未解决则标记返修");
  const status = passing ? "pass" : Object.values(review.checks).includes("fail") ? "fail" : "unverified";
  const next = { ...quality, status, review: { ...review, actor, reviewedAt: now() } };
  s.update("renders", id, { manifest: { ...render.manifest, quality: next } });
  return next;
}
