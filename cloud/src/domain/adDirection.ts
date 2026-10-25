import { z } from "zod";
import type { Scope } from "../db.ts";
import { bad, conflict, notFound, sha256 } from "../util.ts";
import { realismChecks, shotFingerprint } from "./realism.ts";
import { advertisingSchema } from "./schema.ts";
import { mediaAspectIssue } from "./qualityInspection.ts";

const text = z.string().trim().min(1).max(2000);
export const sequenceKindSchema = z.enum(["story", "serial", "adfilm", "brandFilm", "musicFilm"]);
export const adDirectionSchema = z.object({
  concept: text, audienceFeeling: text, productRole: text, brandRecall: text,
  referenceIds: z.array(z.string().min(1)).max(12).default([]),
  productAssetIds: z.array(z.string().min(1)).min(1).max(20),
  emotionalArc: z.array(z.object({ id: text, emotion: text, visibleAction: text, productBeat: text, sound: text }).strict()).min(1).max(20),
  visualRules: z.object({ palette: text, light: text, materials: text, composition: text, motion: text }).strict(),
  motifs: z.array(text).min(1).max(12), avoid: z.array(text).max(20),
  editRhythm: text, soundDesign: text,
  pilots: z.array(z.object({ key: z.string().trim().min(1).max(100), purpose: text }).strict()).min(1).max(4),
}).strict().superRefine((value, ctx) => {
  for (const [path, ids] of [["emotionalArc", value.emotionalArc.map(item => item.id)], ["pilots", value.pilots.map(item => item.key)], ["productAssetIds", value.productAssetIds]] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [path], message: "标识不能重复" });
  }
});

export const isAdSequence = (sequence: Record<string, any>) => ["adfilm", "brandFilm"].includes(sequence.kind) || !!sequence.adDirection;

export function updateSequenceData(s: Scope, sequenceId: string, patch: Record<string, unknown>) {
  const sequence = s.get("sequences", sequenceId);
  if (!sequence) throw notFound("sequence");
  const { id, workspaceId, projectId, name, ord, script, createdAt, updatedAt, deletedAt, ...data } = sequence;
  return s.update("sequences", sequenceId, { data: { ...data, ...patch } });
}

export function saveAdDirection(s: Scope, projectId: string, sequenceId: string, input: unknown, confirmed = false) {
  const sequence = s.get("sequences", sequenceId);
  if (!sequence || sequence.projectId !== projectId) throw notFound("project sequence");
  const direction = adDirectionSchema.parse(input);
  for (const id of direction.referenceIds) {
    const reference = s.get("refs", id);
    if (!reference || reference.projectId !== projectId || sequence.referenceStudies?.[id]?.mediaId !== reference.mediaId) throw bad("选用的参考须先 analyzeReference，不能把未看过的参考当成已分析");
  }
  for (const id of direction.productAssetIds) {
    const asset = s.get("assets", id);
    if (!asset || asset.projectId !== projectId || !["Product", "Prop", "Wardrobe"].includes(asset.type)) throw bad("产品须为当前项目的 Product、Prop 或 Wardrobe 资产");
  }
  if (JSON.stringify(sequence.adDirection) === JSON.stringify(direction)) return sequence;
  if (!confirmed && s.list("shots", { sequenceId }).some(shot => shot.heroKeyframeId || shot.approvedTakeId)) throw conflict("已有采用镜头，请通过 requestProductionDecision(adDirection) 确认整片方案变更", "needs_confirmation");
  return updateSequenceData(s, sequenceId, { adDirection: direction });
}

/** 仅生产规格进入指纹；审片记录不进入自身指纹，避免检查一写入就失效。 */
export function adContext(s: Scope, shot: Record<string, any>) {
  const sequence = s.get("sequences", shot.sequenceId);
  if (!sequence || !isAdSequence(sequence)) return null;
  const shots = s.list("shots", { sequenceId: shot.sequenceId }, "ord");
  return {
    kind: sequence.kind, direction: sequence.adDirection ?? null,
    products: (sequence.adDirection?.productAssetIds ?? []).map((id: string) => s.get("assets", id)),
    studies: (sequence.adDirection?.referenceIds ?? []).map((id: string) => {
      const study = sequence.referenceStudies?.[id];
      return { referenceId: id, mediaId: s.get("refs", id)?.mediaId, hash: study?.hash, borrow: study?.borrow, avoidCopying: study?.avoidCopying };
    }),
    pilots: shot.advertising?.pilotKey ? [] : shots.filter(item => item.advertising?.pilotKey).map(item => {
      const frame = item.heroKeyframeId && s.get("keyframes", item.heroKeyframeId);
      return { key: item.advertising.pilotKey, shotId: item.id, keyframeId: frame?.id, mediaId: frame?.mediaId, fingerprint: shotFingerprint(s, item.id, "keyframe") };
    }),
  };
}

export function adPilotAssessment(shot: Record<string, any>, productAssetIds: string[], review: Record<string, any>) {
  const visibleIds: string[] = shot.visibleAssetIds ?? shot.assetIds ?? [];
  const notApplicableChecks = productAssetIds.some(id => visibleIds.includes(id)) ? [] : ["product"];
  // ACT: 静帧只验当前画面，剪辑留到成片；旧报告逐项重算，不因历史总评要求重新付费检查。
  const deferredChecks = ["editing"];
  const requiredChecks = ["emotion", "product", "composition", "color"].filter(key => !notApplicableChecks.includes(key));
  // ACT: 旧审片未分级的审美修订默认可选；产品识别仍保守拦截，明确 block 与真实感严重缺陷继续生效。
  const advisoryChecks = requiredChecks.filter(key => review[key]?.verdict === "revise"
    && (review[key]?.severity === "review" || review[key]?.severity === undefined && key !== "product"));
  const blockingChecks = requiredChecks.filter(key => review[key]?.verdict !== "pass" && !advisoryChecks.includes(key));
  return { verdict: blockingChecks.length ? "revise" : "pass", nextAction: blockingChecks.length ? "resolveBlockers" : "continueProduction", blockingChecks, advisoryChecks, deferredChecks, notApplicableChecks };
}

export function adReadiness(s: Scope, sequenceId: string) {
  const sequence = s.get("sequences", sequenceId);
  if (!sequence) throw notFound("sequence");
  const parsed = adDirectionSchema.safeParse(sequence.adDirection);
  if (!isAdSequence(sequence)) return { required: false, ready: true, pilots: [] };
  if (!parsed.success) return { required: true, ready: false, pilots: [], reason: "请先保存整片 adDirection" };
  const shots = s.list("shots", { sequenceId }, "ord");
  const pilots = parsed.data.pilots.map(pilot => {
    const matches = shots.filter(shot => shot.advertising?.pilotKey === pilot.key);
    const shot = matches.length === 1 ? matches[0] : null;
    const frame = shot?.heroKeyframeId && s.get("keyframes", shot.heroKeyframeId);
    const review = shot && sequence.adPilotReviews?.[shot.id];
    const qc = frame && s.list("qc_reports", { targetType: "keyframe", targetId: frame.id }, "created_at DESC, rowid DESC")[0];
    const fingerprint = shot && shotFingerprint(s, shot.id, "keyframe");
    const assessment = shot && review ? adPilotAssessment(shot, parsed.data.productAssetIds, review) : null;
    const aspectIssue = frame && mediaAspectIssue(s, frame);
    const ready = !!(frame && frame.shotId === shot.id && review?.keyframeId === frame.id && review.mediaId === frame.mediaId
      && !aspectIssue
      && !adShotIssues(s, shot, false).length
      && review.fingerprint === fingerprint && assessment?.verdict === "pass" && qc?.evidence?.fingerprint === fingerprint
      && qc.evidence.mediaId === frame.mediaId
      && realismChecks.filter(key => key !== "motion").every(key => qc.evidence.reviewed?.includes(key))
      && !qc.findings.some((finding: any) => finding.severity === "high"));
    let reason = "须完成当前主帧的真实感检查；已有采用记录无需重复确认";
    if (ready) reason = "静帧适用项已检查并采用；剪辑与动态留到视频阶段验证";
    else if (matches.length !== 1) reason = "每项样镜须对应唯一镜头";
    else if (!frame) reason = "请先采用已检查的样镜主帧";
    else if (aspectIssue) reason = aspectIssue;
    else if (review?.keyframeId !== frame.id || review?.mediaId !== frame.mediaId) reason = "当前采用的主帧与样镜检查对象不一致，请核对已有候选与采用记录，不要重生成";
    else if (review?.fingerprint !== fingerprint) reason = "样镜规格已变化，须复核当前画面；不要为静帧补写动态结论或反复改规格";
    else if (assessment?.blockingChecks.length) reason = `静帧待处理项：${assessment.blockingChecks.join("、")}；不适用项与动态检查不阻塞`;
    return { ...pilot, shotId: shot?.id, keyframeId: frame?.id, mediaId: frame?.mediaId, ready, assessment,
      reason };
  });
  return { required: true, ready: pilots.every(pilot => pilot.ready), pilots };
}

export function adShotIssues(s: Scope, shot: Record<string, any>, checkPilots = true) {
  const sequence = s.get("sequences", shot.sequenceId);
  if (!sequence || !isAdSequence(sequence)) return [];
  const parsed = adDirectionSchema.safeParse(sequence.adDirection);
  if (!parsed.success) return ["广告序列缺少有效的整片 adDirection，请先完成导演方案"];
  const advertising = advertisingSchema.safeParse(shot.advertising);
  if (!advertising.success) return ["广告镜头须填写 advertising 的 beatId、productRead、cutToNext、sound；无产品入镜可明确说明情绪作用"];
  const issues: string[] = [];
  for (const id of parsed.data.referenceIds) {
    const reference = s.get("refs", id);
    if (!reference || reference.projectId !== shot.projectId || sequence.referenceStudies?.[id]?.mediaId !== reference.mediaId) issues.push("整片方案引用的参考已失效，请重新分析并更新方案");
  }
  for (const id of parsed.data.productAssetIds) if (s.get("assets", id)?.projectId !== shot.projectId) issues.push("整片产品资产已失效");
  if (!parsed.data.emotionalArc.some(beat => beat.id === advertising.data.beatId)) issues.push("镜头情绪节拍不存在于当前整片方案");
  if (!shot.creativeBrief) issues.push("广告镜头须有 creativeBrief 的可见创作目标");
  for (const id of parsed.data.productAssetIds.filter(id => shot.assetIds?.includes(id))) {
    const asset = s.get("assets", id);
    const media = asset?.attributes?.authoritativeReference && s.get("media", asset.attributes.authoritativeReference);
    if (!media || media.projectId !== shot.projectId || !media.mime.startsWith("image/")) issues.push("产品入镜前须为产品资产采用当前项目的真实权威参考图");
  }
  if (advertising.data.pilotKey) {
    if (!parsed.data.pilots.some(pilot => pilot.key === advertising.data.pilotKey)) issues.push("样镜标识不存在于整片方案");
    if (s.list("shots", { sequenceId: sequence.id }).filter(item => item.advertising?.pilotKey === advertising.data.pilotKey).length !== 1) issues.push("同一样镜标识只能对应一个镜头");
  } else if (checkPilots && !adReadiness(s, sequence.id).ready) issues.push("视觉样镜尚未定标，请先生成指定样镜、inspectAdPilot 检查并采用，再生成其余镜头");
  return issues;
}

export function adDirectionFingerprint(s: Scope, sequenceId: string) {
  const sequence = s.get("sequences", sequenceId);
  return sha256(JSON.stringify({ kind: sequence?.kind, direction: sequence?.adDirection }));
}
