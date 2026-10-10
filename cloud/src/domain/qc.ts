import { type Scope } from "../db.ts";
import { notFound } from "../util.ts";
import { checkSequence } from "./continuity.ts";
import { generateKeyframes, generateTakes } from "./lifecycle.ts";
import { realismChecks, shotFingerprint } from "./realism.ts";
import { scheduleLocalRepair } from "./localRepair.ts";
import { bad } from "../util.ts";

/** QC never returns just a score: every finding carries a cause and a concrete Repair Action (PRD §20). */
const DIAGNOSIS: Record<string, { cause: string; action: string; detail: string; penalty: number; severity: "high" | "medium" | "low" }> = {
    anatomy_failure: { cause: "肢体增减、身体结构或遮挡关系错误", action: "motion_regenerate", detail: "定位多肢、消失或穿透的时间段，拒绝该候选；保持身份，简化为一次完整动作并重新生成，完整播放复核", penalty: 40, severity: "high" },
    wardrobe_drift: { cause: "服装或商品形状与锁定参考不一致", action: "geometry_lock", detail: "核对实际商品参考、裤长、腰头、缝线与服装状态；更换不一致镜头，不用转场掩盖", penalty: 30, severity: "high" },
    plastic_surface: { cause: "皮肤或材质呈塑料感、统一磨皮", action: "material_reference", detail: "核对材质与光照参考，修正表面粗糙度、局部纹理与高光响应；保留身份后另出关键帧，不靠叠加锐化补救", penalty: 25, severity: "high" },
    imaging_failure: { cause: "曝光、焦平面或光学表现不可信", action: "imaging_revise", detail: "核对实景光源、曝光主体、高光滚降、暗部和景深，调整摄影规格后另出候选", penalty: 20, severity: "high" },
    temporal_drift: { cause: "视频材质、身份或空间随时间漂移", action: "motion_regenerate", detail: "标记出错时间段，锁定 Hero 和身份/环境参考，简化该段动作后生成新 Take", penalty: 25, severity: "high" },
    performance_failure: { cause: "表演或摄影机运动缺少动机", action: "performance_revise", detail: "重写可观察的反应、动作与收势节拍，明确走位和摄影机动机，再生成新 Take", penalty: 20, severity: "high" },
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

export function runQc(s: Scope, shotId: string, target: { type: "keyframe" | "take"; id: string }, observations: { kind: string; note?: string }[] = [], review: { reviewed?: string[]; note?: string; actor?: string; vision?: unknown; observedStateDelta?: Record<string, unknown>; fullPlayback?: boolean; dismissedKinds?: string[] } = {}) {
    const shot = s.get("shots", shotId);
    if (!shot) throw notFound("shot");
    const obj = s.get(target.type === "take" ? "takes" : "keyframes", target.id);
    if (!obj || obj.shotId !== shotId) throw notFound(target.type);
    if (observations.some(o => !DIAGNOSIS[o.kind])) throw bad("未知的质检问题类型");
    const reviewed = [...new Set(review.reviewed ?? [])];
    if (target.type === "take" && reviewed.length && review.fullPlayback !== true) throw bad("视频检查须确认已完整播放当前版本");
    const fingerprint = shotFingerprint(s, shotId);
    const previous = s.list("qc_reports", { targetType: target.type, targetId: target.id }, "created_at DESC, rowid DESC")[0];
    const prior = previous?.evidence?.mediaId === obj.mediaId ? previous.findings.filter((item: any) => DIAGNOSIS[item.kind]) : [];
    const dismissed = review.dismissedKinds ?? [];
    if (dismissed.length && (!review.actor || !review.note?.trim() || !reviewed.length || dismissed.some(kind => !prior.some((item: any) => item.kind === kind)))) throw bad("排除旧告警须逐项选择，并记录复核依据");
    // 重新提交空观察不能抹除同一素材的缺陷；规格变更也不能修复已经生成的视频。
    observations = [...observations, ...prior.filter((item: any) => !dismissed.includes(item.kind) && !observations.some(o => o.kind === item.kind)).map((item: any) => ({ kind: item.kind, note: item.note }))];
    // 观察说明只在标了问题时必填（由检查接口校验）；"看过、没问题"的确认不要求逐条写字。
    if (reviewed.length && (!review.actor || reviewed.some(key => !realismChecks.includes(key as any)))) throw bad("人工检查须记录检查项和检查者");
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
    const complete = realismChecks.filter(key => target.type === "take" || key !== "motion").every(key => reviewed.includes(key));
    const score = complete ? Math.max(0, 100 - findings.reduce((a, f) => a + f.penalty, 0)) : null;
    const evidence = { reviewed, note: review.note ?? "", actor: review.actor, mediaId: obj.mediaId, fingerprint, vision: review.vision ?? null, observedStateDelta: review.observedStateDelta, fullPlayback: review.fullPlayback === true, dismissedKinds: dismissed, previousReportId: previous?.id };
    const report = s.insert("qc_reports", { project_id: shot.projectId, shot_id: shotId, target_type: target.type, target_id: target.id, score, findings, evidence });
    const actions = findings.map((f) => s.insert("repair_actions", { project_id: shot.projectId, qc_report_id: report.id, shot_id: shotId, action: f.action, cause: f.cause, detail: f.detail, status: "suggested" }));
    return { report: { id: report.id, score, findings, evidence }, repairActions: actions.map((a) => ({ id: a.id, action: a.action, cause: a.cause, detail: a.detail, status: a.status })) };
}

/** Apply a repair: creates a NEW variant/take (old ones are kept) with the fix expressed in structured form. */
export function applyRepair(s: Scope, repairId: string, actor: string) {
    const r = s.get("repair_actions", repairId);
    if (!r) throw notFound("repair action");
    const qc = s.get("qc_reports", r.qcReportId);
    const video = qc?.targetType === "take";
    const lock = ["identity_drift", "reference_replace"].includes(r.action) ? ["IDENTITY at weight 1.0 — do not alter facial geometry"] : r.action === "geometry_lock" || r.action === "environment_lock" ? ["geometry of environment and key props — do not alter layout"] : [];
    const o = { repair: { addLock: lock, note: r.detail }, count: video ? 1 : 2 };
    const policy = r.action === "switch_model" ? { disabledModelIds: qc ? [(s.get(video ? "takes" : "keyframes", qc.targetId) as any)?.meta?.modelId].filter(Boolean) : [] } : undefined;
    let res: any;
    if (r.action === "look_normalization") return normalizeLook(s, r);
    // 局部缺陷改为真实排单：整帧重绘 + 其余元素锁定，结果作为新关键帧走人工验收。
    if (r.action === "inpaint_local" && qc?.targetType === "keyframe") {
        const kind = qc.findings.find((f: any) => f.action === "inpaint_local")?.kind ?? "face_artifact";
        const out = scheduleLocalRepair(s, { keyframeId: qc.targetId, kind, actor, note: r.detail }, { policy });
        s.update("repair_actions", repairId, { status: "applied" });
        return { applied: true, ...out };
    }
    if (["inpaint_local"].includes(r.action)) return { applied: false, manual: true, message: "视频局部修复需要逐帧遮罩，当前供应商不支持；请改为更换该 Take 或重新生成整段", repairActionId: r.id };
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
