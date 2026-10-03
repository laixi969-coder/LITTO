import { type Scope } from "../db.ts";
import { notFound } from "../util.ts";
import { checkSequence } from "./continuity.ts";
import { generateKeyframes, generateTakes } from "./lifecycle.ts";

/** QC never returns just a score: every finding carries a cause and a concrete Repair Action (PRD §20). */
const DIAGNOSIS: Record<string, { cause: string; action: string; detail: string; penalty: number; severity: "high" | "medium" | "low" }> = {
    hand_artifact: { cause: "Local anatomical failure (hands)", action: "inpaint_local", detail: "Mask the hands and inpaint / local edit; do not regenerate the whole frame", penalty: 15, severity: "medium" },
    face_artifact: { cause: "Local anatomical failure (face)", action: "inpaint_local", detail: "Mask the face region and inpaint with the IDENTITY reference", penalty: 15, severity: "medium" },
    identity_drift: { cause: "Identity drifted from approved asset", action: "reference_replace", detail: "Re-bind the IDENTITY reference at weight 1.0 (LOCK) and regenerate", penalty: 30, severity: "high" },
    composition_off: { cause: "Composition deviates from the shot spec", action: "composition_ref", detail: "Add a COMPOSITION reference (Hero Frame / sketch) and regenerate", penalty: 15, severity: "medium" },
    motion_physics: { cause: "Implausible motion / physics", action: "motion_regenerate", detail: "Regenerate with motion-director notes (anticipation, weight transfer, inertia) or a PERFORMANCE reference", penalty: 25, severity: "high" },
    scene_structure: { cause: "Space/layout structure broke", action: "geometry_lock", detail: "Lock the Environment geometry (ENVIRONMENT + GEOMETRY references) and regenerate", penalty: 25, severity: "high" },
    color_shift: { cause: "Minor colour/exposure mismatch", action: "look_normalization", detail: "Normalise the look in post; no regeneration needed", penalty: 5, severity: "low" },
    capability_mismatch: { cause: "Model lacks a capability the shot needs", action: "switch_model", detail: "Switch provider/model to one that supports the missing capability", penalty: 20, severity: "medium" },
    logo_distortion: { cause: "Logo/product detail distorted", action: "geometry_lock", detail: "Bind the product GEOMETRY reference at LOCK and regenerate", penalty: 25, severity: "high" },
};
export const OBSERVATION_KINDS = Object.keys(DIAGNOSIS);

export function runQc(s: Scope, shotId: string, target: { type: "keyframe" | "take"; id: string }, observations: { kind: string; note?: string }[] = []) {
    const shot = s.get("shots", shotId);
    if (!shot) throw notFound("shot");
    const obj = s.get(target.type === "take" ? "takes" : "keyframes", target.id);
    if (!obj) throw notFound(target.type);
    const findings: any[] = [];
    // 1. human / vision observations → diagnosis.
    for (const o of observations) {
        const d = DIAGNOSIS[o.kind];
        if (d) findings.push({ kind: o.kind, ...d, note: o.note });
    }
    // 2. automatic: the generation had to degrade a reference role → capability mismatch.
    const refs = (obj.meta?.inputRefs ?? []) as any[];
    const dropped = refs.filter((r) => !r.sent);
    if (dropped.length) findings.push({ kind: "capability_mismatch", ...DIAGNOSIS.capability_mismatch, note: `Reference roles degraded to text: ${dropped.map((r) => r.role).join(", ")}` });
    // 3. continuity issues on this shot.
    const issues = checkSequence(s, shot.sequenceId).filter((i) => i.shotId === shotId);
    for (const i of issues) findings.push({ kind: `continuity:${i.category}`, cause: i.message, action: i.repair.action, detail: i.repair.detail, penalty: i.severity === "high" ? 20 : i.severity === "medium" ? 8 : 3, severity: i.severity });
    const score = Math.max(0, 100 - findings.reduce((a, f) => a + f.penalty, 0));
    const report = s.insert("qc_reports", { project_id: shot.projectId, shot_id: shotId, target_type: target.type, target_id: target.id, score, findings });
    const actions = findings.map((f) => s.insert("repair_actions", { project_id: shot.projectId, qc_report_id: report.id, shot_id: shotId, action: f.action, cause: f.cause, detail: f.detail, status: "suggested" }));
    return { report: { id: report.id, score, findings }, repairActions: actions.map((a) => ({ id: a.id, action: a.action, cause: a.cause, detail: a.detail, status: a.status })) };
}

/** Apply a repair: creates a NEW variant/take (old ones are kept) with the fix expressed in structured form. */
export function applyRepair(s: Scope, repairId: string, actor: string) {
    const r = s.get("repair_actions", repairId);
    if (!r) throw notFound("repair action");
    const qc = s.get("qc_reports", r.qcReportId);
    const video = qc?.targetType === "take";
    const lock = ["identity_drift", "reference_replace"].includes(r.action) ? ["IDENTITY at weight 1.0 — do not alter facial geometry"] : r.action === "geometry_lock" || r.action === "environment_lock" ? ["geometry of environment and key props — do not alter layout"] : [];
    const o = { repair: { addLock: lock, note: r.detail }, count: video ? 1 : 2 };
    let res: any;
    if (r.action === "look_normalization") return normalizeLook(s, r);
    if (["inpaint_local"].includes(r.action)) return { applied: false, manual: true, message: r.action === "inpaint_local" ? "Local inpaint needs a mask — use the editor on the selected frame." : "Colour normalisation is applied in post; nothing to regenerate.", repairActionId: r.id };
    const policy = r.action === "switch_model" ? { disabledModelIds: qc ? [(s.get(video ? "takes" : "keyframes", qc.targetId) as any)?.meta?.modelId].filter(Boolean) : [] } : undefined;
    res = video ? generateTakes(s, r.shotId, actor, { ...o, policy }) : generateKeyframes(s, r.shotId, actor, { ...o, policy });
    s.update("repair_actions", repairId, { status: "applied" });
    return { applied: true, ...res };
}


const kelvin = (t?: string) => { const m = /(\d{3,5})\s*k/i.exec(t ?? ""); return m ? Number(m[1]) : null; };
/**
 * look_normalization is a real fix now: it writes a suggested parametric grade on the shot that nudges
 * colour temperature toward the previous shot's declared lighting and saturation toward the project Look.
 */
function normalizeLook(s: Scope, r: any) {
    const shot = s.get("shots", r.shotId)!;
    const prev = s.list("shots", { sequenceId: shot.sequenceId }, "ord").filter((x: any) => x.ord < shot.ord).pop() as any;
    const look = (s.list("looks", { projectId: shot.projectId }) as any[]).find((l) => l.scope === "project");
    const k0 = kelvin(prev?.lighting?.colorTemp), k1 = kelvin(shot.lighting?.colorTemp);
    // this shot cooler than the previous one → warm it up (positive) and vice versa; 1000 K ≈ 25 points
    const temperature = k0 && k1 ? Math.max(-100, Math.min(100, Math.round((k0 - k1) / 40))) : 0;
    const sat = /muted|desat/i.test(look?.saturation ?? "") ? 0.85 : /rich|vivid|satur/i.test(look?.saturation ?? "") ? 1.15 : 1;
    const base = { lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0], saturation: 1, contrast: 1, temperature: 0, exposureStops: 0, ...(shot.grade ?? {}) };
    const grade = { ...base, saturation: shot.grade?.saturation ?? sat, temperature: k0 && k1 ? temperature : base.temperature };
    const { id, workspaceId, projectId, sequenceId, sceneId, ord, schemaVersion, status, heroKeyframeId, approvedTakeId, createdAt, updatedAt, deletedAt, ...data } = shot;
    s.update("shots", shot.id, { data: { ...data, grade } });
    s.update("repair_actions", r.id, { status: "applied" });
    return { applied: true, grade, message: k0 && k1 ? `Temperature ${temperature >= 0 ? "+" : ""}${temperature} to match the previous shot (${k1}K → ${k0}K); applied at render.` : "No colour temperatures to compare; saturation aligned with the project Look. Fine-tune in the grade panel.", repairActionId: r.id };
}
