import { bad, notFound } from "../util.ts";
import { all, get, type Scope } from "../db.ts";
import { validateVisibleAssets } from "./shots.ts";
import { statesOf, validateStateDelta } from "./state.ts";
import { route, type Policy } from "../providers/router.ts";
import { modelView } from "../providers/registry.ts";
import { ensureCropMedia, viewOf } from "./panorama.ts";
import { ensureReferenceCrop } from "./referenceCrop.ts";
import { lookSchema, validateMusicVideoTiming } from "./schema.ts";
import type { ShotInput } from "./schema.ts";
import { creativeDirectionIssues } from "./creativeDirection.ts";
import { adContext, adShotIssues } from "./adDirection.ts";
import { checkPair } from "./continuity.ts";
import { physicalInteractionPlan, videoMotionTiming } from "@toonflow/tool-media-generation/runtime";
import { cleanVisualDefaults, characterReferenceUse } from "./visualDefaults.ts";
import { compileTechniqueDirection, techniqueIssues, techniquePlan } from "@toonflow/tool-media-generation/filmTechniques";
import { speechPlanningIssues } from "./speechPlanning.ts";

const FLUFF = /\b(8k|4k|ultra[- ]?realistic|hyper[- ]?realistic|photorealistic|cinematic|masterpiece|perfect|best quality|highly detailed)\b/gi;
/** "8K / ultra realistic / cinematic / perfect" are not a realism strategy (PRD §11). Strip them and report. */
export function stripFluff(text: string) {
    const removed: string[] = [];
    const clean = (text ?? "").replace(FLUFF, (m) => (removed.push(m), "")).replace(/\s{2,}/g, " ").trim();
    return { clean, removed };
}

const J = (xs: (string | undefined | false)[]) => xs.filter(Boolean).join("; ");

/**
 * 负向词针对可信度硬伤，而不是通用画质词。
 * 画质压制（worst quality / lowres）会把皮肤和材质一并压平，
 * 与渲染标准要求的「按景别保留纹理」直接冲突，因此不采用。
 */
export const anatomyAndMaterialAvoid = [
    "extra fingers, fused or duplicated limbs, missing limbs",
    "warped or asymmetric hands, malformed hands",
    "limbs merging into or passing through other bodies or objects",
    "plastic or waxy skin, uniform glossy sheen across skin, cloth and surfaces",
    "poreless airbrushed faces, over-sharpened halos, painterly smoothing",
    "skin, cloth, foliage, stone and metal sharing one identical finish",
    "text artifacts, garbled letters, watermark, signature",
];
const shotAvoid = (freedom: Record<string, string[]>) => [
    ...anatomyAndMaterialAvoid,
    "identity drift from the identity reference",
    "floating objects, objects appearing without a cause",
    ...(freedom.LOCK.length ? ["changes to locked elements"] : []),
];


export type Compiled = {
    prompt: string; negativePrompt: string;
    inputs: { referenceId: string; mediaId: string | null; text?: string; role: string; weight: number; lockLevel: string; sent: boolean }[];
    degradations: { role: string; strategy: string }[]; warnings: string[]; freedomMap: Record<string, string[]>; sections: Record<string, string>;
    /** 同一镜头重跑时复用该种子，得到同机位变体，只改变被修改的条件。 */
    seed?: number;
};

export function renderCompiledPrompt(sections: Record<string, string>) {
    const seedanceMusicVideo = "Objective" in sections;
    return Object.entries(sections).filter(([, value]) => value).map(([key, value]) => `${seedanceMusicVideo ? key : key.toUpperCase()}: ${value}`).join("\n");
}

// ACT: 同一渲染约束用于自由生成与镜头编译；只约束已选写实媒介，不将插画/动画改成摄影。
const photographicRendering = "Keep the chosen medium. For photography, use coherent source lighting, contact shadows, material-specific roughness and scale-appropriate texture; preserve natural skin detail without smoothing or artificial sharpening.";

function effectiveLook(s: Scope, projectId: string, sequenceId?: string, shotId?: string) {
  const looks = s.list("looks", { projectId });
  const result: Record<string, unknown> = {};
  for (const layer of [
    looks.find(item => item.scope === "project"),
    sequenceId ? looks.find(item => item.scope === "sequence" && item.scopeId === sequenceId) : undefined,
    shotId ? looks.find(item => item.scope === "shot" && item.scopeId === shotId) : undefined,
  ]) {
    if (!layer) continue;
    // 未填写字段继承上层；显式关闭效果请写 none，不以空字符串清掉项目质感。
    for (const [key, value] of Object.entries(lookSchema.parse(layer))) {
      if (typeof value === "string" ? value.trim() : value.length) result[key] = value;
    }
  }
  return lookSchema.parse(result);
}

export function compileWorkspacePrompt(s: Scope, projectId: string, prompt: string, purpose?: unknown) {
  if (!s.get("projects", projectId)) throw bad("生成项目不存在");
  const world = s.list("worlds", { projectId })[0];
  const look = effectiveLook(s, projectId);
  return renderCompiledPrompt({
    request: prompt,
    projectVisualContext: purpose === "asset"
      ? `Reusable identity reference. Use a simple background and neutral readable light unless explicitly requested otherwise. Preserve only the chosen medium: ${world?.realism ?? "photographic"}. Do not inherit scene lighting, time of day, dramatic grading or story action.`
      : `Inherit these project defaults unless the request explicitly changes the medium or scene. Do not relocate the requested scene or change its time of day to match a style reference. ${JSON.stringify({ medium: world?.realism, materials: world?.material, look })}`,
    renderingStandard: photographicRendering,
    visualDefaults: cleanVisualDefaults,
    referenceUse: characterReferenceUse,
  });
}

function musicTimecode(seconds: number) {
    const rounded = Math.round(seconds * 1000000) / 1000000;
    const remainder = (rounded % 60).toFixed(6).replace(/\.?0+$/, "");
    return `${Math.floor(rounded / 60)}:${Number(remainder) < 10 ? "0" : ""}${remainder}`;
}

/**
 * Prompt is NOT source data. It is compiled from ShotSpec + Skills output + Provider capabilities.
 * Unsupported reference roles degrade to text (explicitly reported), never silently disappear.
 */
export function compileShot(s: Scope, shotId: string, kind: "image" | "video", modelId: string, extra: { startFrameMediaId?: string; startFrameAsReference?: boolean; repair?: { addLock?: string[]; note?: string } } = {}): Compiled {
    const shot = s.get("shots", shotId);
    if (!shot) throw notFound("shot");
    if (shot.generationDuration != null && shot.generationDuration < shot.duration) throw bad("生成时长不能短于计划使用时长");
    validateStateDelta(s, shot.projectId, shot.intendedStateDelta);
    validateVisibleAssets(shot as ShotInput);
    validateMusicVideoTiming(shot as ShotInput);
    const techniqueProblems = techniqueIssues(shot);
    if (techniqueProblems.length) throw bad(techniqueProblems.join("；"));
    const proj = shot.projectId;
    const world = s.list("worlds", { projectId: proj })[0] as any;
    const look = effectiveLook(s, proj, shot.sequenceId, shotId);
    const projectAssets = new Map(s.list("assets", { projectId: proj }).map(asset => [asset.id, asset]));
    const missingAssets = (shot.assetIds as string[]).filter(id => !projectAssets.has(id));
    if (missingAssets.length) throw bad(`镜头资产不存在或不属于当前项目：${missingAssets.join("、")}；请在生成前修正资产引用`);
    // ACT: 旧镜头未标明出镜集合时沿用 assetIds；不凭台词中的画外标记猜测整镜是否出镜。
    const visibleIds = new Set<string>(shot.visibleAssetIds ?? shot.assetIds);
    const state = statesOf(s, shotId);
    const relevantIds = new Set(visibleIds);
    for (const id of visibleIds) {
        const wardrobeId = state.start.characters[id]?.wardrobeId;
        if (wardrobeId && projectAssets.get(wardrobeId)?.type === "Wardrobe") relevantIds.add(wardrobeId);
    }
    const assets = [...relevantIds].map(id => projectAssets.get(id)!) as any[];
    const bindings = s.list("reference_bindings", { targetType: "shot", targetId: shotId }).filter(binding => {
        if (!["IDENTITY", "WARDROBE", "GEOMETRY", "ENVIRONMENT"].includes(binding.role)) return true;
        const reference = s.get("refs", binding.referenceId);
        const owners = [...projectAssets.values()].filter(asset => asset.references?.includes(binding.referenceId)
            || reference?.mediaId && asset.attributes?.authoritativeReference === reference.mediaId);
        return !owners.length || owners.some(asset => relevantIds.has(asset.id));
    });
    const model = modelView(get("SELECT * FROM models WHERE id=?", modelId)!);
    const caps = model.capabilities;
    // 保留完整状态账本，只投影本镜资产；不把历史人物、全场知情或情绪档案作为画面指令。
    const start = Object.fromEntries(["characters", "wardrobe", "props", "environment"].map(group => [group,
        Object.fromEntries(Object.entries(state.start[group as keyof typeof state.start]).filter(([id]) => relevantIds.has(id)).map(([id, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [id, value];
            const { heldBy, present, ...rest } = value;
            return [id, { ...rest, ...(heldBy && visibleIds.has(heldBy) ? { heldBy: projectAssets.get(heldBy)?.name ?? heldBy } : {}) }];
        })),
    ]));
    const warnings: string[] = [];
    if (kind === "video") warnings.push(...speechPlanningIssues(s, shot).map(issue => `配音规划未完成：${issue}`));
    const previous = s.list("shots", { sequenceId: shot.sequenceId }, "ord").filter(item => item.ord < shot.ord).at(-1);
    const overrides = s.list("continuity_issues", { shotId, status: "overridden" });
    // ACT: 复用后验规则提前提醒，不写质检记录、不把计划当实测；越轴等启发式不作为新增硬门禁。
    const continuity = checkPair(previous ?? null, { ...shot, bindings }, previous ? statesOf(s, previous.id) : null, state, projectAssets);
    warnings.push(...continuity.filter(issue => !overrides.some(item => item.category === issue.category && item.message === issue.message))
        .map(issue => `生成前连续性提醒（${issue.severity}）：${issue.message}；${issue.repair.detail}`));
    warnings.push(...creativeDirectionIssues(shot as ShotInput, shot.assetIds.map((id: string) => projectAssets.get(id)!)).map(issue => `创作准备未完成：${issue}`));
    warnings.push(...adShotIssues(s, shot).map(issue => `创作准备未完成：${issue}`));
    const advertising = adContext(s, shot);
    if (kind === "video" && shot.creativeBrief?.dialogue.mode === "native" && shot.creativeBrief.dialogue.lines.length
        && !model.limits.workspaceExecution && !caps.nativeAudio) warnings.push("创作准备未完成：当前模型没有原生音频能力，不能静默丢弃对白；请选择支持的模型或明确后期配音对口型路径");
    const clean = (t: string, where: string) => {
        const r = stripFluff(t);
        if (r.removed.length) warnings.push(`removed non-actionable terms from ${where}: ${r.removed.join(", ")}`);
        return r.clean;
    };

    const roleCap: Record<string, string> = { IDENTITY: "identityReference", GEOMETRY: "multiReference", WARDROBE: "multiReference", ENVIRONMENT: "multiReference", COMPOSITION: "compositionReference", LIGHTING: "multiReference", LOOK: "multiReference", DEPTH: "depthReference", PANORAMA: "panoramaReference", PERFORMANCE: "motionReference", CAMERA_MOTION: "motionReference", START_FRAME: "image2video", END_FRAME: "startEndFrame", AUDIO: "nativeAudio" };
    const adapter = get("SELECT adapter FROM providers WHERE id=?", model.providerId)?.adapter;
    const maxInputs = adapter === "openai-compatible" && kind === "video" ? 1 : Number(caps.maxInputs ?? 0);
    const degradations: Compiled["degradations"] = [];
    const inputs: Compiled["inputs"] = [];
    let used = kind === "video" && extra.startFrameMediaId ? 1 : 0;
    // 已验收主帧承载视频身份；关键帧生成须实际发送定妆图，不能只把媒体 ID 写进提示词。
    if (!extra.startFrameMediaId) for (const asset of assets) {
        const mediaId = asset.attributes?.authoritativeReference;
        if (!mediaId) continue;
        const media = s.get("media", mediaId);
        if (!media?.mime.startsWith("image/")) throw bad(`${asset.name} 的权威参考图不可用`);
        const role = asset.type === "Character" || asset.type === "Creature" ? "IDENTITY"
            : asset.type === "Wardrobe" ? "WARDROBE" : asset.type === "Environment" ? "ENVIRONMENT" : "GEOMETRY";
        if (inputs.some(input => input.mediaId === mediaId && input.role === role)) continue;
        const sent = !!caps[roleCap[role]] && used < maxInputs && !(adapter === "openai-compatible" && kind === "video");
        inputs.push({ referenceId: `asset:${asset.id}`, mediaId, role, weight: 1, lockLevel: "LOCK", sent });
        if (sent) used++;
        else degradations.push({ role, strategy: `${asset.name}: 当前模型或输入容量无法发送权威参考图` });
    }
    // 已定样镜实际进入静帧生成；视频从已检查的本镜主帧继承影调，避免挤占单首帧模型。
    if (kind === "image") for (const pilot of advertising?.pilots ?? []) {
        if (!pilot.mediaId || inputs.some(input => input.mediaId === pilot.mediaId)) continue;
        const sent = !!caps.multiReference && used < maxInputs;
        inputs.push({ referenceId: `pilot:${pilot.shotId}`, mediaId: pilot.mediaId, role: "LOOK", weight: 0.8, lockLevel: "LOCK", sent });
        if (sent) used++;
        else degradations.push({ role: "LOOK", strategy: "当前模型无法发送已定视觉样镜，请选择支持多参考的模型" });
    }
    const sorted = [...bindings].sort((a, b) => b.weight - a.weight);
    const textFallback: string[] = [];
    for (const b of sorted) {
        if (kind === "video" && extra.startFrameMediaId && b.role === "START_FRAME") continue;
        const ref = s.get("refs", b.referenceId);
        if (!b.crop && inputs.some(input => input.mediaId === ref?.mediaId && input.role === b.role && input.sent)) continue;
        const adapterSupports = !(adapter === "openai-compatible" && kind === "video" && b.role !== "START_FRAME");
        const supported = adapterSupports && !!caps[roleCap[b.role]] && used < maxInputs && ref?.mediaId;
        if (supported) {
            const mediaId = b.crop ? ensureReferenceCrop(s, proj, b.referenceId, b.crop) : ref!.mediaId;
            inputs.push({ referenceId: b.referenceId, mediaId, role: b.role, weight: b.weight, lockLevel: b.lockLevel, sent: true }); used++;
        }
        else {
            const why = !adapterSupports ? "adapter cannot send this role" : !caps[roleCap[b.role]] ? `model lacks ${roleCap[b.role]}` : used >= maxInputs ? "input limit reached" : "reference has no media";
            degradations.push({ role: b.role, strategy: `${why}: ${b.role} expressed as text` });
            textFallback.push(`${b.role.toLowerCase()} reference "${ref?.name ?? ref?.text ?? b.referenceId}"${b.notes ? ` (${b.notes})` : ""}`);
            inputs.push({ referenceId: b.referenceId, mediaId: ref?.mediaId ?? null, text: ref?.text ?? ref?.name, role: b.role, weight: b.weight, lockLevel: b.lockLevel, sent: false });
        }
    }
    // 360° panorama of the shot's Environment: VIEW section + (capability-gated) panorama input + auto perspective crop as COMPOSITION.
    let viewText = "";
    const view = viewOf(shot.camera);
    const envAsset = assets.find((a) => a.type === "Environment" && s.list("reference_bindings", { targetType: "asset", targetId: a.id }).some((b: any) => b.role === "PANORAMA"));
    if (view && envAsset) {
        const pb = (s.list("reference_bindings", { targetType: "asset", targetId: envAsset.id }) as any[]).find((b) => b.role === "PANORAMA")!;
        const pref = s.get("refs", pb.referenceId);
        viewText = `camera inside ${envAsset.name} facing yaw ${view.yaw}° pitch ${view.pitch}°, fov ${view.fov}° — 0° yaw = panorama centre/front, positive = turn right`;
        if (!inputs.some((i) => i.role === "PANORAMA")) {
            if (caps.panoramaReference && used < maxInputs && pref?.mediaId) { inputs.push({ referenceId: pb.referenceId, mediaId: pref.mediaId, role: "PANORAMA", weight: pb.weight, lockLevel: pb.lockLevel, sent: true }); used++; }
            else { degradations.push({ role: "PANORAMA", strategy: "no panorama input: view direction and layout described textually, panorama used as a plain environment reference" }); textFallback.push(`panorama environment "${pref?.name ?? pb.referenceId}"`); }
        }
        if (kind === "image" && caps.compositionReference && used < maxInputs) {
            const crop = ensureCropMedia(s, proj, pb.referenceId, view);
            if (crop.mediaId) { inputs.push({ referenceId: pb.referenceId, mediaId: crop.mediaId, role: "COMPOSITION", weight: 0.8, lockLevel: "CONTROL", sent: true }); used++; }
            else if (crop.warning) warnings.push(crop.warning);
        }
    }
    if (kind === "video" && extra.startFrameMediaId && !inputs.some((i) => i.role === "START_FRAME")) inputs.unshift({ referenceId: "hero", mediaId: extra.startFrameMediaId, role: "START_FRAME", weight: 1, lockLevel: "LOCK", sent: true });

    const cam = shot.camera ?? {}, lt = shot.lighting ?? {};
    const musicVideo = shot.musicVideo as ShotInput["musicVideo"];
    const lock: string[] = [...(shot.freedomMap?.LOCK ?? [])];
    for (const a of assets) {
        if (a.approvalStatus === "approved") lock.push(...(a.invariants ?? []).map((i: string) => `${a.name}: ${i}`));
    }
    lock.push(...(extra.repair?.addLock ?? []));
    const freedom = { LOCK: [...new Set(lock)], CONTROL: shot.freedomMap?.CONTROL?.length ? shot.freedomMap.CONTROL : ["composition", "focal length", "action", "camera move", "lighting"], ALLOW: shot.freedomMap?.ALLOW?.length ? shot.freedomMap.ALLOW : ["natural cloth creases", "micro-expressions", "subtle hair movement"], RANDOM: shot.freedomMap?.RANDOM?.length ? shot.freedomMap.RANDOM : [] };
    const brief = shot.creativeBrief as ShotInput["creativeBrief"];
    const assetName = (id: string) => projectAssets.get(id)?.name ?? id;
    const appearance = assets.flatMap(asset => {
        const attributes = Object.fromEntries(Object.entries(asset.attributes ?? {}).filter(([key]) => !["characterDirection", "authoritativeReference", "authoritativePromotedAt", "importedFrom", "biography", "backstory", "relationships", "voice", "voiceId"].includes(key)));
        return Object.keys(attributes).length ? [`${asset.name}: ${JSON.stringify(attributes)}`] : [];
    });

    let sections: Record<string, string> = {
        creativeIntent: kind === "video" && shot.creativeBrief ? J([shot.creativeBrief.intent, shot.creativeBrief.visualPayoff]) : "",
        combatDesign: kind === "video" && brief?.combat ? J([brief.combat.dramaticTurn, brief.combat.signature,
            ...brief.combat.beats.map(beat => `${assetName(beat.attackerId)}对${assetName(beat.defenderId)}：${beat.action} → ${beat.reaction} → ${beat.endState}；其他人物：${beat.supportingAction}`)]) : "",
        dialogue: kind === "video" && brief?.dialogue.lines.length
            ? `${brief.dialogue.mode === "native" ? "生成以下原文对白及声音，并按要求同步人物口型" : "后期配音及口型处理计划，当前素材不代表声画同步已完成"}：\n${brief.dialogue.lines.map(line => `${musicTimecode(line.start)}–${musicTimecode(line.end)} ${assetName(line.speakerId)}${!visibleIds.has(line.speakerId) ? "（仅画外声音，不出镜）" : ""}说：${JSON.stringify(line.text)}；${line.delivery}；${line.lipSync === "visible" ? "可见嘴部与此句逐字同步" : "画外音，不要求画内人物说此句"}；${line.framing}`).join("\n")}` : "",
        // 整段动作的不变量可能含后续持物或落位；首帧只投影明确起点，视频保留完整约束。
        shotDesign: kind === "image" && cam.design?.start ? `Single starting frame: ${cam.design.start}` : "",
        subject: J([kind === "image" && !!cam.design?.start && "Appearance references only; initial occupancy is defined exclusively by the starting frame, not by this list",
            ...assets.map(a => `${a.name} (${a.type}${a.description ? ": " + clean(a.description, a.name) : ""})`)]),
        assetDetails: J(appearance),
        action: kind === "image" && cam.design?.start ? "Render the specified starting frame only, before subsequent actions and their results." : clean(shot.action || shot.title, "action"),
        performance: kind === "video" ? J([
            shot.performance?.gesture, shot.performance?.timing,
            shot.performance?.eyeline && `eyeline ${shot.performance.eyeline}`,
            shot.performance?.lookTarget && `looking at ${shot.performance.lookTarget}`,
            !shot.performance?.gesture && shot.performance?.emotion && `emotion ${shot.performance.emotion} @ ${shot.performance.intensity}`,
        ]) : "",
        blocking: J([
            Object.values(start).some(group => Object.keys(group).length) && `Inherited continuity for present subjects only; starting-frame occupancy/positions take precedence: ${JSON.stringify(start)}`,
            (kind === "video" || !cam.design?.start) && shot.blocking?.foreground && `foreground: ${shot.blocking.foreground}`,
            (kind === "video" || !cam.design?.start) && shot.blocking?.midground && `midground: ${shot.blocking.midground}`,
            (kind === "video" || !cam.design?.start) && shot.blocking?.background && `background: ${shot.blocking.background}`,
        ]),
        view: viewText,
        camera: J([`${cam.shotSize} shot`, `${cam.lensMm}mm lens`, cam.height && `${cam.height} height`, cam.angle && `${cam.angle} angle`, cam.position && `from ${cam.position}`, cam.depth && `${cam.depth} depth of field`, cam.axisCrossing && `motivated axis crossing: ${cam.axisCrossing}`, cam.focus && `focus on ${cam.focus}`, kind === "video" && `camera ${cam.motion}${cam.motivation ? ` (${cam.motivation})` : ""}`]),
        lighting: J([lt.worldSource && `fixed world light source: ${lt.worldSource}`, lt.keyDirection && lt.keyDirection !== "none" && `key direction ${lt.keyDirection} in ${lt.directionSpace ?? "screen"} coordinates`, lt.motivatedLight && `motivated by ${lt.motivatedLight}`, lt.key && `key: ${lt.key}`, lt.fill && `fill: ${lt.fill}`, lt.negativeFill && `negative fill: ${lt.negativeFill}`, lt.practicals?.length && `practicals: ${lt.practicals.join(", ")}`, lt.exposure && `exposure: ${lt.exposure}`, lt.timeOfDay && `${lt.timeOfDay}`, lt.colorTemp]),
        world: world ? J([world.realism && `medium: ${world.realism}`, world.era, world.locationLogic, world.architecture, world.weather && `weather: ${world.weather}`, world.time, world.material && `materials: ${world.material}`, `physics: ${world.physics}`, ...(world.environmentalConstraints ?? [])]) : "",
        look: J([look.contrast && `contrast ${look.contrast}`, look.saturation && `saturation ${look.saturation}`, look.palette.length > 0 && `palette ${look.palette.join("/")}`, look.skinTone && `skin ${look.skinTone}`, look.blackLevel && `blacks ${look.blackLevel}`, look.highlightRolloff && `highlight roll-off ${look.highlightRolloff}`, look.grain && `grain ${look.grain}`, look.halation && `halation ${look.halation}`, look.lensCharacter && `lens character ${look.lensCharacter}`]),
        // Realism stack: concrete behaviours instead of adjectives.
        realism: J(Object.entries(shot.realism ?? {}).filter(([key, value]) => value && (kind === "video" || key !== "motion")).map(([key, value]) => `${key}: ${clean(String(value), `realism.${key}`)}`)),
        renderingStandard: photographicRendering,
        constraints: J(shot.constraints ?? []),
        physicalContinuity: kind === "video" ? "Keep anatomy and object geometry stable; show contact, weight transfer and the resulting motion at the planned speed." : "",
        opticalTexture: look ? J([look.shadowBehavior && `shadows: ${look.shadowBehavior}`, look.texture && `texture: ${look.texture}`, look.sharpnessPhilosophy && `sharpness: ${look.sharpnessPhilosophy}`, look.bloom && `bloom: ${look.bloom}`]) : "",
        referenceIntent: J(bindings.filter(b => b.notes).map(b => `${b.referenceId} (${b.role}): ${b.notes}`)),
        references: textFallback.join("; "),
        lock: freedom.LOCK.join("; "),
        control: freedom.CONTROL.join("; "),
        allow: J([...freedom.ALLOW, ...assets.flatMap(a => (a.allowedVariations ?? []).map((value: string) => `${a.name}: ${value}`))]),
        random: freedom.RANDOM.join("; "),
        forbiddenChanges: J(assets.flatMap(a => (a.forbiddenChanges ?? []).map((value: string) => `${a.name}: ${value}`))),
        constraintPriority: "Explicit identity and invariants remain fixed. Current continuity overrides baseline mutable appearance; apply planned changes only at their specified beat.",
        frameContinuity: kind === "video" && extra.startFrameMediaId ? extra.startFrameAsReference
            ? "References guide appearance and composition; action starts from this shot's plan, not a frozen reference pose."
            : "Continue the actual first frame without restarting the action. Keep offscreen subjects offscreen until a specified entrance; preserve scale and identity." : "",
        repair: extra.repair?.note ?? "",
    };
    if (kind === "video") {
        // ACT: 时间线是执行节拍的唯一来源；验收标准、备用方案和跨镜剪点留在规格中，不发给生成模型执行。
        sections.shotDesign = cam.design ? J([
            cam.design.start && `Starting state: ${cam.design.start}`,
            cam.design.end && `Ending state: ${cam.design.end}`,
            cam.design.subjectPath !== shot.action && cam.design.subjectPath && `Subject path: ${cam.design.subjectPath}`,
            cam.design.cameraPath && `Camera path: ${cam.design.cameraPath}`,
            cam.design.invariants?.length && `Invariants: ${cam.design.invariants.join("; ")}`,
        ]) : "";
        sections.motionTiming = J([
            musicVideo && "The execution timeline defines the action order, timing and explicitly timed camera changes. Apply untimed path and camera descriptions only where compatible; never introduce an extra action, cut or pause from background context.",
            !musicVideo && cam.design?.timing && `Action timing: ${cam.design.timing}`,
            videoMotionTiming,
        ]);
        sections.allow = J([...(shot.freedomMap?.ALLOW ?? []), ...assets.flatMap(a => (a.allowedVariations ?? []).map((value: string) => `${a.name}: ${value}`))]);
        sections.renderingStandard = photographicRendering;
    }
    let negativePrompt = J(shotAvoid(freedom));
    if (kind === "video" && musicVideo) {
        const timeline = musicVideo.timeline.map(item => `【${musicTimecode(item.start)}-${musicTimecode(item.end)}】${item.description}`).join("\n");
        const audio = J([
            musicVideo.audioMode === "sourceTrack" && `原曲从 ${musicVideo.sourceStart}s 起对应本段 0s；最终剪辑沿用同一原曲，不在切镜处重启或重作歌曲`,
            musicVideo.audioMode === "generated" && "按以下声音设计生成本段声音；未要求音乐时不要自行配乐",
            musicVideo.audioMode === "silent" && "本段不生成声音",
            musicVideo.audioDirection,
        ]);
        const externalModelId = model.limits.workspaceExecution ? JSON.parse(model.externalModelId)[1] : model.externalModelId;
        if (typeof externalModelId === "string" && /(?:^|[/_-])seedance[-_ ]?2[._-]5(?:$|[/_-])/i.test(externalModelId)) {
            // ACT: 只重排已保存的规格，不由编译器编故事。其他模型继续使用通用段落。
            sections = {
                Objective: sections.action,
                "Reference binding": inputs.filter(input => input.sent).map(input => `${input.referenceId}: ${input.role}`).join("; "),
                "Immutable locks": J([sections.lock, sections.constraintPriority]),
                "Target duration": `${shot.generationDuration ?? shot.duration} seconds`,
                Timeline: timeline,
                "Visual direction": J([
                    Object.entries(sections).filter(([key]) => !["narrative", "action", "lock", "state", "observedState", "constraintPriority", "forbiddenChanges"].includes(key)).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join("; "),
                ]),
                "Audio direction": audio,
                Preserve: "Preserve details not explicitly changed by this shot.",
                // ACT: 该模型的排除项只经 Avoid 段落表达；独立 negativePrompt 字段对它无效，仍返回给调用方用于模型切换后复用。
                Avoid: J([sections.forbiddenChanges, negativePrompt]),
            };
        } else {
            sections.timeline = timeline;
            sections.audio = audio;
            sections.duration = `${shot.generationDuration ?? shot.duration} seconds`;
        }
    }
    if (kind === "video" && !("Objective" in sections)) {
        const { action, timeline, motionTiming, frameContinuity, shotDesign, ...context } = sections;
        sections = {
            duration: `${shot.generationDuration ?? shot.duration} seconds`,
            creativeIntent: sections.creativeIntent,
            combatDesign: sections.combatDesign,
            dialogue: sections.dialogue,
            frameContinuity, action, timeline, motionTiming, shotDesign, ...context,
        };
    }
    const externalModelId = model.limits.workspaceExecution ? JSON.parse(model.externalModelId)[1] : model.externalModelId;
    if (kind === "video" && externalModelId === "viduq4-preview") {
        // ACT: Q4 接收自然语言；保留显式规格，把通用教学段落留在导演层，不让其淹没执行节拍。
        // 这只是投喂整理，不表示 Q4 支持逐秒硬控制或 Seedance 的专用声音语法。
        sections = {
            duration: `${shot.generationDuration ?? shot.duration} seconds`,
            creativeIntent: sections.creativeIntent,
            combatDesign: sections.combatDesign,
            dialogue: sections.dialogue,
            action: sections.action,
            timeline: sections.timeline,
            startingFrame: extra.startFrameMediaId ? extra.startFrameAsReference
                ? "参考图用于人物外貌与构图；动作起点按本镜规格执行。"
                : "从首帧正在发生的动作继续，保持画内人物、兵器和空间关系。" : "",
            subjects: J([sections.subject, sections.assetDetails]),
            staging: J([sections.blocking, sections.shotDesign, sections.view]),
            performance: sections.performance,
            camera: sections.camera,
            appearance: J([sections.world, sections.lighting, sections.look, sections.realism, sections.opticalTexture]),
            references: J([sections.referenceIntent, sections.references]),
            audio: sections.audio,
            constraints: J([sections.constraints, sections.lock, sections.repair,
                sections.physicalContinuity, sections.motionTiming, sections.constraintPriority]),
            forbiddenChanges: sections.forbiddenChanges,
            variations: J([...(shot.freedomMap?.CONTROL ?? []), sections.allow, sections.random]),
        };
    }
    const interaction = physicalInteractionPlan(kind === "image" ? { ...shot, musicVideo: undefined } : shot);
    if (interaction.required) {
        sections.objectInteraction = kind === "video" ? interaction.instruction : "Preserve the reference object's geometry, openings and support surfaces. Show the actual interaction opening or contact surface clearly enough to establish the planned action; do not invent an opening or hide impossible contact.";
        warnings.push("物体交互预检：核对参考与起始画面中的真实入口、承托面、尺寸和动作路径；文字约束不代表视觉已核实。结果需检查接近、接触、进入或交接及释放后的承托，无法看清时不得记为通过。");
    }
    // 整片弧线和参考研究留给导演；执行只取当前节拍及已采用的统一视觉关系。
    if (advertising?.direction) {
        const direction = advertising.direction;
        const beat = direction.emotionalArc.find((beat: { id: string }) => beat.id === shot.advertising?.beatId);
        const { motion, ...appearanceRules } = direction.visualRules;
        sections.adDirection = JSON.stringify({ visualRules: kind === "video" ? direction.visualRules : appearanceRules, avoid: direction.avoid,
            beat: kind === "video" && beat ? { visibleAction: beat.visibleAction, productBeat: beat.productBeat, sound: beat.sound } : undefined,
            productRead: shot.advertising?.productRead,
        });
    }
    sections["Objective" in sections ? "Visual defaults" : "visualDefaults"] = cleanVisualDefaults;
    if (inputs.length || assets.some(asset => asset.type === "Character" || asset.type === "Creature")) {
        sections["Objective" in sections ? "Reference roles" : "referenceUse"] = characterReferenceUse;
    }
    const techniqueDirection = compileTechniqueDirection(shot, kind);
    if (kind === "video" && brief?.dialogue.lines.length) sections.speechCoverage = brief.dialogue.lines.map((line, index) => {
        const media = line.audio && s.get("media", line.audio.mediaId);
        return `第${index + 1}句 ${assetName(line.speakerId)}：${media?.duration ? `原速配音实测 ${media.duration}s；` : "声音时长尚未实测；"}${line.lipSync === "visible"
            ? (line.coverage ?? []).map(range => `${range.start}–${range.end}s：${range.description}；保持说话者完整嘴部可见，不提前切离`).join("；") || "可见嘴部的完整覆盖尚未设计"
            : "既定画外声，画内人物不冒认此句"}`;
    }).join("\n");
    if (techniqueDirection) sections["Objective" in sections ? "Selected techniques" : "selectedTechniques"] = techniqueDirection;
    // 剪辑、声音和叙事仍交各自真实流程，不当作单镜视觉动作；返回待执行项目供导演继续。
    for (const stage of ["edit", "audio", "story"] as const) {
        const planned = techniquePlan(shot, stage);
        if (planned.length) warnings.push(`${stage} 技法须在对应实际流程落实并于定稿完整看听检查：${planned.map(item => item.label).join("、")}；当前视觉生成不代表已完成。`);
    }
    const prompt = renderCompiledPrompt(sections);
    for (const key of ["surface", "imaging", "world", "cinematic", ...(kind === "video" ? ["motion"] : [])]) {
        if (!shot.realism?.[key]?.trim()) warnings.push(`未填写真实感规格：${key}`);
    }
    return { prompt, negativePrompt, inputs, degradations, warnings, freedomMap: freedom, sections };
}
void all; void route;
export type { Policy };

export function requireCompiledInputs(compiled: Compiled) {
    const missing = compiled.warnings.filter(warning => warning.startsWith("未填写真实感规格") || warning.startsWith("创作准备未完成："));
    if (compiled.inputs.some(ref => !ref.sent && ref.lockLevel === "LOCK")) missing.push("当前模型无法发送锁定参考，请更换模式或模型");
    if (missing.length) throw bad([...new Set(missing)].join("；"));
}
