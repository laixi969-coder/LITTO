import { createHash } from "node:crypto";
import type { Scope } from "../db.ts";
import { shotInput } from "./schema.ts";
import { conflict, notFound } from "../util.ts";

export const realismChecks = ["surface", "imaging", "world", "motion", "cinematic"] as const;

export function shotFingerprint(s: Scope, shotId: string) {
  const shot = s.get("shots", shotId);
  if (!shot) throw notFound("shot");
  const data = {
    shot: shotInput.parse({ ...shot, sceneId: shot.sceneId ?? undefined }),
    world: s.list("worlds", { projectId: shot.projectId }),
    looks: s.list("looks", { projectId: shot.projectId }),
    assets: (shot.assetIds ?? []).map((id: string) => s.get("assets", id)),
    bindings: s.list("reference_bindings", { projectId: shot.projectId }).filter(binding => binding.targetType === "shot" ? binding.targetId === shotId : shot.assetIds.includes(binding.targetId)),
  };
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function requireReviewed(s: Scope, type: "keyframe" | "take", item: Record<string, any>) {
  const latest = s.list("qc_reports", { targetType: type, targetId: item.id }, "created_at DESC, rowid DESC")[0];
  const evidence = latest?.evidence;
  const required = realismChecks.filter(key => type === "take" || key !== "motion");
  if (!evidence || evidence.mediaId !== item.mediaId || evidence.fingerprint !== shotFingerprint(s, item.shotId)
    || !required.every(key => evidence.reviewed?.includes(key))) {
    throw conflict("请先查看实际输出并完成真实感检查；规格改变后须重新检查", "review_required");
  }
  if (latest.findings.some((finding: { severity: string }) => finding.severity === "high")) {
    throw conflict("真实感检查有严重问题，请修复后重新检查", "qc_blocked");
  }
  return evidence;
}
