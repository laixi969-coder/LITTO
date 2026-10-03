import { all, run, type Scope } from "../db.ts";
import { now } from "../util.ts";
import { statesOf, type State } from "./state.ts";

export type Issue = { shotId: string; relatedShotId?: string; category: string; severity: "high" | "medium" | "low"; message: string; repair: { action: string; detail: string } };

const SIZES = ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS"];
const sizeIdx = (s: string) => SIZES.indexOf(s.toUpperCase());

/** Rule-based continuity supervision over structured ShotSpec + State. Pure: no I/O. */
export function checkPair(prev: any | null, shot: any, prevSt: { start: State; result: State } | null, st: { start: State; result: State }, assets: Map<string, any>): Issue[] {
    const out: Issue[] = [];
    const add = (category: string, severity: Issue["severity"], message: string, action: string, detail: string, related?: string) => out.push({ shotId: shot.id, relatedShotId: related, category, severity, message, repair: { action, detail } });
    const sameScene = prev && prev.sceneId && prev.sceneId === shot.sceneId;
    const delta = shot.intendedStateDelta ?? {};
    const ids: string[] = shot.assetIds ?? [];
    const of = (id: string) => assets.get(id);

    // Identity / geometry: characters need an approved asset and an IDENTITY binding.
    for (const id of ids) {
        const a = of(id);
        if (!a) { add("Identity", "high", `Shot references missing asset ${id}`, "replace_reference", "Remove or replace the missing asset"); continue; }
        if (a.approvalStatus !== "approved") add("Identity", "medium", `${a.type} "${a.name}" is not approved; the model may drift`, "approve_asset", `Approve "${a.name}" so it becomes a LOCK`);
        if (["Character", "Creature"].includes(a.type) && !(shot.bindings ?? []).some((b: any) => b.role === "IDENTITY" && (b.assetId === id || !b.assetId)) && !(a.references ?? []).length) add("Identity", "high", `"${a.name}" has no IDENTITY reference on this shot`, "reference_replace", `Bind an IDENTITY reference for "${a.name}"`);
    }
    if (prev) {
        const prevIds: string[] = prev.assetIds ?? [];
        const text = `${shot.action} ${shot.title}`.toLowerCase();
        for (const id of prevIds) {
            const a = of(id);
            if (a && ["Character", "Creature"].includes(a.type) && !ids.includes(id) && text.includes(a.name.toLowerCase())) add("Identity", "medium", `"${a.name}" appears in the action but not in this shot's assets`, "reference_replace", `Add "${a.name}" to the shot assets`, prev.id);
        }

        // Wardrobe state: worn garment changed without an intended delta.
        for (const [cid, c] of Object.entries<any>(prevSt?.result.characters ?? {})) {
            const now = ids.filter((i) => of(i)?.type === "Wardrobe" && of(i)?.attributes?.wornBy === cid);
            if (c.wardrobeId && now.length && !now.includes(c.wardrobeId) && !delta.characters?.[cid]?.wardrobeId) add("State", "high", `Wardrobe of "${c.name ?? cid}" changed from "${of(c.wardrobeId)?.name}" to "${of(now[0])?.name}" without a state delta`, "regenerate_with_state", `Add intendedStateDelta.characters.${cid}.wardrobeId or restore the previous wardrobe`, prev.id);
        }
        // Props: a held prop must not vanish while its holder is on screen.
        for (const [pid, p] of Object.entries<any>(prevSt?.result.props ?? {})) {
            if (p.present && p.heldBy && ids.includes(p.heldBy) && !ids.includes(pid) && sameScene && !(delta.props && pid in delta.props)) add("State", "low", `"${p.name ?? pid}" was held by "${prevSt?.result.characters[p.heldBy]?.name ?? p.heldBy}" but is missing from this shot (off-frame is fine; otherwise add it)`, "geometry_lock", `Include "${p.name}" or set intendedStateDelta.props.${pid}.heldBy=null`, prev.id);
        }
        for (const id of ids) {
            const a = of(id);
            if (a && ["Prop", "Product", "Vehicle"].includes(a.type) && sameScene && !prevSt?.result.props[id] && !(delta.props && id in delta.props) && !prevIds.includes(id) && prev.narrativeFunction !== "Establish" && shot.narrativeFunction !== "Reveal") add("State", "low", `Prop "${a.name}" appears without being introduced`, "regenerate_with_state", "Use a Reveal shot or add a delta that introduces it", prev.id);
        }
        // Environment / spatial.
        const envNow = ids.filter((i) => of(i)?.type === "Environment");
        const envPrev = prevIds.filter((i) => of(i)?.type === "Environment");
        if (sameScene && envNow.length && envPrev.length && !envNow.some((e) => envPrev.includes(e)) && shot.narrativeFunction !== "Transition") add("Spatial", "high", `Environment changed within the same scene ("${of(envPrev[0])?.name}" → "${of(envNow[0])?.name}")`, "environment_lock", "Use the same Environment asset or insert a Transition shot", prev.id);

        // Lighting.
        const pl = prevSt?.result.lighting ?? {}, l = shot.lighting ?? {};
        if (sameScene && pl.timeOfDay && l.timeOfDay && pl.timeOfDay !== l.timeOfDay && !delta.lighting?.timeOfDay) add("Lighting", "high", `Time of day jumps ${pl.timeOfDay} → ${l.timeOfDay} inside one scene`, "look_normalization", "Match lighting to the previous shot or declare a lighting delta", prev.id);
        if (sameScene && pl.keyDirection && pl.keyDirection !== "none" && l.keyDirection && l.keyDirection !== "none" && pl.keyDirection !== l.keyDirection && !delta.lighting?.keyDirection) add("Lighting", "medium", `Key light direction flips ${pl.keyDirection} → ${l.keyDirection} without motivation`, "look_normalization", "Keep the key direction or add a motivated practical", prev.id);
        if (sameScene && pl.colorTemp && l.colorTemp && pl.colorTemp !== l.colorTemp && !delta.lighting?.colorTemp) add("Color", "low", `Colour temperature changes ${pl.colorTemp} → ${l.colorTemp}`, "look_normalization", "Normalise colour temperature in post or align the lighting spec", prev.id);

        // Camera: 180° rule / screen direction / eyeline.
        const pc = prev.camera ?? {}, c = shot.camera ?? {};
        if (sameScene && pc.side && c.side && pc.side !== "none" && c.side !== "none" && pc.side !== c.side && shot.narrativeFunction !== "Transition") add("Cinematic", "high", "Camera crosses the 180° axis (side " + pc.side + " → " + c.side + ") without a transition", "composition_ref", "Move the camera back to the original side or motivate the crossing", prev.id);
        if (sameScene && pc.screenDirection && c.screenDirection && pc.screenDirection !== "none" && c.screenDirection !== "none" && pc.screenDirection !== c.screenDirection && prev.narrativeFunction !== "Reaction" && shot.narrativeFunction !== "Reaction" && shot.narrativeFunction !== "Transition") add("Cinematic", "medium", `Screen direction reverses (${pc.screenDirection} → ${c.screenDirection}) with no cutaway`, "composition_ref", "Keep screen direction or cut away first", prev.id);
        if (shot.narrativeFunction === "Reaction" && prev.performance?.eyeline && shot.performance?.eyeline && prev.performance.eyeline === shot.performance.eyeline) add("Performance", "medium", `Eyeline match: both shots look ${shot.performance.eyeline}; reaction should look the opposite way`, "composition_ref", "Flip the reaction eyeline", prev.id);
        if (shot.narrativeFunction === "Match" && !(prev.action || "").trim()) add("Motion", "medium", "Match on action but previous shot has no action to match", "motion_reference", "Describe the matched action in the previous shot", prev.id);
        const pi = sizeIdx(pc.shotSize ?? ""), ci = sizeIdx(c.shotSize ?? "");
        if (sameScene && pi >= 0 && ci >= 0 && Math.abs(pi - ci) >= 4) add("Cinematic", "low", `Shot size jumps ${pc.shotSize} → ${c.shotSize}; consider an intermediate size`, "composition_ref", "Insert a medium-size bridge shot", prev.id);
        const ei = shot.performance?.intensity ?? 0, pe = prev.performance?.intensity ?? 0;
        if (sameScene && Math.abs(ei - pe) > 0.6 && !delta.emotional) add("Performance", "low", "Emotional intensity jumps without a state change", "regenerate_with_state", "Add an emotional state delta or bridge the performance", prev.id);
    }
    if (shot.camera?.motion && shot.camera.motion !== "static" && !shot.camera.motivation) add("Cinematic", "low", `Camera move "${shot.camera.motion}" has no motivation`, "composition_ref", "State why the camera moves (follows action, reveals, etc.)");
    return out;
}

export function checkSequence(s: Scope, sequenceId: string): Issue[] {
    const shots = s.list("shots", { sequenceId }, "ord");
    const assets = new Map(s.list("assets").map((a) => [a.id, a]));
    const bindings = s.list("reference_bindings", { targetType: "shot" });
    const issues: Issue[] = [];
    let prev: any = null, prevSt: any = null;
    for (const shot of shots) {
        const st = statesOf(s, shot.id);
        const sh = { ...shot, bindings: bindings.filter((b) => b.targetId === shot.id) };
        issues.push(...checkPair(prev, sh, prevSt, st, assets));
        prev = sh;
        prevSt = st;
    }
    // Persist: replace open issues, keep overridden ones.
    const old = all("SELECT * FROM continuity_issues WHERE workspace_id=? AND shot_id IN (" + (shots.map(() => "?").join(",") || "''") + ")", s.workspaceId, ...shots.map((x) => x.id));
    const key = (i: any) => `${i.shotId ?? i.shot_id}|${i.category}|${i.message}`;
    const overridden = new Set(old.filter((o) => o.status === "overridden").map(key));
    run(`DELETE FROM continuity_issues WHERE workspace_id=? AND status='open' AND shot_id IN (${shots.map(() => "?").join(",") || "''"})`, s.workspaceId, ...shots.map((x) => x.id));
    for (const i of issues) {
        if (overridden.has(key(i))) continue;
        s.insert("continuity_issues", { project_id: shots[0]?.projectId, shot_id: i.shotId, related_shot_id: i.relatedShotId ?? null, category: i.category, severity: i.severity, message: i.message, repair: i.repair, status: "open", updated_at: now() });
    }
    return issues;
}

export const openHighIssues = (s: Scope, shotId: string) => s.list("continuity_issues", { shotId, status: "open", severity: "high" });
