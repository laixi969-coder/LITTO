import { z } from "zod";
import { tx, type Scope } from "../db.ts";
import { assetInput, bindingInput, shotInput, worldSchema, lookSchema } from "./schema.ts";
import { createAsset } from "./assets.ts";
import { bindReference, createShot, updateShot, shotPartial } from "./shots.ts";
import { bad, conflict, notFound, sha256 } from "../util.ts";
import { finalQualityView } from "./finalQuality.ts";
import { mediaView, saveMedia, sniff } from "../storage.ts";
import { runQc } from "./qc.ts";
import { promoteHero } from "./lifecycle.ts";
import { selectWorkingTake } from "./nle.ts";
import { realismChecks } from "./realism.ts";

/** 拆格或用户上传的干净单帧进入候选，采用仍复用聊天中的真实检查。 */
export async function importWorkspaceKeyframe(s: Scope, projectId: string, shotId: string, bytes: Buffer, path: string) {
  const shot = s.get("shots", shotId);
  if (!shot || shot.projectId !== projectId) throw notFound("project shot");
  if (!sniff(bytes)?.mime.startsWith("image/")) throw bad("关键帧须为可识别的图片");
  const hash = sha256(bytes);
  let media = s.list("media", { projectId, hash })[0];
  if (!media) media = await saveMedia(s.workspaceId, projectId, bytes, { source: "storyboard" });
  // 存储期间镜头可能被删除；再次核对，不能把候选挂到失效镜头。
  if (s.get("shots", shotId)?.projectId !== projectId) throw notFound("project shot");
  const existing = s.list("keyframes", { projectId, shotId, mediaId: media.id })[0];
  if (existing) return existing;
  const frame = s.insert("keyframes", { project_id: projectId, shot_id: shotId, media_id: media.id, status: "variant", meta: { source: "storyboard", workspacePath: path, hash } });
  if (s.get("shots", shotId)?.status === "planned") s.update("shots", shotId, { status: "keyframing" });
  return frame;
}

/** 草稿可直接保存；采用与变更确认通过聊天决定卡片写入，和制作面板复用领域规则。 */
export function workspaceProduction(s: Scope, projectId: string, operation: string, data: Record<string, unknown>, actor?: string) {
  if (!s.get("projects", projectId)) throw notFound("project");
  if (operation === "agentReview") {
    if (!actor) throw bad("代理审阅须有已认证的操作人");
    const input = z.strictObject({
      targetType: z.enum(["keyframe", "take"]), targetId: z.string().min(1),
      authorization: z.string().trim().min(8).max(2000), note: z.string().trim().min(10).max(8000),
      frameTimes: z.array(z.number().finite().nonnegative()).max(600).default([]),
      observations: z.array(z.strictObject({ kind: z.string(), note: z.string().min(1) })).max(40).default([]),
    }).parse(data);
    const item = s.get(input.targetType === "keyframe" ? "keyframes" : "takes", input.targetId);
    const shot = item && s.get("shots", item.shotId);
    const media = item && s.get("media", item.mediaId);
    if (!item || !shot || !media || [item, shot, media].some(row => row.projectId !== projectId)) throw notFound("project output");
    if (!media.mime.startsWith(input.targetType === "take" ? "video/" : "image/")) throw bad("审阅目标的媒体类型不符");
    if (input.targetType === "take" && (!media.duration || input.frameTimes.length < 2
      || input.frameTimes.some((time, index) => time >= media.duration || index > 0 && time <= input.frameTimes[index - 1]!))) {
      throw bad("视频工作版须记录至少两个递增且位于素材时长内的实际抽帧时间");
    }
    return tx(() => {
      const review = runQc(s, shot.id, { type: input.targetType, id: item.id }, input.observations, {
        actor: `agent:${actor}`, note: input.note,
        reviewed: input.targetType === "keyframe" ? realismChecks.filter(key => key !== "motion") : [],
        vision: { source: "delegatedAgent", authorization: input.authorization, frameTimes: input.frameTimes, audioReview: "notVerified", status: "workingVersion" },
      });
      if (review.report.findings.some(finding => finding.severity === "high")) return { selected: false, review, reason: "存在严重问题，已保留检查记录，未采用" };
      if (input.targetType === "keyframe") promoteHero(s, item.id, `agent:${actor}`);
      else selectWorkingTake(s, item.id);

      return { selected: true, status: "workingVersion", finalReviewRequired: true, review, answer: "代理检查已记录并选入工作版；未声明用户已完整播放或最终声画验收通过" };
    });
  }
  const shots = s.list("shots", { projectId }, "sequence_id, ord");
  if (operation === "read") return {
    decisions: { location: "chat", keyframes: "requestKeyframeApproval({keyframeIds:[...]})：可批量确认并保存主关键帧，不在 updateShot 或 compile 中传 heroKeyframeId", production: "requestProductionDecision：资产、定妆、视频、配音、剪辑和最终验收；有效采用无需重复确认", story: "requestStoryDecision / requestStoryApproval：在聊天中保存故事选择与采用" },
    projectId, world: s.list("worlds", { projectId }), looks: s.list("looks", { projectId }), assets: s.list("assets", { projectId }),
    sequences: s.list("sequences", { projectId }), shots, references: s.list("refs", { projectId }), bindings: s.list("reference_bindings", { projectId }),
    keyframes: s.list("keyframes", { projectId }), takes: s.list("takes", { projectId }), qc: s.list("qc_reports", { projectId }),
    media: s.list("media", { projectId }).map(mediaView),
    candidateBatches: s.list("candidate_batches", { projectId }), candidates: s.list("candidates", { projectId }),
    library: s.list("library_assets"), assetVersions: s.list("asset_versions").filter(item => s.get("assets", item.assetId)?.projectId === projectId),
    renders: s.list("renders", { projectId }).map(render => ({ ...render, quality: finalQualityView(s, render), media: render.mediaId ? mediaView(s.get("media", render.mediaId)) : null })),
  };
  if (operation === "world" || operation === "look") {
    if (shots.some(shot => shot.heroKeyframeId || shot.approvedTakeId)) throw conflict("已有采用镜头，请调用 requestProductionDecision 在聊天中确认世界或影调修改", "approved_world");
    const table = operation === "world" ? "worlds" : "looks";
    const current = s.list(table, { projectId }).find(item => operation === "world" || item.scope === "project");
    if (!current) throw notFound(table);
    const schema = operation === "world" ? worldSchema : lookSchema;
    const patch = schema.partial().strict().parse(data);
    return s.update(table, current.id, { data: schema.parse({ ...current, ...patch }) });
  }
  if (operation === "asset") {
    const parsed = assetInput.parse(data);
    for (const id of parsed.references) if (s.get("refs", id)?.projectId !== projectId) throw notFound("project reference");
    return createAsset(s, projectId, parsed);
  }
  if (operation === "reference") {
    const { mediaId, name } = z.object({ mediaId: z.string().min(1), name: z.string().max(260).optional() }).strict().parse(data);
    const media = s.get("media", mediaId);
    if (!media || media.projectId !== projectId) throw notFound("当前项目媒体");
    const kind = media.mime.split("/")[0];
    if (!["image", "video", "audio"].includes(kind)) throw bad("参考素材须为图片、视频或音频");
    return s.list("refs", { projectId, mediaId })[0]
      ?? s.insert("refs", { project_id: projectId, kind, name: name ?? null, media_id: mediaId, source: media.source ?? "upload" });
  }
  if (operation === "sequence") {
    const parsed = z.object({ name: z.string().min(1).max(120), script: z.string().max(100000).default("") }).parse(data);
    return s.insert("sequences", { project_id: projectId, ...parsed, ord: s.list("sequences", { projectId }).length, data: {} });
  }
  if (operation === "shot") return createShot(s, projectId, shotInput.parse(data));
  const shot = typeof data.shotId === "string" && s.get("shots", data.shotId);
  if (!shot || shot.projectId !== projectId) throw notFound("project shot");
  if (operation === "updateShot") {
    if ("heroKeyframeId" in data) throw bad("主关键帧须调用 requestKeyframeApproval({keyframeIds:[所选关键帧记录ID]})，在聊天中展示并保存采用；不能通过 updateShot 设置，也无需去制作面板点击");
    if ("approvedTakeId" in data) throw bad("视频采用须调用 requestProductionDecision({operation:'approveTake',data:{takeIds:[所选视频记录ID]}})，在聊天中确认并保存，无需去制作面板");
    const { shotId: _shotId, ...patch } = data;
    return updateShot(s, shot.id, shotPartial.strict().parse(patch));
  }
  if (operation === "binding") return bindReference(s, projectId, { type: "shot", id: shot.id }, bindingInput.parse(data));
  throw bad("未知制片操作");
}
