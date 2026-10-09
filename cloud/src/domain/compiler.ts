import { bad } from "../util.ts";
import { all, get, type Scope } from "../db.ts";
import { statesOf } from "./state.ts";
import { route, type Policy } from "../providers/router.ts";
import { modelView } from "../providers/registry.ts";
import { ensureCropMedia, viewOf } from "./panorama.ts";
import { ensureReferenceCrop } from "./referenceCrop.ts";
import { validateMusicVideoTiming } from "./schema.ts";
import type { ShotInput } from "./schema.ts";

const FLUFF = /\b(8k|4k|ultra[- ]?realistic|hyper[- ]?realistic|photorealistic|cinematic|masterpiece|perfect|best quality|highly detailed)\b/gi;
/** "8K / ultra realistic / cinematic / perfect" are not a realism strategy (PRD §11). Strip them and report. */
export function stripFluff(text: string) {
    const removed: string[] = [];
    const clean = (text ?? "").replace(FLUFF, (m) => (removed.push(m), "")).replace(/\s{2,}/g, " ").trim();
    return { clean, removed };
}

const J = (xs: (string | undefined | false)[]) => xs.filter(Boolean).join("; ");

export type Compiled = {
    prompt: string; negativePrompt: string;
    inputs: { referenceId: string; mediaId: string | null; text?: string; role: string; weight: number; lockLevel: string; sent: boolean }[];
    degradations: { role: string; strategy: string }[]; warnings: string[]; freedomMap: Record<string, string[]>; sections: Record<string, string>;
};

export function renderCompiledPrompt(sections: Record<string, string>) {
    const seedanceMusicVideo = "Objective" in sections;
    return Object.entries(sections).filter(([, value]) => value).map(([key, value]) => `${seedanceMusicVideo ? key : key.toUpperCase()}: ${value}`).join("\n");
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
export function compileShot(s: Scope, shotId: string, kind: "image" | "video", modelId: string, extra: { startFrameMediaId?: string; repair?: { addLock?: string[]; note?: string } } = {}): Compiled {
    const shot = s.get("shots", shotId)!;
    validateMusicVideoTiming(shot as ShotInput);
    const proj = shot.projectId;
    const world = s.list("worlds", { projectId: proj })[0] as any;
    const looks = s.list("looks", { projectId: proj }) as any[];
    const look = looks.find((l) => l.scope === "shot" && l.scopeId === shotId) ?? looks.find((l) => l.scope === "sequence" && l.scopeId === shot.sequenceId) ?? looks.find((l) => l.scope === "project");
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
    const sorted = [...bindings].sort((a, b) => b.weight - a.weight);
    const textFallback: string[] = [];
    for (const b of sorted) {
        if (kind === "video" && extra.startFrameMediaId && b.role === "START_FRAME") continue;
        const ref = s.get("refs", b.referenceId);
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
        look: look ? J([look.contrast && `contrast ${look.contrast}`, look.saturation && `saturation ${look.saturation}`, look.palette?.length && `palette ${look.palette.join("/")}`, look.skinTone && `skin ${look.skinTone}`, look.blackLevel && `blacks ${look.blackLevel}`, look.highlightRolloff && `highlight roll-off ${look.highlightRolloff}`, look.grain && `grain ${look.grain}`, look.halation && `halation ${look.halation}`, look.lensCharacter && `lens character ${look.lensCharacter}`]) : "",
        // Realism stack: concrete behaviours instead of adjectives.
        realism: J(Object.entries(shot.realism ?? {}).filter(([key, value]) => value && (kind === "video" || key !== "motion")).map(([key, value]) => `${key}: ${clean(String(value), `realism.${key}`)}`)),
        constraints: J(shot.constraints ?? []),
        physicalContinuity: J([
            assets.some(a => a.type === "Character") && "Preserve each character's reference anatomy and limb count through the entire action, including occlusions and mirror reflections; movement has preparation, contact, weight transfer and settling",
            assets.some(a => a.type === "Product" || a.type === "Wardrobe") && "Preserve the referenced garment/product silhouette, length, seams, fastening and marks across frames; cloth deforms locally under actual contact rather than changing design",
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
        constraintPriority: "Preserve identity and explicit invariants. Allow natural performance without changing identity. Forbidden changes override allowed variations; optional variation must not alter specified action, lighting or continuity.",
        repair: extra.repair?.note ?? "",
    };
    let negativePrompt = J(["extra fingers", "warped hands", "identity drift from references", "text artifacts / garbled logos", "floating objects", ...(freedom.LOCK.length ? ["changes to locked elements"] : [])]);
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
                "Immutable locks": J([sections.lock, sections.state, sections.observedState, sections.constraintPriority]),
                "Target duration": `${shot.generationDuration ?? shot.duration} seconds`,
                Timeline: timeline,
                "Visual direction": Object.entries(sections).filter(([key]) => !["narrative", "action", "lock", "state", "observedState", "constraintPriority", "forbiddenChanges"].includes(key)).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join("; "),
                "Audio direction": audio,
                Preserve: J([sections.subject, sections.assetDetails, sections.lock]),
                Avoid: J([sections.forbiddenChanges, negativePrompt]),
            };
            negativePrompt = "";
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
