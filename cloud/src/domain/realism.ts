import { createHash } from "node:crypto";
import type { Scope } from "../db.ts";
import { shotInput } from "./schema.ts";
import { conflict, notFound, HttpError } from "../util.ts";
import { statesOf, validateStateDelta } from "./state.ts";
import { adContext } from "./adDirection.ts";
import { needsLipSync } from "@toonflow/tool-media-generation/runtime";
import { z } from "zod";
export { needsLipSync } from "@toonflow/tool-media-generation/runtime";
// 云领域使用Zod 3，工具运行时使用Zod 4；边界分别校验，不能混用两版schema实例。
export const audioReviewSchema = z.object({
  speech: z.enum(["pass", "fail", "notApplicable"]), lipSync: z.enum(["pass", "fail", "notApplicable"]),
  referenceMediaId: z.string().min(1).optional(), inspectionKey: z.string().length(64).optional(),
  offsetMs: z.number().finite().min(-5000).max(5000).optional(), note: z.string().trim().min(10).max(4000),
}).strict();

export const realismChecks = ["surface", "imaging", "world", "motion", "cinematic"] as const;

export function shotFingerprint(s: Scope, shotId: string, type: "keyframe" | "take" = "take"): string {
  const shot = s.get("shots", shotId);
  if (!shot) throw notFound("shot");
  try { validateStateDelta(s, shot.projectId, shot.intendedStateDelta); }
  catch (cause) {
    if (!(cause instanceof HttpError) || cause.status !== 400) throw cause;
    throw conflict("镜头计划状态格式或资产引用无效，请通过 updateShot 修正 intendedStateDelta 后再检查或采用；原记录未修改", "invalid_state_delta", { shotId });
  }
  const previous = s.list("shots", { sequenceId: shot.sequenceId }, "ord").filter(item => item.ord < shot.ord).at(-1);
  const previousTake = previous?.approvedTakeId ? s.get("takes", previous.approvedTakeId) : null;
  const { creativeBrief, ...shotData } = shotInput.parse({ ...shot, sceneId: shot.sceneId ?? undefined });
  const advertising = adContext(s, shot);
  const data = {
    ...(advertising ? { advertising } : {}),
    shot: { ...shotData, ...(creativeBrief ? { creativeBrief: type === "keyframe"
      ? { kind: creativeBrief.kind, intent: creativeBrief.intent, visualPayoff: creativeBrief.visualPayoff }
      : creativeBrief } : {}) },
    world: s.list("worlds", { projectId: shot.projectId }),
    looks: s.list("looks", { projectId: shot.projectId }).filter(look => look.scope === "project" || look.scope === "sequence" && look.scopeId === shot.sequenceId || look.scope === "shot" && look.scopeId === shotId),
    assets: (shot.assetIds ?? []).map((id: string) => s.get("assets", id)),
    bindings: s.list("reference_bindings", { projectId: shot.projectId }).filter(binding => binding.targetType === "shot" ? binding.targetId === shotId : shot.assetIds.includes(binding.targetId)),
    inheritedState: statesOf(s, shotId).start,
    previousTake: previousTake ? { id: previousTake.id, mediaId: previousTake.mediaId, observedStateDelta: previousTake.meta?.observedStateDelta } : null,
  };
  if (type === "keyframe") {
    // 静帧编译不使用视频音轨/时间线；前镜采用只按实际继承状态影响静帧，不按 Take ID 使其失效。
    delete data.shot.musicVideo;
    data.previousTake = null;
  }
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function requireReviewed(s: Scope, type: "keyframe" | "take", item: Record<string, any>) {
  const latest = s.list("qc_reports", { targetType: type, targetId: item.id }, "created_at DESC, rowid DESC")[0];
  const evidence = latest?.evidence;
  const shot = s.get("shots", item.shotId);
  if (type === "take" && (needsLipSync(shot ?? {}) || shot?.creativeBrief?.dialogue?.lines?.length)) {
    const audio = evidence?.audioReview;
    if (!audio || evidence.fullPlayback !== true || audio.speech !== "pass" || needsLipSync(shot ?? {}) && audio.lipSync !== "pass") {
      throw conflict("本镜有对白或画内演唱，须完整看听当前视频并记录声音、逐字口型检查；抽帧或生成成功不能证明同步。先对口型或核验实际声音，不重新生成画面绕过", "speech_review_required");
    }
    if (item.meta?.speechSync && (audio.inspectionKey !== item.meta.speechSync.inspectionKey || !item.meta.speechSync.audioMatches)) throw conflict("口型检查不是当前声音与视频版本，请重新检核当前素材", "speech_review_stale");
  }
  const required = realismChecks.filter(key => type === "take" || key !== "motion");
  const matches = evidence && (evidence.fingerprint === shotFingerprint(s, item.shotId, type)
    || type === "keyframe" && evidence.fingerprint === shotFingerprint(s, item.shotId));
  if (!evidence || evidence.mediaId !== item.mediaId || !matches
    || !required.every(key => evidence.reviewed?.includes(key)) || (type === "take" && evidence.fullPlayback !== true)) {
    throw conflict("请先查看实际输出并完成真实感检查；规格改变后须重新检查", "review_required");
  }
  // 连续性问题由 approveTake 的连续性门禁处理，可记录理由强制通过（PRD §20）；这里只拦画面本身的严重缺陷，
  // 否则该强制通过入口永远走不到，且有连续性冲突的镜头连 Hero 都无法采用。
  if (latest.findings.some((finding: { severity: string; kind: string }) => finding.severity === "high" && !finding.kind.startsWith("continuity:"))) {
    throw conflict("真实感检查有严重问题，请修复后重新检查", "qc_blocked");
  }
  return evidence;
}
