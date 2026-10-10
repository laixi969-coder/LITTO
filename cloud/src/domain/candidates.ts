import { all, get, run, tx, type Scope } from "../db.ts";
import { bad, conflict, notFound } from "../util.ts";
import { event } from "./assets.ts";
import { mediaView } from "../storage.ts";

/**
 * 抽卡候选池（PRD §6.4 补强）。
 *
 * 真实感来自批量比对与择优，不来自一次生成成功。因此抽卡必须能回本：
 * 一次生成一批 → 逐张质检打分 → 人工采用胜出者 → 胜出图成为该资产的权威参考图，
 * 后续镜头默认绑定它。这样同一张脸在同一项目内稳定，重复抽卡的边际成本才会下降。
 */

/** 候选必须挂在真实存在的产物上，避免出现无法回溯到生成记录的条目。 */
type CandidateTarget = { kind: "keyframe" | "take"; id: string };

function targetOf(row: any): { keyframeId?: string; takeId?: string } {
    return { keyframeId: row.keyframe_id ?? undefined, takeId: row.take_id ?? undefined };
}

export function createBatch(s: Scope, input: {
    projectId: string; kind: "image" | "video"; promptFingerprint: string;
    assetId?: string; shotId?: string;
}, actor: string) {
    if (!input.promptFingerprint.trim()) throw bad("候选批次须记录提示词指纹，否则无法判断候选是否可比");
    return s.insert("candidate_batches", {
        project_id: input.projectId, asset_id: input.assetId ?? null, shot_id: input.shotId ?? null,
        kind: input.kind, prompt_fingerprint: input.promptFingerprint, count: 0,
    });
}

/** 生成完成后登记候选：把本批媒体挂进池子，等质检与人工采用。 */
export function registerCandidates(s: Scope, batchId: string, mediaIds: string[], meta: Record<string, unknown> = {}) {
    const batch = s.get("candidate_batches", batchId);
    if (!batch) throw notFound("candidate batch");
    return tx(() => {
        const created = mediaIds.map(mediaId => {
            // ACT: 产物已在 keyframes/takes 中登记时，回链对象，晋升才能同步主关键帧与 Take。
            const shot = batch.shotId;
            const keyframe = shot ? all("SELECT id FROM keyframes WHERE workspace_id=? AND project_id=? AND shot_id=? AND media_id=? ORDER BY rowid DESC", s.workspaceId, batch.projectId, shot, mediaId)[0] : undefined;
            const take = shot ? all("SELECT id FROM takes WHERE workspace_id=? AND project_id=? AND shot_id=? AND media_id=? ORDER BY rowid DESC", s.workspaceId, batch.projectId, shot, mediaId)[0] : undefined;
            return s.insert("candidates", {
                project_id: batch.projectId, batch_id: batch.id, asset_id: batch.assetId ?? null,
                keyframe_id: keyframe?.id ?? null, take_id: take?.id ?? null,
                media_id: mediaId, status: "candidate", meta,
            });
        });
        // ACT: count 记录实际候选数，不能在创建时预填后再累加，否则统计翻倍。
        const actual = (get("SELECT COUNT(*) AS n FROM candidates WHERE workspace_id=? AND batch_id=?", s.workspaceId, batch.id) as any)?.n ?? created.length;
        s.update("candidate_batches", batch.id, { count: actual });
        return created;
    });
}

/** 视觉质检结果写入候选；人工采用与自动打分分离，改分不改采用状态。 */
export function scoreCandidate(s: Scope, candidateId: string, score: { scores?: Record<string, number>; findings?: { kind: string; note?: string }[] }) {
    const c = s.get("candidates", candidateId);
    if (!c) throw notFound("candidate");
    if (c.status === "promoted") throw conflict("已晋升为权威参考的候选不再重新评分", "candidate_promoted");
    return s.update("candidates", candidateId, {
        scores: { ...(c.scores ?? {}), ...(score.scores ?? {}), overall: score.scores?.overall ?? c.scores?.overall ?? null },
        findings: [...(c.findings ?? []), ...(score.findings ?? [])],
    });
}

export function listCandidates(s: Scope, batchId: string) {
    return all("SELECT * FROM candidates WHERE workspace_id=? AND batch_id=? ORDER BY created_at", s.workspaceId, batchId).map((r: any) => ({
        id: r.id, mediaId: r.media_id, status: r.status, promoted: !!r.promoted,
        scores: JSON.parse(r.scores || "{}"), findings: JSON.parse(r.findings || "[]"),
        keyframeId: r.keyframe_id, takeId: r.take_id, assetId: r.asset_id,
        media: mediaOf(s.workspaceId, r.media_id), createdAt: r.created_at,
    }));
}

export function listBatches(s: Scope, projectId: string) {
    return all("SELECT * FROM candidate_batches WHERE workspace_id=? AND project_id=? ORDER BY created_at DESC", s.workspaceId, projectId).map((r: any) => ({
        id: r.id, kind: r.kind, assetId: r.asset_id, shotId: r.shot_id, count: r.count,
        promptFingerprint: r.prompt_fingerprint, createdAt: r.created_at,
    }));
}

/**
 * 采用胜出候选：绑定为资产的权威参考图，并可同步晋升主关键帧。
 * 这是抽卡回本的落点——采用的图片从此成为后续镜头的默认身份参考。
 */
export function promoteCandidate(s: Scope, candidateId: string, actor: string, options: { asHero?: boolean } = {}) {
    const c = s.get("candidates", candidateId);
    if (!c) throw notFound("candidate");
    if (c.promoted) throw conflict("候选已晋升", "candidate_promoted");
    if (!c.mediaId) throw bad("候选缺少媒体，无法晋升");
    return tx(() => {
        let asset = c.assetId ? s.get("assets", c.assetId) : undefined;
        if (!asset) throw bad("候选未绑定资产，无法晋升为权威参考");
        // 权威参考追加到 references 末尾；已存在的同一媒体不重复登记。
        const references = [...(asset.references ?? [])];
        if (!references.includes(c.mediaId)) references.push(c.mediaId);
        const attributes = {
            ...(asset.attributes ?? {}),
            // 记录胜出身份参考，供编译器与人工核对时知道哪张是定妆图。
            authoritativeReference: c.mediaId,
            authoritativePromotedAt: new Date().toISOString(),
        };
        s.update("assets", asset.id, { data: { description: asset.description ?? "", attributes, references, invariants: asset.invariants ?? [], allowedVariations: asset.allowedVariations ?? [], forbiddenChanges: asset.forbiddenChanges ?? [] } });
        const updated = s.update("candidates", candidateId, { promoted: 1, status: "promoted" });
        // 同批次其余候选标记落选，保留可追溯，不删除。
        for (const other of s.list("candidates", { batchId: c.batchId })) {
            if (other.id !== candidateId && other.status === "candidate") s.update("candidates", other.id, { status: "rejected" });
        }
        let heroId: string | undefined;
        if (options.asHero && c.keyframeId) {
            const kf = s.get("keyframes", c.keyframeId);
            if (kf) {
                for (const k of s.list("keyframes", { shotId: kf.shotId, status: "hero" })) s.update("keyframes", k.id, { status: "superseded" });
                s.update("keyframes", c.keyframeId, { status: "hero" });
                s.update("shots", kf.shotId, { hero_keyframe_id: c.keyframeId });
                heroId = c.keyframeId;
                event(s, kf.projectId, "hero_frame", c.keyframeId, "promote", actor, "candidate pool winner", kf.shotId);
            }
        }
        event(s, asset.projectId, "asset", asset.id, "promote_reference", actor, `candidate ${candidateId}${heroId ? " + hero frame" : ""}`);
        return { candidate: updated, assetId: asset.id, authoritativeReference: c.mediaId, heroKeyframeId: heroId ?? null };
    });
}

function mediaOf(ws: string, id: string | null) {
    if (!id) return null;
    const m = get("SELECT * FROM media WHERE id=? AND workspace_id=?", id, ws);
    return m ? mediaView({ ...m, storageKey: m.storage_key, createdAt: m.created_at }) : null;
}
void run;
