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
import { adContext, adReadiness, isAdSequence } from "./adDirection.ts";
import { needsLipSync } from "./realism.ts";

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
  const sequence = s.get("sequences", sequenceId);
  return createHash("sha256").update(JSON.stringify({ edit, sources, context, ...(sequence && isAdSequence(sequence) ? { advertising: adContext(s, { sequenceId, projectId }) } : {}) })).digest("hex");
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
  const sequence = s.get("sequences", render.sequenceId);
  const pilotReviewRequired = sequence && isAdSequence(sequence) && !adReadiness(s, sequence.id).ready;
  return { ...quality, status: stale ? "stale" : pilotReviewRequired && quality.status === "pass" ? "unverified" : quality.status };
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
    emotion: z.enum(["pass", "fail", "unverified"]).optional(),
    lipSync: z.enum(["pass", "fail", "unverified"]).optional(),
    product: z.enum(["pass", "fail", "unverified"]).optional(),
    composition: z.enum(["pass", "fail", "unverified"]).optional(),
    color: z.enum(["pass", "fail", "unverified"]).optional(),
    editing: z.enum(["pass", "fail", "unverified"]).optional(),
  }),
  note: z.string().trim().min(10).max(4000),
  acknowledgements: z.array(z.object({ id: z.string(), reason: z.string().trim().min(10).max(1000) })).max(300).default([]),
});

type Finding = { id: string; seconds?: number; severity: "block" | "review"; message: string };

const finalInspections = new Map<string, ReturnType<typeof inspectFinalFile>>();

/** 检测最终编码文件；信号阈值只产生复听提示，不自动给内容打分。 */
export async function inspectFinalQuality(s: Scope, id: string) {
  const { render, media } = renderMedia(s, id);
  const fingerprint = sequenceFingerprint(s, render.sequenceId);
  const key = JSON.stringify([s.workspaceId, id, media.id, media.storageKey, render.manifest, fingerprint]);
  const pending = finalInspections.get(key);
  if (pending) return pending;
  const task = inspectFinalFile(s, id, fingerprint);
  finalInspections.set(key, task);
  try { return await task; }
  finally { if (finalInspections.get(key) === task) finalInspections.delete(key); }
}

async function inspectFinalFile(s: Scope, id: string, fingerprint: string) {
  const { render, media } = renderMedia(s, id);
  const inspectionFingerprint = createHash("sha256").update(JSON.stringify([fingerprint, render.manifest?.duration, render.manifest?.clips])).digest("hex");
  const directory = await mkdtemp(join(tmpdir(), "littoFinalQuality"));
  try {
    const file = join(directory, "output.mp4");
    const data = await storage.get(media.storageKey);
    const hash = createHash("sha256").update(data).digest("hex");
    const previous = render.manifest?.quality;
    // ACT: 只复用同一检测版本、实际文件哈希及完整制作指纹；保留既有告警、广告审片和人工验收。
    if (previous?.inspectionVersion === 2 && previous.hash === hash && previous.mediaId === media.id
      && previous.inspectionFingerprint === inspectionFingerprint && render.manifest.sourceFingerprint === fingerprint) {
      const current = s.get("renders", id);
      if (!current || current.mediaId !== media.id || s.get("media", media.id)?.storageKey !== media.storageKey
        || JSON.stringify(current.manifest) !== JSON.stringify(render.manifest)
        || sequenceFingerprint(s, render.sequenceId) !== fingerprint) throw conflict("检测期间方案、素材或验收已改变", "stale");
      return finalQualityView(s, current);
    }
    await writeFile(file, data);
    const probe = await probeFile(file);
    if (!probe?.hasVideo || !probe.duration) throw bad("最终文件不可解码或没有视频");
    const findings: Finding[] = [];
    for (const clip of render.manifest?.clips ?? []) {
      for (const report of sourceReviews(s, clip.mediaId)) {
        if (report.findings.some((finding: any) => finding.severity === "high")) findings.push({ id: `source${report.id}`, seconds: clip.start, severity: "block", message: "源素材仍有严重质检缺陷，请先修复或逐项复核源素材告警" });
      }
    }
    const duration = probe.duration;
    if (Math.abs(duration - Number(render.manifest?.duration ?? duration)) > 0.15) findings.push({ id: "duration", severity: "review", message: "导出时长与剪辑计划相差超过 0.15 秒，请检查截断或声音尾部" });
    const cuts = [...new Set<number>((render.manifest?.clips ?? []).map((clip: any) => Number(clip.start)).filter((t: number) => Number.isFinite(t) && t > 0 && t < duration))];
    if (cuts.length > 200) throw bad("当前接缝检测每次最多覆盖 200 个切点，请分序列检查");
    const seams: { seconds: number; beforeDb: number | null; afterDb: number | null }[] = [];
    const silences: { start: number; end: number }[] = [];
    const windows = cuts.flatMap(time => [[Math.max(0, time - 0.5), time], [time, Math.min(duration, time + 0.5)]]);
    const filters = [`[in]asplit=${windows.length + 1}[silence]${windows.map((_, index) => `[level${index}]`).join("")}`,
      "[silence]silencedetect=noise=-50dB:d=0.1[out]",
      // ACT: 保留旧 -ss/-t 的末端预读包及默认 s16 混音；硬裁半秒或改成浮点混音会改变原告警。
      ...windows.map(([from, to], index) => `[level${index}]atrim=start=${from},aselect=isnan(prev_pts)+lt(prev_pts*TB\\,${to}),aformat=sample_fmts=s16:channel_layouts=mono,astats@level${index}=reset=0,anullsink`)];
    const audioArgs = ["-filter_threads", "1", "-af", filters.join(";")];
    // 一次完整解码同时取得静音区间及全部切点电平；窗口、混单声道方式和告警阈值不变。
    const decode = await runCmd("ffmpeg", ["-hide_banner", "-nostats", "-xerror", "-i", file, ...(probe.hasAudio ? audioArgs : []), "-f", "null", "-"]);
    if (decode.code !== 0) findings.push({ id: "decode", severity: "block", message: "最终文件完整解码失败" });
    if (!probe.hasAudio) findings.push({ id: "noAudio", severity: "review", message: "最终文件没有音轨；有意无声需注明，不能视为听审通过" });
    else {
      // 损坏的视频可能提前终止完整解码；仅此时单独重读音轨，不能把半段统计当全片结果。
      const audio = decode.code === 0 ? decode : await runCmd("ffmpeg", ["-hide_banner", "-nostats", "-xerror", "-i", file, "-vn", ...audioArgs, "-f", "null", "-"]);
      if (audio.code !== 0) throw bad("最终文件声音检测失败");
      let start: number | undefined;
      for (const match of audio.err.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
        if (match[1] === "start") start = Number(match[2]);
        else if (start !== undefined) { silences.push({ start, end: Number(match[2]) }); start = undefined; }
      }
      if (start !== undefined) silences.push({ start, end: duration });
      const levels = new Map<number, number | null>();
      for (const match of audio.err.matchAll(/\[astats@level(\d+) @ [^\]]+\] RMS level dB:\s*(-?[\d.]+|-inf)/g)) {
        levels.set(Number(match[1]), match[2] === "-inf" ? null : Number(match[2]));
      }
      for (const [index, t] of cuts.entries()) {
        if (!levels.has(index * 2) || !levels.has(index * 2 + 1)) throw bad("接点电平不可读");
        const beforeDb = levels.get(index * 2)!;
        const afterDb = levels.get(index * 2 + 1)!;
        seams.push({ seconds: t, beforeDb, afterDb });
        // ACT: 12 dB 差或接点附近 0.25 秒低电平仅筛查突变；有意静默由听审说明，不自动填声。
        if (Math.abs((beforeDb ?? -120) - (afterDb ?? -120)) > 12) findings.push({ id: `level${index}`, seconds: t, severity: "review", message: "切点前后半秒电平差超过 12 dB，请复听音乐进入、环境声与对白" });
        if (silences.some(gap => gap.end - gap.start >= 0.25 && gap.start < t + 0.25 && gap.end > t - 0.25)) findings.push({ id: `gap${index}`, seconds: t, severity: "review", message: "切点附近存在至少 0.25 秒低于 −50 dBFS 的区间，请确认是否有意静默" });
      }
    }
    const latest = s.get("renders", id)!;
    if (!latest || latest.mediaId !== media.id || s.get("media", media.id)?.storageKey !== media.storageKey
      || sequenceFingerprint(s, render.sequenceId) !== fingerprint || JSON.stringify(latest.manifest) !== JSON.stringify(render.manifest)) throw conflict("检测期间方案、素材或验收已改变，请重新检测", "stale");
    const quality = { analysisId: randomUUID(), inspectionVersion: 2, inspectionFingerprint, mediaId: media.id, hash, checkedAt: now(), status: findings.some(item => item.severity === "block") ? "fail" : "unverified", coverage: "decodeAndAudioSignals", duration, hasAudio: probe.hasAudio, findings, seams, silences };
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
  const sequence = s.get("sequences", render.sequenceId)!;
  if (passing && s.list("shots", { sequenceId: render.sequenceId }).some(needsLipSync) && review.checks.lipSync !== "pass") throw bad("成片包含画内对白或演唱，须完整看听并确认逐字口型同步；不能只以声音检查替代口型验收");
  if (passing && isAdSequence(sequence)) {
    if (!["emotion", "product", "composition", "color", "editing"].every(key => review.checks[key as keyof typeof review.checks] === "pass")) throw bad("广告成片须检查情绪表达、产品识别、构图、整片色调与剪辑节奏");
    if (!quality.advertising || quality.advertising.fingerprint !== sequenceFingerprint(s, render.sequenceId)) throw bad("请先 inspectAdFilm 对实际导出文件完成广告表达审片");
    if (!adReadiness(s, render.sequenceId).ready) throw bad("视觉样镜已过期或未定标，请先复核样镜");
  }
  if (passing && quality.findings.some((item: Finding) => item.severity === "block")) throw conflict("最终文件或源素材存在阻断问题", "qc_blocked");
  if (passing && quality.findings.some((item: Finding) => !review.acknowledgements.some(ack => ack.id === item.id))) throw bad("请逐项填写声音、时长或广告表达告警的复核依据；尚未解决则标记返修");
  const status = passing ? "pass" : Object.values(review.checks).includes("fail") ? "fail" : "unverified";
  const next = { ...quality, status, review: { ...review, actor, reviewedAt: now() } };
  s.update("renders", id, { manifest: { ...render.manifest, quality: next } });
  return next;
}
