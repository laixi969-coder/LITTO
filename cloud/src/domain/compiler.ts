import { bad } from "../util.ts";
import { all, get, type Scope } from "../db.ts";
import { statesOf } from "./state.ts";
import { route, type Policy } from "../providers/router.ts";
import { modelView } from "../providers/registry.ts";
import { ensureCropMedia, viewOf } from "./panorama.ts";
import { ensureReferenceCrop } from "./referenceCrop.ts";
import { lookSchema, validateMusicVideoTiming } from "./schema.ts";
import type { ShotInput } from "./schema.ts";

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
const photographicRendering = "For photographic or live-action imagery, render the entire frame as one coherent photographed scene, including landscapes and empty environments. Use the scene's actual light sources, consistent light direction, exposure, bounce light, occlusion and contact shadows across subjects and surroundings. Preserve material-specific roughness and highlights: skin, cloth, paper, foliage, soil, stone, concrete and metal must not share a uniform glossy or smoothed finish. Keep fine detail appropriate to focus, distance and atmospheric depth; distant scenery is not as crisp or contrasty as the foreground. Retain natural, non-repeating variation in vegetation and surfaces without inventing damage or clutter. Grade highlights and color transitions without clipped golden saturation, HDR halos or uniformly glowing surfaces. For people, preserve specified age, identity, natural skin tone variation and scale-appropriate texture; clean, energetic or well-groomed does not mean de-aged or poreless. Respect intentional makeup and soft light without erasing anatomy or material response. Do not simulate realism by adding wrinkles, dirt, damage, grain or sharpening. Explicit illustration, animation and other stylized media retain their chosen rendering rules.";

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

export function compileWorkspacePrompt(s: Scope, projectId: string, prompt: string) {
  if (!s.get("projects", projectId)) throw bad("生成项目不存在");
  const world = s.list("worlds", { projectId })[0];
  const look = effectiveLook(s, projectId);
  return renderCompiledPrompt({
    request: prompt,
    projectVisualContext: `Inherit these project defaults unless the request explicitly changes the medium or scene. Do not relocate the requested scene or change its time of day to match a style reference. ${JSON.stringify({ medium: world?.realism, materials: world?.material, look })}`,
    renderingStandard: photographicRendering,
    referenceUse: "Use each supplied reference only for its stated role. Identity references preserve identity, not baked-in lighting or skin smoothing. Look references inform material and photographic response, not copied locations, costumes or time of day. A text description is not an image reference; do not invent missing reference content.",
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
    const shot = s.get("shots", shotId)!;
    validateMusicVideoTiming(shot as ShotInput);
    const proj = shot.projectId;
    const world = s.list("worlds", { projectId: proj })[0] as any;
    const look = effectiveLook(s, proj, shot.sequenceId, shotId);
    const assets = (shot.assetIds as string[]).map((id) => s.get("assets", id)).filter(Boolean) as any[];
    const bindings = s.list("reference_bindings", { targetType: "shot", targetId: shotId }) as any[];
    const model = modelView(get("SELECT * FROM models WHERE id=?", modelId)!);
    const caps = model.capabilities;
    const { start } = statesOf(s, shotId);
    const warnings: string[] = [];
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
    const lock: string[] = [...(shot.freedomMap?.LOCK ?? [])];
    for (const a of assets) {
        if (a.approvalStatus === "approved") lock.push(...(a.invariants ?? []).map((i: string) => `${a.name}: ${i}`));
    }
    lock.push(...(extra.repair?.addLock ?? []));
    const freedom = { LOCK: [...new Set(lock)], CONTROL: shot.freedomMap?.CONTROL?.length ? shot.freedomMap.CONTROL : ["composition", "focal length", "action", "camera move", "lighting"], ALLOW: shot.freedomMap?.ALLOW?.length ? shot.freedomMap.ALLOW : ["natural cloth creases", "micro-expressions", "subtle hair movement"], RANDOM: shot.freedomMap?.RANDOM?.length ? shot.freedomMap.RANDOM : [] };

    let sections: Record<string, string> = {
        shotDesign: cam.design ? `${kind === "image" ? "Render only the single start state; end, paths and timing are continuity context, not multiple panels. " : ""}${JSON.stringify(cam.design)}` : "",
        motionTiming: kind === "video" ? J([
            cam.design?.timing && `Action timing: ${cam.design.timing}`,
            shot.performance?.timing && `Performance timing: ${shot.performance.timing}`,
            "Follow the specified action beats and playback speed. Cinematic scale and heavy mass do not imply slow motion. Do not stretch one brief contact or pose across the entire requested duration. Preserve the specified preparation, contact, reaction and follow-through; camera movement must not replace subject movement. Slow motion, freeze frames and internal cuts require explicit direction. A planned edit is not an instruction to cut inside this generated shot",
        ]) : "",
        subject: J(assets.map((a) => `${a.name} (${a.type}${a.description ? ": " + clean(a.description, a.name) : ""})`)),
        assetDetails: J(assets.filter(a => Object.keys(a.attributes ?? {}).length).map(a => `${a.name}: ${JSON.stringify(a.attributes)}`)),
        narrative: shot.narrativeFunction,
        action: clean(shot.action || shot.title, "action"),
        performance: J([shot.performance?.emotion && `emotion ${shot.performance.emotion} @ ${shot.performance.intensity}`, shot.performance?.eyeline && `eyeline ${shot.performance.eyeline}`, shot.performance?.lookTarget && `looking at ${shot.performance.lookTarget}`, shot.performance?.gesture && `gesture ${shot.performance.gesture}`, shot.performance?.timing && `timing ${shot.performance.timing}`]),
        blocking: J([shot.blocking?.foreground && `foreground: ${shot.blocking.foreground}`, shot.blocking?.midground && `midground: ${shot.blocking.midground}`, shot.blocking?.background && `background: ${shot.blocking.background}`]),
        view: viewText,
        camera: J([`${cam.shotSize} shot`, `${cam.lensMm}mm lens`, cam.height && `${cam.height} height`, cam.angle && `${cam.angle} angle`, cam.position && `from ${cam.position}`, cam.depth && `${cam.depth} depth of field`, cam.axisCrossing && `motivated axis crossing: ${cam.axisCrossing}`, cam.focus && `focus on ${cam.focus}`, kind === "video" && `camera ${cam.motion}${cam.motivation ? ` (${cam.motivation})` : ""}`]),
        lighting: J([lt.worldSource && `fixed world light source: ${lt.worldSource}`, lt.keyDirection && lt.keyDirection !== "none" && `key direction ${lt.keyDirection} in ${lt.directionSpace ?? "screen"} coordinates`, lt.motivatedLight && `motivated by ${lt.motivatedLight}`, lt.key && `key: ${lt.key}`, lt.fill && `fill: ${lt.fill}`, lt.negativeFill && `negative fill: ${lt.negativeFill}`, lt.practicals?.length && `practicals: ${lt.practicals.join(", ")}`, lt.exposure && `exposure: ${lt.exposure}`, lt.timeOfDay && `${lt.timeOfDay}`, lt.colorTemp]),
        world: world ? J([world.realism && `medium: ${world.realism}`, world.era, world.locationLogic, world.architecture, world.weather && `weather: ${world.weather}`, world.time, world.material && `materials: ${world.material}`, `physics: ${world.physics}`, ...(world.environmentalConstraints ?? [])]) : "",
        look: J([look.contrast && `contrast ${look.contrast}`, look.saturation && `saturation ${look.saturation}`, look.palette.length > 0 && `palette ${look.palette.join("/")}`, look.skinTone && `skin ${look.skinTone}`, look.blackLevel && `blacks ${look.blackLevel}`, look.highlightRolloff && `highlight roll-off ${look.highlightRolloff}`, look.grain && `grain ${look.grain}`, look.halation && `halation ${look.halation}`, look.lensCharacter && `lens character ${look.lensCharacter}`]),
        // Realism stack: concrete behaviours instead of adjectives.
        realism: J(Object.entries(shot.realism ?? {}).filter(([key, value]) => value && (kind === "video" || key !== "motion")).map(([key, value]) => `${key}: ${clean(String(value), `realism.${key}`)}`)),
        renderingStandard: photographicRendering,
        constraints: J(shot.constraints ?? []),
        physicalContinuity: J([
            assets.some(a => a.type === "Character") && "Preserve each character's reference anatomy and limb count through the entire action, including occlusions and mirror reflections; movement has preparation, contact, weight transfer and settling",
            assets.some(a => a.type === "Product" || a.type === "Wardrobe") && "Preserve the referenced garment/product silhouette, length, seams, fastening and marks except for explicitly planned changes at their specified action or timeline beat; preserve unaffected details and identity. Cloth deforms locally under actual contact rather than changing design",
            "Keep surface response specific to each material and visible at this shot scale; preserve source-motivated light and contact shadows; do not replace missing texture with sharpening or artificial grain",
        ]),
        state: J([...Object.entries<any>(start.props).filter(([, p]) => p.present).map(([id, p]) => `${p.name ?? id}${p.heldBy ? ` held by ${start.characters[p.heldBy]?.name ?? p.heldBy}` : ""}`), ...Object.entries<any>(start.characters).map(([id, c]) => c.wardrobeId ? `${c.name ?? id} wearing ${start.wardrobe[c.wardrobeId]?.name ?? c.wardrobeId}` : "")]),
        observedState: J(Object.values(start).flatMap(group => Object.values<any>(group).filter(value => value && typeof value === "object" && value.note).map(value => `${value.name ?? "asset"}: ${value.note}`))),
        opticalTexture: look ? J([look.shadowBehavior && `shadows: ${look.shadowBehavior}`, look.texture && `texture: ${look.texture}`, look.sharpnessPhilosophy && `sharpness: ${look.sharpnessPhilosophy}`, look.bloom && `bloom: ${look.bloom}`]) : "",
        referenceIntent: J(bindings.filter(b => b.notes).map(b => `${b.referenceId} (${b.role}): ${b.notes}`)),
        references: textFallback.join("; "),
        lock: freedom.LOCK.join("; "),
        control: freedom.CONTROL.join("; "),
        allow: J([...freedom.ALLOW, ...assets.flatMap(a => (a.allowedVariations ?? []).map((value: string) => `${a.name}: ${value}`))]),
        random: freedom.RANDOM.join("; "),
        forbiddenChanges: J(assets.flatMap(a => (a.forbiddenChanges ?? []).map((value: string) => `${a.name}: ${value}`))),
        assetCondition: "Preserve the condition specified by the story and approved references. When unspecified, use intact, normally maintained surfaces and clean clothing; texture and realism do not imply dirt, wear, rust, damage or poverty. Preserve age-appropriate anatomy and natural torso-to-leg proportions; do not compress limbs to fit the composition.",
        constraintPriority: "Preserve identity and explicit invariants. Current starting continuity state takes precedence over baseline mutable appearance; apply only explicitly planned changes at their action or timeline beat and preserve unaffected details. Allow natural performance without changing identity. Forbidden changes override allowed variations; optional variation must not alter specified action, lighting or continuity.",
        frameContinuity: kind === "video" && extra.startFrameMediaId ? extra.startFrameAsReference
            ? "These are appearance and composition references, not a native locked first frame. Follow the specified action starting state and timing; do not freeze the subjects in the reference poses. Preserve identities, scale and established scene landmarks; references do not imply additional copies of subjects or buildings."
            : "Continue the actual start frame, including action already in progress; do not rewind to repeat an earlier action. World and identity descriptions are context, not instructions to put every mentioned subject on screen. Keep off-screen subjects off screen unless the shot action explicitly calls for their entrance. Preserve the established subject scale relative to buildings and other subjects; do not invent miniature background versions or duplicates." : "",
        repair: extra.repair?.note ?? "",
    };
    let negativePrompt = J(shotAvoid(freedom));
    const musicVideo = shot.musicVideo as ShotInput["musicVideo"];
    if (kind === "video" && musicVideo) {
        const timeline = musicVideo.timeline.map(item => `【${musicTimecode(item.start)}-${musicTimecode(item.end)}】${item.description}`).join("\n");
        const audio = J([
            musicVideo.audioMode === "sourceTrack" && `原曲从 ${musicVideo.sourceStart}s 起对应本段 0s；最终剪辑沿用同一原曲，不在切镜处重启或重作歌曲`,
            musicVideo.audioMode === "generated" && "按已确认的音乐方案生成本段声音；跨段曲目与声音身份须实际试听核对",
            musicVideo.audioMode === "silent" && "本段不生成声音",
            musicVideo.audioDirection,
        ]);
        const externalModelId = model.limits.workspaceExecution ? JSON.parse(model.externalModelId)[1] : model.externalModelId;
        if (typeof externalModelId === "string" && /(?:^|[/_-])seedance[-_ ]?2[._-]5(?:$|[/_-])/i.test(externalModelId)) {
            // ACT: 只重排已保存的规格，不由编译器编故事。其他模型继续使用通用段落。
            sections = {
                Objective: J([shot.title, sections.narrative, sections.action]),
                "Reference binding": inputs.filter(input => input.sent).map(input => `${input.referenceId}: ${input.role}`).join("; "),
                "Immutable locks": J([sections.lock, sections.constraintPriority]),
                "Target duration": `${shot.generationDuration ?? shot.duration} seconds`,
                Timeline: timeline,
                "Visual direction": J([
                    // ACT: 起始状态用于接戏，不作为禁止本段剧情变化的永久锁。
                    J([sections.state, sections.observedState]) && `Starting continuity state (apply only explicitly planned changes during the shot): ${J([sections.state, sections.observedState])}`,
                    Object.entries(sections).filter(([key]) => !["narrative", "action", "lock", "state", "observedState", "constraintPriority", "forbiddenChanges"].includes(key)).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join("; "),
                ]),
                "Audio direction": audio,
                Preserve: J([sections.lock, "Preserve reference identity and all details not explicitly changed; baseline styling is not a permanent lock on planned costume or makeup changes"]),
                // ACT: 该模型的排除项只经 Avoid 段落表达；独立 negativePrompt 字段对它无效，仍返回给调用方用于模型切换后复用。
                Avoid: J([sections.forbiddenChanges, negativePrompt]),
            };
        } else {
            sections.timeline = timeline;
            sections.audio = audio;
            sections.duration = `${shot.generationDuration ?? shot.duration} seconds`;
        }
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
    if (compiled.inputs.some(ref => !ref.sent && ref.lockLevel === "LOCK")) throw bad("当前模型无法发送锁定参考，请更换模式或模型");
    const missing = compiled.warnings.filter(warning => warning.startsWith("未填写真实感规格"));
    if (missing.length) throw bad(missing.join("；"));
}
