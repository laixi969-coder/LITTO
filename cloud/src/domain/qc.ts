import { type Scope } from "../db.ts";
import { notFound } from "../util.ts";
import { checkSequence } from "./continuity.ts";
import { generateKeyframes, generateTakes } from "./lifecycle.ts";
import { realismChecks, shotFingerprint, techniqueReviewSchema, takeCoverageIssue } from "./realism.ts";
import { scheduleLocalRepair } from "./localRepair.ts";
import { qualityReviewPlan, coversSpeechRanges } from "@toonflow/tool-media-generation/runtime";
import { bad } from "../util.ts";

/** QC never returns just a score: every finding carries a cause and a concrete Repair Action (PRD §20). */
const DIAGNOSIS: Record<string, { cause: string; action: string; detail: string; penalty: number; severity: "high" | "medium" | "low" }> = {
    speechCoverage: { cause: "实际视频未覆盖当前对白和剪入时长", action: "dialogueRevise", detail: "保留旧素材与原句，对照真实配音重新安排可用画面；规划通过不能代替成片通过，不加速、删句、定格或跨镜挪音补时长，也不自动付费重试", penalty: 25, severity: "high" },
    narrativeFailure: { cause: "剧情因果或信息揭示不成立", action: "storyRevise", detail: "先 readStoryImpact 定位源场次和关联镜头，修改故事后只重做受影响段落", penalty: 25, severity: "high" },
    dialogueMismatch: { cause: "对白缺漏、错词或说话人错误", action: "dialogueRevise", detail: "读取源台词与 readVoice，对照实际声音；修正对应句和口型候选，不重做无关画面", penalty: 25, severity: "high" },
    editingPace: { cause: "剪辑入出点导致拖沓或反应被截断", action: "editTrim", detail: "readEdit 定位片段，用 previewCut 和 editTimeline 的 set_cut/trim_clip 修正实际入出点，保留完整对白与有效反应", penalty: 15, severity: "medium" },
    soundMasking: { cause: "音乐或效果掩盖对白和关键声音", action: "soundMix", detail: "readEdit 后用 editTimeline 的 set_gain/set_duck 调整已有声音；缺少音效才用 soundCues 添加真实素材", penalty: 15, severity: "medium" },
    creativeMismatch: { cause: "造型或动作未达到本镜创作目标", action: "directionRevise", detail: "先对照创作目标修订妆造资产或攻防编排，再检查新候选；不把无变形、身份一致或生成成功当作创作质量通过", penalty: 25, severity: "high" },
    anatomy_failure: { cause: "肢体增减、身体结构或遮挡关系错误", action: "motion_regenerate", detail: "定位多肢、消失或穿透的时间段，拒绝该候选；保持身份，简化为一次完整动作并重新生成，完整播放复核", penalty: 40, severity: "high" },
    wardrobe_drift: { cause: "服装或商品形状与锁定参考不一致", action: "geometry_lock", detail: "核对实际商品参考、裤长、腰头、缝线与服装状态；更换不一致镜头，不用转场掩盖", penalty: 30, severity: "high" },
    plastic_surface: { cause: "皮肤或材质呈塑料感、统一磨皮", action: "material_reference", detail: "核对材质与光照参考，修正表面粗糙度、局部纹理与高光响应；保留身份后另出关键帧，不靠叠加锐化补救", penalty: 25, severity: "high" },
    imaging_failure: { cause: "曝光、焦平面或光学表现不可信", action: "imaging_revise", detail: "核对实景光源、曝光主体、高光滚降、暗部和景深，调整摄影规格后另出候选", penalty: 20, severity: "high" },
    temporal_drift: { cause: "视频材质、身份或空间随时间漂移", action: "motion_regenerate", detail: "标记出错时间段，锁定 Hero 和身份/环境参考，简化该段动作后生成新 Take", penalty: 25, severity: "high" },
    performance_failure: { cause: "表演或摄影机运动缺少动机", action: "performance_revise", detail: "重写可观察的反应、动作与收势节拍，明确走位和摄影机动机，再生成新 Take", penalty: 20, severity: "high" },
    hand_artifact: { cause: "Local anatomical failure (hands)", action: "inpaint_local", detail: "根据实际图像指定哪一人物、哪只手和缺陷；用原图做定向编辑，保留新候选并检查区域外漂移", penalty: 15, severity: "medium" },
    face_artifact: { cause: "Local anatomical failure (face)", action: "inpaint_local", detail: "指定受影响人物的面部，用原帧做定向编辑；保留身份与表情，不同时重画其他人的脸", penalty: 15, severity: "medium" },
    identity_drift: { cause: "Identity drifted from approved asset", action: "reference_replace", detail: "Re-bind the IDENTITY reference at weight 1.0 (LOCK) and regenerate", penalty: 30, severity: "high" },
    composition_off: { cause: "Composition deviates from the shot spec", action: "composition_ref", detail: "Add a COMPOSITION reference (Hero Frame / sketch) and regenerate", penalty: 15, severity: "medium" },
    motion_physics: { cause: "Implausible motion / physics", action: "motion_regenerate", detail: "Regenerate with motion-director notes (anticipation, weight transfer, inertia) or a PERFORMANCE reference", penalty: 25, severity: "high" },
    scene_structure: { cause: "Space/layout structure broke", action: "geometry_lock", detail: "Lock the Environment geometry (ENVIRONMENT + GEOMETRY references) and regenerate", penalty: 25, severity: "high" },
    color_shift: { cause: "Minor colour/exposure mismatch", action: "look_normalization", detail: "Normalise the look in post; no regeneration needed", penalty: 5, severity: "low" },
    capability_mismatch: { cause: "Model lacks a capability the shot needs", action: "switch_model", detail: "Switch provider/model to one that supports the missing capability", penalty: 20, severity: "medium" },
    deliveryResolution: { cause: "供应商返回的实际分辨率低于请求档位", action: "inspectDelivery", detail: "保留原片并注明实际尺寸；导出放大不能称为原生高分辨率，不自动触发付费重试", penalty: 10, severity: "medium" },
    deliveryUnverified: { cause: "缺少源视频实际尺寸，尚未核验交付档位", action: "inspectDelivery", detail: "用媒体探测读取源视频真实尺寸；不能只按请求中的档位宣称已达到精度，也不自动付费重试", penalty: 0, severity: "medium" },
    logo_distortion: { cause: "Logo/product detail distorted", action: "geometry_lock", detail: "Bind the product GEOMETRY reference at LOCK and regenerate", penalty: 25, severity: "high" },
};
export const OBSERVATION_KINDS = Object.keys(DIAGNOSIS);

export function runQc(s: Scope, shotId: string, target: { type: "keyframe" | "take"; id: string }, observations: { kind: string; note?: string }[] = [], review: { reviewed?: string[]; note?: string; actor?: string; vision?: unknown; observedStateDelta?: Record<string, unknown>; fullPlayback?: boolean; reviewedSegments?: { start: number; end: number }[]; dismissedKinds?: string[]; techniqueReview?: { id: string; verdict: "pass" | "revise"; note: string }[]; audioReview?: { speech: string; lipSync: string; referenceMediaId?: string; inspectionKey?: string; offsetMs?: number; note: string } } = {}) {
    const shot = s.get("shots", shotId);
    if (!shot) throw notFound("shot");
    const obj = s.get(target.type === "take" ? "takes" : "keyframes", target.id);
    if (!obj || obj.shotId !== shotId) throw notFound(target.type);
    if (observations.some(o => !Object.hasOwn(DIAGNOSIS, o.kind))) throw bad(`未知的质检问题类型。observations 只记录实际缺陷，无缺陷传 []，正常表现写入 note 或 creativeReview；不要把 realism、lighting 等检查维度当作缺陷。支持的 kind：${OBSERVATION_KINDS.join("、")}`);
    const reviewed = [...new Set(review.reviewed ?? [])];
    const plan = qualityReviewPlan(shot, target.type);
    const techniqueReview = techniqueReviewSchema.parse(review.techniqueReview ?? []);
    if (new Set(techniqueReview.map(item => item.id)).size !== techniqueReview.length || techniqueReview.some(item => !plan.techniques.some(required => required.id === item.id))) throw bad("技法检查须对应本镜当前检查计划，不能重复或引用无关技法");
    if (target.type === "take" && reviewed.length && plan.techniques.some(item => !techniqueReview.some(check => check.id === item.id))) throw bad("选用技法的视频须逐项填写 techniqueReview 的 id、pass/revise 和真实观察 note；先完整播放，不让用户重做选择确认");
    observations = [...observations, ...techniqueReview.filter(item => item.verdict === "revise").map(item => ({ kind: "creativeMismatch", note: item.note }))];
    if (review.reviewedSegments?.some(range => range.end > (s.get("media", obj.mediaId)?.duration ?? 0))) throw bad("看听区间超出当前素材时长");
    if (review.audioReview && (target.type !== "take" || (review.audioReview.speech === "pass" || review.audioReview.lipSync === "pass") && !(review.fullPlayback || coversSpeechRanges(plan.speechRanges, review.reviewedSegments ?? [])))) throw bad("声音与口型通过须实际看听全部发声区间；局部发现的问题可以记录为 fail");
    if (review.audioReview?.referenceMediaId && (s.get("media", review.audioReview.referenceMediaId)?.projectId !== shot.projectId || !s.get("media", review.audioReview.referenceMediaId)?.mime.startsWith("audio/"))) throw bad("声音参考须为当前项目的真实音频");
    if (plan.fullPlayback && reviewed.length && review.fullPlayback !== true) throw bad("视频检查须确认已完整播放当前版本");
    const fingerprint = shotFingerprint(s, shotId, target.type);
    const previous = s.list("qc_reports", { targetType: target.type, targetId: target.id }, "created_at DESC, rowid DESC")[0];
    const prior = previous?.evidence?.mediaId === obj.mediaId ? previous.findings.filter((item: any) => DIAGNOSIS[item.kind] && !["deliveryUnverified", "speechCoverage"].includes(item.kind)) : [];
    const dismissed = review.dismissedKinds ?? [];
    if (dismissed.length && (!review.actor || !review.note?.trim() || !reviewed.length || dismissed.some(kind => !prior.some((item: any) => item.kind === kind)))) throw bad("排除旧告警须逐项选择，并记录复核依据");
    const sameVersion = previous?.evidence?.mediaId === obj.mediaId && previous.evidence.fingerprint === fingerprint;
    const inspectionKey = (review.vision as { inspectionKey?: string } | undefined)?.inspectionKey;
    if (sameVersion && inspectionKey && inspectionKey === previous.evidence.vision?.inspectionKey) {
        observations = observations.filter(item => !previous.evidence.dismissedKinds?.includes(item.kind));
    }
    // 重新提交空观察不能抹除同一素材的缺陷；规格变更也不能修复已经生成的视频。
    observations = [...observations, ...prior.filter((item: any) => !dismissed.includes(item.kind) && !observations.some(o => o.kind === item.kind)).map((item: any) => ({ kind: item.kind, note: item.note }))];
    // 观察说明只在标了问题时必填（由检查接口校验）；"看过、没问题"的确认不要求逐条写字。
    if (reviewed.length && (!review.actor || reviewed.some(key => !realismChecks.includes(key as any)))) throw bad("人工检查须记录检查项和检查者");
    const findings: any[] = [];
    const media = obj.mediaId ? s.get("media", obj.mediaId) : undefined;
    const coverageIssue = target.type === "take" ? takeCoverageIssue(s, shot, obj) : null;
    if (coverageIssue) findings.push({ kind: "speechCoverage", ...DIAGNOSIS.speechCoverage, note: coverageIssue });
    const requestedResolution = obj.meta?.parameters?.request?.resolution ?? obj.meta?.parameters?.resolution;
    const requestedSide = typeof requestedResolution === "string" ? Number(/^(\d+)p$/i.exec(requestedResolution)?.[1]) : 0;
    if (target.type === "take" && requestedSide && (!media?.width || !media?.height)) {
        findings.push({ kind: "deliveryUnverified", ...DIAGNOSIS.deliveryUnverified, note: `请求 ${requestedResolution}，实际尺寸未知` });
    }
    if (target.type === "take" && !observations.some(item => item.kind === "deliveryResolution") && requestedSide && media && media.width > 0 && media.height > 0 && Math.min(media.width, media.height) < requestedSide) {
        findings.push({ kind: "deliveryResolution", ...DIAGNOSIS.deliveryResolution, note: `请求 ${requestedResolution}，实际 ${media.width}×${media.height}；导出尺寸与源片尺寸须分别说明` });
    }
    // 1. human / vision observations → diagnosis.
    for (const o of observations) {
        const d = DIAGNOSIS[o.kind];
        if (d && !(o.kind === "speechCoverage" && coverageIssue)) findings.push({ kind: o.kind, ...d, note: o.note });
    }
    // 2. automatic: the generation had to degrade a reference role → capability mismatch.
    const refs = (obj.meta?.inputRefs ?? []) as any[];
    const dropped = refs.filter((r) => !r.sent);
    if (dropped.length) findings.push({ kind: "capability_mismatch", ...DIAGNOSIS.capability_mismatch, note: `Reference roles degraded to text: ${dropped.map((r) => r.role).join(", ")}` });
    // 3. continuity issues on this shot.
    const issues = checkSequence(s, shot.sequenceId).filter((i) => i.shotId === shotId);
    for (const i of issues) findings.push({ kind: `continuity:${i.category}`, cause: i.message, action: i.repair.action, detail: i.repair.detail, penalty: i.severity === "high" ? 20 : i.severity === "medium" ? 8 : 3, severity: i.severity });

    const automaticOnly = !reviewed.length && !review.note && !review.observedStateDelta && !review.fullPlayback && !review.reviewedSegments?.length && !dismissed.length;
    const preserve = automaticOnly && sameVersion;
    const evidence = preserve ? { ...previous.evidence, vision: review.vision ?? previous.evidence.vision, previousReportId: previous.id } : { reviewed, note: review.note ?? "", actor: review.actor, mediaId: obj.mediaId, fingerprint, vision: review.vision ?? (sameVersion ? previous.evidence.vision : null), observedStateDelta: review.observedStateDelta, fullPlayback: review.fullPlayback === true, reviewedSegments: review.reviewedSegments ?? [], audioReview: review.audioReview, techniqueReview, dismissedKinds: dismissed, previousReportId: previous?.id };
    const { previousReportId: _previousReportId, ...priorEvidence } = previous?.evidence ?? {};
    const { previousReportId: _currentReportId, ...currentEvidence } = evidence;
    const complete = plan.checks.every(key => evidence.reviewed?.includes(key));
    const score = complete ? Math.max(0, 100 - findings.reduce((a, f) => a + f.penalty, 0)) : null;
    // ACT: 相同结论不重建报告/修复单；纯自动复查不能清空仍有效的人工看听记录。
    if (previous?.evidence?.mediaId === obj.mediaId && previous.evidence.fingerprint === fingerprint
        && JSON.stringify(previous.findings) === JSON.stringify(findings)
        && ((automaticOnly && (!review.vision || JSON.stringify(previous.evidence.vision) === JSON.stringify(review.vision))) || JSON.stringify(priorEvidence) === JSON.stringify(currentEvidence))) {
        const actions = s.list("repair_actions", { qcReportId: previous.id });
        return { report: { id: previous.id, score: previous.score, findings, evidence: previous.evidence }, repairActions: actions.map(a => ({ id: a.id, action: a.action, cause: a.cause, detail: a.detail, status: a.status })) };
    }
    const report = s.insert("qc_reports", { project_id: shot.projectId, shot_id: shotId, target_type: target.type, target_id: target.id, score, findings, evidence });
    const actions = findings.map((f) => s.insert("repair_actions", { project_id: shot.projectId, qc_report_id: report.id, shot_id: shotId, action: f.action, cause: f.cause, detail: f.detail, status: "suggested" }));
    return { report: { id: report.id, score, findings, evidence }, repairActions: actions.map((a) => ({ id: a.id, action: a.action, cause: a.cause, detail: a.detail, status: a.status })) };
}

/** Apply a repair: creates a NEW variant/take (old ones are kept) with the fix expressed in structured form. */
export function applyRepair(s: Scope, repairId: string, actor: string, target?: { assetId?: string; region: string }) {
    const r = s.get("repair_actions", repairId);
    if (!r) throw notFound("repair action");
    if (r.status === "applied") return { applied: true, reused: true, repairActionId: r.id, message: "此修复已执行，复用已有结果，不重复生成" };
    const revisionActions: Record<string, string> = { directionRevise: "updateShot", performance_revise: "updateShot", imaging_revise: "updateShot", inspectDelivery: "inspectQuality", storyRevise: "readStoryImpact", dialogueRevise: "readVoice", editTrim: "readEdit", soundMix: "readEdit" };
    if (revisionActions[r.action]) return { applied: false, manual: true, nextOperation: revisionActions[r.action], shotId: r.shotId, source: s.get("shots", r.shotId)?.source, message: r.detail, repairActionId: r.id };
    const qc = s.get("qc_reports", r.qcReportId);
    const video = qc?.targetType === "take";
    const lock = ["identity_drift", "reference_replace"].includes(r.action) ? ["IDENTITY at weight 1.0 — do not alter facial geometry"] : r.action === "geometry_lock" || r.action === "environment_lock" ? ["geometry of environment and key props — do not alter layout"] : [];
    const o = { repair: { addLock: lock, note: r.detail }, count: 1 };
    const policy = r.action === "switch_model" ? { disabledModelIds: qc ? [(s.get(video ? "takes" : "keyframes", qc.targetId) as any)?.meta?.modelId].filter(Boolean) : [] } : undefined;
    let res: any;
    if (r.action === "look_normalization") return normalizeLook(s, r);
    // 按当前修复单定位缺陷，不能把同一报告的第一条脸部问题用于之后的手部修复。
    if (r.action === "inpaint_local" && qc?.targetType === "keyframe") {
        const findings = qc.findings.filter((f: any) => f.action === r.action && f.cause === r.cause && f.detail === r.detail);
        if (!findings.length || new Set(findings.map((f: any) => f.kind)).size !== 1) throw bad("原修复问题已无法匹配，请重新查看当前图像，不猜测修复部位");
        const out = scheduleLocalRepair(s, { keyframeId: qc.targetId, kind: findings[0].kind, actor, target, note: findings.length === 1 ? findings[0].note : undefined }, { policy });
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
