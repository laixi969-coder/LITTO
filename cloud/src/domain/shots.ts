import { all, run, tx, type Scope } from "../db.ts";
import { bad, conflict, notFound } from "../util.ts";
import { SCHEMA_VERSION, shotInput, cameraSchema, lightingSchema, validateMusicVideoTiming, type ShotInput } from "./schema.ts";
import { recomputeStates } from "./state.ts";
import type { ShotDraft } from "./skills.ts";
import type { z } from "zod";

export const shotPartial = shotInput.partial();

const dataOf = (i: ShotInput) => {
    const { sequenceId, sceneId, order, ...data } = i;
    return data;
};

export function createShot(s: Scope, projectId: string, input: ShotInput) {
    validateMusicVideoTiming(input);
    const seq = s.get("sequences", input.sequenceId);
    if (!seq || seq.projectId !== projectId) throw notFound("sequence");
    if (input.sceneId && s.get("scenes", input.sceneId)?.sequenceId !== input.sequenceId) throw bad("scene does not belong to sequence");
    for (const id of input.assetIds) if (s.get("assets", id)?.projectId !== projectId) throw bad(`unknown project asset ${id}`);
    const ord = input.order ?? all("SELECT COALESCE(MAX(ord),-1)+1 AS n FROM shots WHERE sequence_id=? AND workspace_id=? AND deleted_at IS NULL", input.sequenceId, s.workspaceId)[0].n;
    return tx(() => {
        if (input.order !== undefined) run("UPDATE shots SET ord=ord+1 WHERE sequence_id=? AND workspace_id=? AND ord>=? AND deleted_at IS NULL", input.sequenceId, s.workspaceId, ord);
        const shot = s.insert("shots", { project_id: projectId, sequence_id: input.sequenceId, scene_id: input.sceneId ?? null, ord, schema_version: SCHEMA_VERSION, status: "planned", data: dataOf({ ...input, freedomMap: input.freedomMap }) });
        recomputeStates(s, input.sequenceId);
        return s.get("shots", shot.id)!;
    });
}

/** Changing the core intent of a shot that already has a Hero Frame / Approved Take must be confirmed (PRD §13). */
const CORE = ["sceneId", "narrativeFunction", "action", "assetIds", "camera", "lighting", "realism", "freedomMap", "performance", "blocking", "intendedStateDelta", "duration", "subtitle", "generationDuration", "inspectionRegion", "musicVideo"] as const;
export function updateShot(s: Scope, id: string, patch: Partial<ShotInput>, confirm = false) {
    const shot = s.get("shots", id);
    if (!shot) throw notFound("shot");
    // 仅同步原先逐字镜像 action 的路径；独立编排的走位或本次显式相机修改保持原意。
    if (patch.action !== undefined && patch.camera === undefined && shot.camera?.design?.subjectPath === shot.action) {
        patch = { ...patch, camera: { ...shot.camera, design: { ...shot.camera.design, subjectPath: patch.action } } };
    }
    validateMusicVideoTiming({ ...shot, ...patch } as ShotInput);
    if (patch.sequenceId !== undefined && patch.sequenceId !== shot.sequenceId) throw bad("use the sequence workflow to move a shot");
    if (patch.sceneId && s.get("scenes", patch.sceneId)?.sequenceId !== shot.sequenceId) throw bad("scene does not belong to sequence");
    const changed = CORE.filter((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(shot[k]));
    if (changed.length && (shot.heroKeyframeId || shot.approvedTakeId) && !confirm) throw conflict(`changing ${changed.join(", ")} affects an approved Hero Frame/Take; resend with confirm:true`, "needs_confirmation", { fields: changed, heroKeyframeId: shot.heroKeyframeId, approvedTakeId: shot.approvedTakeId });
    for (const aid of patch.assetIds ?? []) if (s.get("assets", aid)?.projectId !== shot.projectId) throw bad(`unknown project asset ${aid}`);
    const { id: _i, workspaceId, projectId, sequenceId, sceneId, ord, schemaVersion, status, heroKeyframeId, approvedTakeId, createdAt, updatedAt, deletedAt, ...data } = shot;
    const { sequenceId: _s, sceneId: _c, order, ...rest } = patch;
    return tx(() => {
        const upd = s.update("shots", id, { data: { ...data, ...rest }, ...(patch.sceneId !== undefined ? { scene_id: patch.sceneId } : {}) });
        recomputeStates(s, sequenceId);
        return s.get("shots", upd.id)!;
    });
}

export function moveShot(s: Scope, id: string, toOrder: number) {
    const shot = s.get("shots", id);
    if (!shot) throw notFound("shot");
    tx(() => {
        const ids = s.list("shots", { sequenceId: shot.sequenceId }, "ord").map((x) => x.id).filter((x) => x !== id);
        ids.splice(Math.max(0, Math.min(toOrder, ids.length)), 0, id);
        ids.forEach((sid, i) => run("UPDATE shots SET ord=? WHERE id=? AND workspace_id=?", i, sid, s.workspaceId));
        recomputeStates(s, shot.sequenceId);
    });
    return s.list("shots", { sequenceId: shot.sequenceId }, "ord");
}

export function deleteShot(s: Scope, id: string) {
    const shot = s.get("shots", id);
    if (!shot) throw notFound("shot");
    s.softDelete("shots", id);
    recomputeStates(s, shot.sequenceId);
}

export function bindReference(s: Scope, projectId: string, target: { type: "shot" | "asset"; id: string }, b: { referenceId: string; role: string; weight?: number; lockLevel?: string; crop?: any; notes?: string }) {
    if (s.get(target.type === "shot" ? "shots" : "assets", target.id)?.projectId !== projectId) throw notFound(target.type);
    if (s.get("refs", b.referenceId)?.projectId !== projectId) throw notFound("reference");
    return s.insert("reference_bindings", { project_id: projectId, target_type: target.type, target_id: target.id, reference_id: b.referenceId, role: b.role, weight: b.weight ?? 1, lock_level: b.lockLevel ?? "CONTROL", crop: b.crop ?? null, notes: b.notes ?? null });
}

/** Materialise Storyboard Director output as real ShotSpecs (scenes created on demand). */
export function createShotsFromDrafts(s: Scope, projectId: string, sequenceId: string, drafts: ShotDraft[], opts: { replace?: boolean } = {}) {
    if (s.get("sequences", sequenceId)?.projectId !== projectId) throw notFound("sequence");
    if (!drafts.length) throw bad("不能用空分镜替换已有镜头");
    const scenes = new Map<number, string>();
    const out: any[] = [];
    tx(() => {
        if (opts.replace) for (const sh of s.list("shots", { sequenceId })) if (!sh.approvedTakeId && !sh.heroKeyframeId) s.softDelete("shots", sh.id);
        for (const d of drafts) {
            if (!scenes.has(d.sceneIndex)) scenes.set(d.sceneIndex, s.insert("scenes", { project_id: projectId, sequence_id: sequenceId, name: d.sceneName, ord: d.sceneIndex, data: {} }).id);
            const ord = all("SELECT COALESCE(MAX(ord),-1)+1 AS n FROM shots WHERE sequence_id=? AND workspace_id=? AND deleted_at IS NULL", sequenceId, s.workspaceId)[0].n;
            const shot = s.insert("shots", { project_id: projectId, sequence_id: sequenceId, scene_id: scenes.get(d.sceneIndex), ord, schema_version: SCHEMA_VERSION, status: "planned", data: { subtitle: d.subtitle ?? "", title: d.title, narrativeFunction: d.narrativeFunction, assetIds: d.assetIds, action: d.action, performance: d.performance, blocking: d.blocking, camera: d.camera, lighting: d.lighting, intendedStateDelta: d.intendedStateDelta, constraints: [], duration: d.duration } });
            out.push(shot);
        }
        recomputeStates(s, sequenceId);
    });
    return out.map((x) => s.get("shots", x.id)!);
}
void cameraSchema; void lightingSchema;
export type { z };
