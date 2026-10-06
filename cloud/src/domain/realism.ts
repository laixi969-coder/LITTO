import { createHash } from "node:crypto";
import type { Scope } from "../db.ts";
import { shotInput } from "./schema.ts";
import { conflict, notFound } from "../util.ts";
import { statesOf } from "./state.ts";

export const realismChecks = ["surface", "imaging", "world", "motion", "cinematic"] as const;

export function shotFingerprint(s: Scope, shotId: string) {
  const shot = s.get("shots", shotId);
  if (!shot) throw notFound("shot");
  const previous = s.list("shots", { sequenceId: shot.sequenceId }, "ord").filter(item => item.ord < shot.ord).at(-1);
  const previousTake = previous?.approvedTakeId ? s.get("takes", previous.approvedTakeId) : null;
  const data = {
    shot: shotInput.parse({ ...shot, sceneId: shot.sceneId ?? undefined }),
    world: s.list("worlds", { projectId: shot.projectId }),
    looks: s.list("looks", { projectId: shot.projectId }),
    assets: (shot.assetIds ?? []).map((id: string) => s.get("assets", id)),
    bindings: s.list("reference_bindings", { projectId: shot.projectId }).filter(binding => binding.targetType === "shot" ? binding.targetId === shotId : shot.assetIds.includes(binding.targetId)),
    inheritedState: statesOf(s, shotId).start,
    previousTake: previousTake ? { id: previousTake.id, mediaId: previousTake.mediaId, observedStateDelta: previousTake.meta?.observedStateDelta } : null,
  };
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function requireReviewed(s: Scope, type: "keyframe" | "take", item: Record<string, any>) {
  const latest = s.list("qc_reports", { targetType: type, targetId: item.id }, "created_at DESC, rowid DESC")[0];
  const evidence = latest?.evidence;
  const required = realismChecks.filter(key => type === "take" || key !== "motion");
  if (!evidence || evidence.mediaId !== item.mediaId || evidence.fingerprint !== shotFingerprint(s, item.shotId)
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
