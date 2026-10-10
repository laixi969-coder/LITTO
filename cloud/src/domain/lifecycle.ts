import { all, get, run, tx, type Scope } from "../db.ts";
import { bad, conflict, notFound } from "../util.ts";
import { compileShot, requireCompiledInputs } from "./compiler.ts";
import { event } from "./assets.ts";
import { checkSequence, openHighIssues } from "./continuity.ts";
import { recomputeStates } from "./state.ts";
import { enqueue, estimate } from "../jobs.ts";
import { mustRoute, resolvePolicy, type Policy } from "../providers/router.ts";
import { mediaView } from "../storage.ts";
import { requireReviewed } from "./realism.ts";
import { registerCandidates } from "./candidates.ts";
import { log } from "../util.ts";

/** Job success → materialise domain objects. Nothing is overwritten: every output is a new Keyframe variant or Take candidate. */
export function onJobSucceeded(s: Scope, job: any, mediaIds: string[]) {
    if (job.targetType !== "shot") return;
    const shot = s.get("shots", job.targetId);
    if (!shot) return;
    const meta = { jobId: job.id, modelId: job.modelId, providerId: job.providerId, seed: job.seed, prompt: job.compiledPrompt, parameters: job.parameters, inputRefs: job.inputRefs };
    if (job.kind === "image") {
        for (const m of mediaIds) s.insert("keyframes", { project_id: job.projectId, shot_id: shot.id, job_id: job.id, media_id: m, status: "variant", meta });
        s.update("shots", shot.id, { status: shot.status === "planned" ? "keyframing" : shot.status });
    } else {
        const kfId = job.parameters?.keyframeId ?? shot.heroKeyframeId;
        for (const m of mediaIds) s.insert("takes", { project_id: job.projectId, shot_id: shot.id, job_id: job.id, media_id: m, keyframe_id: kfId ?? null, status: "candidate", meta });
        s.update("shots", shot.id, { status: shot.approvedTakeId ? shot.status : "taking" });
    }
    // 抽卡入池：本批产物自动登记为候选，等待质检与采用；否则抽卡结果无法回本。
    const batchId = job.parameters?.candidateBatchId;
    if (batchId) {
        try {
            registerCandidates(s, batchId, mediaIds, { jobId: job.id, seed: job.seed, modelId: job.modelId });
        } catch (e) {
            log.error("candidate registration failed", (e as Error).message);
        }
    }
}

type GenOpts = { count?: number; policy?: Policy; idempotencyKey?: string; repair?: { addLock?: string[]; note?: string }; seed?: number; candidateBatchId?: string; assetId?: string };

const sizeOf = (shot: any, kind: "image" | "video") => {
    const portrait = shot.camera?.aspect === "9:16";
    return kind === "video" ? (portrait ? { width: 720, height: 1280 } : { width: 1280, height: 720 }) : portrait ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
};

export function generateKeyframes(s: Scope, shotId: string, actor: string, o: GenOpts = {}) {
    const shot = s.get("shots", shotId);
    if (!shot) throw notFound("shot");
    const bindings = s.list("reference_bindings", { targetType: "shot", targetId: shotId });
    const policy = resolvePolicy(s.workspaceId, shot.projectId, { ...shot.modelOverride, ...o.policy });
    const { chosen } = mustRoute({ kind: "image", workspaceId: s.workspaceId, projectId: shot.projectId, roles: bindings.map((b: any) => b.role), policy });
    const c = compileShot(s, shotId, "image", chosen!.modelId, { repair: o.repair });
    requireCompiledInputs(c);
    const job = enqueue({ workspaceId: s.workspaceId, projectId: shot.projectId, kind: "image", targetType: "shot", targetId: shotId, modelId: chosen!.modelId, compiledPrompt: c.prompt, negativePrompt: c.negativePrompt, parameters: { ...sizeOf(shot, "image"), count: o.count ?? 3, ...(o.candidateBatchId ? { candidateBatchId: o.candidateBatchId } : {}) }, inputRefs: c.inputs, createdBy: actor, fallbackAllowed: policy.allowFallback !== false, idempotencyKey: o.idempotencyKey, label: `KEYFRAME · shot ${shot.ord + 1}`, seed: o.seed });
    return { job, degradations: [...chosen!.degradations, ...c.degradations], warnings: c.warnings, compiled: { prompt: c.prompt, freedomMap: c.freedomMap, inputs: c.inputs.map((i) => ({ role: i.role, sent: i.sent, weight: i.weight })) } };
}

export function promoteHero(s: Scope, keyframeId: string, actor: string) {
    const kf = s.get("keyframes", keyframeId);
    if (!kf) throw notFound("keyframe");
    const shot = s.get("shots", kf.shotId);
    const media = kf.mediaId ? s.get("media", kf.mediaId) : undefined;
    if (!shot || shot.projectId !== kf.projectId || !media?.mime.startsWith("image/") || media.projectId !== kf.projectId) throw bad("关键帧的镜头或媒体已失效");
    requireReviewed(s, "keyframe", kf);
    return tx(() => {
        // Previous Hero is preserved (status superseded), never deleted.
        for (const k of s.list("keyframes", { shotId: shot.id, status: "hero" })) s.update("keyframes", k.id, { status: "superseded" });
        s.update("keyframes", keyframeId, { status: "hero" });
        s.update("shots", shot.id, { hero_keyframe_id: keyframeId, status: shot.status === "approved" ? "approved" : "hero" });
        event(s, kf.projectId, "hero_frame", keyframeId, "promote", actor, undefined, shot.id);
        return s.get("keyframes", keyframeId)!;
    });
}

export function rollbackHero(s: Scope, shotId: string, toKeyframeId: string, actor: string) {
    const kf = s.get("keyframes", toKeyframeId);
    if (!kf || kf.shotId !== shotId) throw notFound("keyframe");
    const was = all("SELECT 1 FROM approval_events WHERE entity_type='hero_frame' AND entity_id=? AND workspace_id=?", toKeyframeId, s.workspaceId);
    if (!was.length) throw bad("keyframe was never a Hero Frame");
    const r = promoteHero(s, toKeyframeId, actor);
    event(s, kf.projectId, "hero_frame", toKeyframeId, "rollback", actor, undefined, shotId);
    return r;
}

export function generateTakes(s: Scope, shotId: string, actor: string, o: GenOpts & { keyframeId?: string } = {}) {
    const shot = s.get("shots", shotId);
    if (!shot) throw notFound("shot");
    const kfId = o.keyframeId ?? shot.heroKeyframeId;
    const kf = kfId ? s.get("keyframes", kfId) : null;
    if (!kf || kf.shotId !== shotId || kf.id !== shot.heroKeyframeId || kf.status !== "hero") throw conflict("promote a Hero Frame before generating Takes", "no_hero_frame");
    requireReviewed(s, "keyframe", kf);
    const bindings = s.list("reference_bindings", { targetType: "shot", targetId: shotId });
    const roles = ["START_FRAME", ...bindings.map((b: any) => b.role)];
    const policy = resolvePolicy(s.workspaceId, shot.projectId, { ...shot.modelOverride, ...o.policy });
    const { chosen } = mustRoute({ kind: "video", workspaceId: s.workspaceId, projectId: shot.projectId, roles, policy });
    const c = compileShot(s, shotId, "video", chosen!.modelId, { startFrameMediaId: kf.mediaId, repair: o.repair });
    requireCompiledInputs(c);
    if (shot.generationDuration != null && shot.generationDuration < shot.duration) throw bad("生成时长不能短于计划使用时长");
    const jobs = [];
    const n = o.count ?? 2;
    for (let i = 0; i < n; i++) jobs.push(enqueue({ workspaceId: s.workspaceId, projectId: shot.projectId, kind: "video", targetType: "shot", targetId: shotId, modelId: chosen!.modelId, compiledPrompt: c.prompt, negativePrompt: c.negativePrompt, parameters: { ...sizeOf(shot, "video"), duration: shot.generationDuration ?? shot.duration ?? 4, keyframeId: kf.id, count: 1, ...(o.candidateBatchId ? { candidateBatchId: o.candidateBatchId } : {}) }, inputRefs: c.inputs, createdBy: actor, fallbackAllowed: policy.allowFallback !== false, idempotencyKey: o.idempotencyKey ? `${o.idempotencyKey}:${i}` : undefined, label: `TAKE ${i + 1} · shot ${shot.ord + 1}`, seed: o.seed !== undefined ? o.seed + i : undefined }));
    return { jobs, degradations: [...chosen!.degradations, ...c.degradations], warnings: c.warnings };
}

/**
 * Approve a Take. High-severity open continuity issues block approval (PRD §20) unless overridden with a recorded reason.
 */
export function approveTake(s: Scope, takeId: string, actor: string, override?: { reason: string }) {
    const take = s.get("takes", takeId);
    if (!take) throw notFound("take");
    const evidence = requireReviewed(s, "take", take);
    if (!evidence.observedStateDelta) throw conflict("请记录视频结束时实际观察到的资产状态", "result_state_required");
    const shot = s.get("shots", take.shotId)!;
    checkSequence(s, shot.sequenceId);
    const high = openHighIssues(s, shot.id);
    if (high.length && !override?.reason) throw conflict(`${high.length} high-severity continuity issue(s) block approval`, "continuity_blocked", high.map((h: any) => ({ id: h.id, category: h.category, message: h.message })));
    return tx(() => {
        if (high.length) {
            for (const h of high) s.update("continuity_issues", h.id, { status: "overridden", override_reason: override!.reason });
            event(s, take.projectId, "take", takeId, "override_continuity", actor, override!.reason, shot.id);
        }
        for (const t of s.list("takes", { shotId: shot.id, status: "approved" })) s.update("takes", t.id, { status: "superseded" });
        s.update("takes", takeId, { status: "approved", meta: { ...take.meta, observedStateDelta: evidence.observedStateDelta } });
        s.update("shots", shot.id, { approved_take_id: takeId, status: "approved" });
        recomputeStates(s, shot.sequenceId);
        event(s, take.projectId, "take", takeId, "approve", actor, undefined, shot.id);
        return s.get("takes", takeId)!;
    });
}

export function rollbackTake(s: Scope, shotId: string, toTakeId: string, actor: string) {
    const t = s.get("takes", toTakeId);
    if (!t || t.shotId !== shotId) throw notFound("take");
    if (!all("SELECT 1 FROM approval_events WHERE entity_type='take' AND entity_id=? AND action='approve' AND workspace_id=?", toTakeId, s.workspaceId).length) throw bad("take was never approved");
    const r = approveTake(s, toTakeId, actor, { reason: "rollback" });
    event(s, t.projectId, "take", toTakeId, "rollback", actor, undefined, shotId);
    return r;
}

export const keyframeView = (k: any) => ({ id: k.id, shotId: k.shotId, status: k.status, jobId: k.jobId, modelId: k.meta?.modelId, seed: k.meta?.seed, createdAt: k.createdAt, media: mediaOf(k.workspaceId, k.mediaId) });
export const takeView = (t: any) => ({ id: t.id, shotId: t.shotId, keyframeId: t.keyframeId, status: t.status, jobId: t.jobId, modelId: t.meta?.modelId, seed: t.meta?.seed, createdAt: t.createdAt, media: mediaOf(t.workspaceId, t.mediaId) });
function mediaOf(ws: string, id: string | null) {
    if (!id) return null;
    const m = get("SELECT * FROM media WHERE id=? AND workspace_id=?", id, ws);
    return m ? mediaView({ ...m, storageKey: m.storage_key, createdAt: m.created_at }) : null;
}
void run; void recomputeStates; void estimate;
