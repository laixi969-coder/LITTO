import { z } from "zod";
import { tx, type Scope } from "../db.ts";
import { bad, conflict, notFound } from "../util.ts";
import { keyframeView, promoteHero } from "./lifecycle.ts";
import { runQc } from "./qc.ts";
import { realismChecks, requireReviewed, shotFingerprint } from "./realism.ts";

export function prepareKeyframeApproval(s: Scope, projectId: string, input: unknown) {
  const ids = z.array(z.string().min(1).max(128)).min(1).max(60).parse(input);
  if (new Set(ids).size !== ids.length) throw bad("关键帧不能重复");
  if (!s.get("projects", projectId)) throw notFound("project");
  const shots = new Set<string>();
  return ids.map(id => {
    const keyframe = s.get("keyframes", id);
    const shot = keyframe && s.get("shots", keyframe.shotId);
    const media = keyframe?.mediaId && s.get("media", keyframe.mediaId);
    if (!keyframe || keyframe.projectId !== projectId || !shot || shot.projectId !== projectId
      || !media || media.projectId !== projectId || !media.mime.startsWith("image/")) throw bad("关键帧须为当前项目镜头的有效图片");
    if (shots.has(shot.id)) throw bad("每个镜头只能选定一张主关键帧，请先明确候选");
    shots.add(shot.id);
    const report = s.list("qc_reports", { targetType: "keyframe", targetId: id }, "created_at DESC, rowid DESC")[0];
    if (report?.findings.some((finding: { severity: string; kind: string }) => finding.severity === "high" && !finding.kind.startsWith("continuity:"))) {
      throw conflict(`「${shot.title}」存在严重画面问题，请修复或复核后再采用`, "qc_blocked");
    }
    let approved = false;
    if (shot.heroKeyframeId === id && keyframe.status === "hero") {
      try { requireReviewed(s, "keyframe", keyframe); approved = true; }
      catch (error) { if ((error as { code?: string }).code !== "review_required") throw error; }
    }
    return {
      id, shotId: shot.id as string, title: String(shot.title), mediaId: String(media.id),
      fingerprint: shotFingerprint(s, shot.id), heroKeyframeId: shot.heroKeyframeId ?? null,
      reportId: report?.id ?? null, approved, media: keyframeView(keyframe).media,
    };
  });
}

export function approveKeyframes(s: Scope, projectId: string, expected: ReturnType<typeof prepareKeyframeApproval>, actor: string) {
  return tx(() => {
    const current = prepareKeyframeApproval(s, projectId, expected.map(item => item.id));
    // ACT: 批量采用绑定卡片展示时的状态，任何一镜变化都不提交，避免部分采用或覆盖并发选择。
    for (const [index, item] of current.entries()) {
      const before = expected[index]!;
      if (item.shotId !== before.shotId || item.mediaId !== before.mediaId || item.fingerprint !== before.fingerprint
        || item.heroKeyframeId !== before.heroKeyframeId || item.reportId !== before.reportId) {
        throw conflict("待采用图片、镜头规格或检查记录已改变，请重新展示确认卡片", "stale");
      }
    }
    return current.map(item => {
      if (!item.approved) {
        runQc(s, item.shotId, { type: "keyframe", id: item.id }, [], {
          reviewed: realismChecks.filter(key => key !== "motion"), actor, note: "用户在聊天卡片查看并确认材质、成像、空间与电影感，采用为主关键帧",
        });
        promoteHero(s, item.id, actor);
      }
      return { shotId: item.shotId, heroKeyframeId: item.id };
    });
  });
}
