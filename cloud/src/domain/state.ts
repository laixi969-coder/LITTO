import { all, run, type Scope } from "../db.ts";
import { bad, j } from "../util.ts";
import { shotInput } from "./schema.ts";

export type State = { characters: Record<string, any>; wardrobe: Record<string, any>; props: Record<string, any>; environment: Record<string, any>; lighting: Record<string, any>; motion: Record<string, any>; emotional: Record<string, any> };
export const emptyState = (): State => ({ characters: {}, wardrobe: {}, props: {}, environment: {}, lighting: {}, motion: {}, emotional: {} });

/** null deletes a key; objects merge recursively; everything else replaces. */
export function applyDelta<T>(base: T, delta: any): T {
    if (delta === null || typeof delta !== "object" || Array.isArray(delta)) return delta;
    const out: any = { ...(base as any) };
    for (const [k, v] of Object.entries(delta)) {
        if (["__proto__", "constructor", "prototype"].includes(k)) throw bad("invalid state key");
        if (v === null) delete out[k];
        else out[k] = v !== null && typeof v === "object" && !Array.isArray(v) ? applyDelta(out[k] ?? {}, v) : v;
    }
    return out;
}

const KIND_BY_TYPE: Record<string, keyof State> = { Character: "characters", Wardrobe: "wardrobe", Environment: "environment", Prop: "props", Product: "props", Vehicle: "props", Creature: "characters", Custom: "props" };

export function validateStateDelta(s: Scope, projectId: string, delta: unknown) {
    const parsed = shotInput.shape.intendedStateDelta.safeParse(delta);
    if (!parsed.success) throw bad("计划状态变化须按 characters/wardrobe/props/environment/lighting/motion/emotional 分组，资产状态须为对象或 null", parsed.error.issues);
    for (const group of ["characters", "wardrobe", "props"] as const) {
        for (const [id, value] of Object.entries(parsed.data[group] ?? {})) {
            // ACT: 允许 null 清理旧状态，包括已经删除的资产；新增或变更状态必须有本项目真实资产。
            if (value === null) continue;
            const asset = s.get("assets", id);
            if (!asset || asset.projectId !== projectId || KIND_BY_TYPE[asset.type] !== group) throw bad(`状态 ${group}.${id} 须引用本项目对应类型的真实资产`);
        }
    }
    return parsed.data;
}

/** Seed entries for assets that first appear in this shot (their baseline is the asset itself, not a guess). */
function seed(state: State, shot: any, assets: Map<string, any>, newScene: boolean): State {
    const s = structuredClone(state);
    for (const id of shot.assetIds ?? []) {
        const a = assets.get(id);
        if (!a) continue;
        const k = KIND_BY_TYPE[a.type];
        if (!s[k][id]) s[k][id] = { name: a.name, present: true, ...(a.type === "Wardrobe" && a.attributes?.wornBy ? { wornBy: a.attributes.wornBy } : {}) };
        else s[k][id].present = true;
        if (a.type === "Wardrobe" && a.attributes?.wornBy) {
            const c = s.characters[a.attributes.wornBy] ?? (s.characters[a.attributes.wornBy] = {});
            if (!c.wardrobeId) c.wardrobeId = id;
        }
    }
    if ((newScene || !Object.keys(s.lighting).length) && shot.lighting) s.lighting = { worldSource: shot.lighting.worldSource, directionSpace: shot.lighting.directionSpace ?? "screen", keyDirection: shot.lighting.keyDirection, timeOfDay: shot.lighting.timeOfDay, colorTemp: shot.lighting.colorTemp };
    return s;
}

/**
 * PreviousState → IntendedDelta → ResultState. Next shot inherits ResultState.
 * Recomputed for the whole sequence whenever shots, order or deltas change.
 */
export function recomputeStates(s: Scope, sequenceId: string) {
    const shots = s.list("shots", { sequenceId }, "ord");
    const assets = new Map(s.list("assets").map((a) => [a.id, a]));
    let prev: State | null = null;
    let prevScene: string | null = null;
    for (const shot of shots) {
        const start = seed(prev ?? emptyState(), shot, assets, shot.sceneId !== prevScene);
        prevScene = shot.sceneId;
        const delta = shot.intendedStateDelta ?? {};
        const approved = shot.approvedTakeId ? s.get("takes", shot.approvedTakeId) : null;
        const result = applyDelta(start, approved?.meta?.observedStateDelta ?? delta);
        const upsert = (kind: string, data: State) => {
            const ex = all("SELECT id FROM shot_states WHERE shot_id=? AND kind=? AND workspace_id=?", shot.id, kind, s.workspaceId)[0];
            if (ex) run("UPDATE shot_states SET data=?, updated_at=? WHERE id=?", j(data), new Date().toISOString(), ex.id);
            else s.insert("shot_states", { project_id: shot.projectId, shot_id: shot.id, kind, data });
        };
        upsert("start", start);
        upsert("result", result);
        prev = result;
    }
}

export function statesOf(s: Scope, shotId: string): { start: State; result: State; source: "observed" | "planned" } {
    const rows = s.list("shot_states", { shotId });
    const pick = (k: string) => (rows.find((r) => r.kind === k) as any) ?? emptyState();
    const strip = (r: any): State => {
        const { id, workspaceId, projectId, shotId, kind, createdAt, updatedAt, ...st } = r;
        return { ...emptyState(), ...st };
    };
    const shot = s.get("shots", shotId);
    const take = shot?.approvedTakeId ? s.get("takes", shot.approvedTakeId) : null;
    return { start: strip(pick("start")), result: strip(pick("result")), source: take?.meta?.observedStateDelta ? "observed" : "planned" };
}
