import { all, get, type Scope } from "../db.ts";
import { statesOf } from "./state.ts";
import { route, type Policy } from "../providers/router.ts";
import { modelView } from "../providers/registry.ts";

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

/**
 * Prompt is NOT source data. It is compiled from ShotSpec + Skills output + Provider capabilities.
 * Unsupported reference roles degrade to text (explicitly reported), never silently disappear.
 */
export function compileShot(s: Scope, shotId: string, kind: "image" | "video", modelId: string, extra: { startFrameMediaId?: string; repair?: { addLock?: string[]; note?: string } } = {}): Compiled {
    const shot = s.get("shots", shotId)!;
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

    const roleCap: Record<string, string> = { IDENTITY: "identityReference", GEOMETRY: "multiReference", WARDROBE: "multiReference", ENVIRONMENT: "multiReference", COMPOSITION: "compositionReference", LIGHTING: "multiReference", LOOK: "multiReference", PERFORMANCE: "motionReference", CAMERA_MOTION: "cameraControl", START_FRAME: "image2video", END_FRAME: "startEndFrame", AUDIO: "nativeAudio" };
    const maxInputs = Number(caps.maxInputs ?? 0);
    const degradations: Compiled["degradations"] = [];
    const inputs: Compiled["inputs"] = [];
    let used = 0;
    const sorted = [...bindings].sort((a, b) => b.weight - a.weight);
    const textFallback: string[] = [];
    for (const b of sorted) {
        const ref = s.get("refs", b.referenceId);
        const supported = !!caps[roleCap[b.role]] && used < maxInputs && ref?.mediaId;
        if (supported || (kind === "video" && b.role === "START_FRAME")) { inputs.push({ referenceId: b.referenceId, mediaId: ref?.mediaId ?? null, role: b.role, weight: b.weight, lockLevel: b.lockLevel, sent: true }); used++; }
        else {
            const why = !caps[roleCap[b.role]] ? `model lacks ${roleCap[b.role]}` : used >= maxInputs ? "input limit reached" : "reference has no media";
            degradations.push({ role: b.role, strategy: `${why}: ${b.role} expressed as text` });
            textFallback.push(`${b.role.toLowerCase()} reference "${ref?.name ?? ref?.text ?? b.referenceId}"${b.notes ? ` (${b.notes})` : ""}`);
            inputs.push({ referenceId: b.referenceId, mediaId: ref?.mediaId ?? null, text: ref?.text ?? ref?.name, role: b.role, weight: b.weight, lockLevel: b.lockLevel, sent: false });
        }
    }
    if (kind === "video" && extra.startFrameMediaId && !inputs.some((i) => i.role === "START_FRAME")) inputs.unshift({ referenceId: "hero", mediaId: extra.startFrameMediaId, role: "START_FRAME", weight: 1, lockLevel: "LOCK", sent: true });

    const cam = shot.camera ?? {}, lt = shot.lighting ?? {};
    const lock: string[] = [...(shot.freedomMap?.LOCK ?? [])];
    for (const a of assets) {
        if (a.approvalStatus === "approved") lock.push(...(a.invariants ?? []).map((i: string) => `${a.name}: ${i}`));
    }
    lock.push(...(extra.repair?.addLock ?? []));
    const freedom = { LOCK: [...new Set(lock)], CONTROL: shot.freedomMap?.CONTROL?.length ? shot.freedomMap.CONTROL : ["composition", "focal length", "action", "camera move", "lighting"], ALLOW: shot.freedomMap?.ALLOW?.length ? shot.freedomMap.ALLOW : ["natural cloth creases", "micro-expressions", "subtle hair movement"], RANDOM: shot.freedomMap?.RANDOM?.length ? shot.freedomMap.RANDOM : ["dust motes", "non-critical background", "natural reflections"] };

    const sections: Record<string, string> = {
        subject: J(assets.map((a) => `${a.name} (${a.type}${a.description ? ": " + clean(a.description, a.name) : ""})`)),
        action: clean(shot.action || shot.title, "action"),
        performance: J([shot.performance?.emotion && `emotion ${shot.performance.emotion} @ ${shot.performance.intensity}`, shot.performance?.eyeline && `eyeline ${shot.performance.eyeline}`, shot.performance?.gesture && `gesture ${shot.performance.gesture}`, shot.performance?.timing && `timing ${shot.performance.timing}`]),
        blocking: J([shot.blocking?.foreground && `foreground: ${shot.blocking.foreground}`, shot.blocking?.midground && `midground: ${shot.blocking.midground}`, shot.blocking?.background && `background: ${shot.blocking.background}`]),
        camera: J([`${cam.shotSize} shot`, `${cam.lensMm}mm lens`, cam.height && `${cam.height} height`, cam.angle && `${cam.angle} angle`, cam.position && `from ${cam.position}`, cam.depth && `${cam.depth} depth of field`, cam.focus && `focus on ${cam.focus}`, kind === "video" && `camera ${cam.motion}${cam.motivation ? ` (${cam.motivation})` : ""}`]),
        lighting: J([lt.motivatedLight && `motivated by ${lt.motivatedLight}`, lt.key && `key: ${lt.key}`, lt.fill && `fill: ${lt.fill}`, lt.negativeFill && `negative fill: ${lt.negativeFill}`, lt.practicals?.length && `practicals: ${lt.practicals.join(", ")}`, lt.exposure && `exposure: ${lt.exposure}`, lt.timeOfDay && `${lt.timeOfDay}`, lt.colorTemp]),
        world: world ? J([world.era, world.locationLogic, world.architecture, world.weather && `weather: ${world.weather}`, world.time, world.material && `materials: ${world.material}`, `physics: ${world.physics}`, ...(world.environmentalConstraints ?? [])]) : "",
        look: look ? J([look.contrast && `contrast ${look.contrast}`, look.saturation && `saturation ${look.saturation}`, look.palette?.length && `palette ${look.palette.join("/")}`, look.skinTone && `skin ${look.skinTone}`, look.blackLevel && `blacks ${look.blackLevel}`, look.highlightRolloff && `highlight roll-off ${look.highlightRolloff}`, look.grain && `grain ${look.grain}`, look.halation && `halation ${look.halation}`, look.lensCharacter && `lens character ${look.lensCharacter}`]) : "",
        // Realism stack: concrete behaviours instead of adjectives.
        realism: J([`imaging: exposed for skin, highlights roll off, natural depth of field per ${cam.lensMm}mm`, "surface: real skin pores, fabric weave and material response", "world: gravity, contact shadows, occlusion and correct scale", kind === "video" && "motion: anticipation, weight transfer, inertia and secondary motion"]),
        state: J([...Object.entries<any>(start.props).filter(([, p]) => p.present).map(([id, p]) => `${p.name ?? id}${p.heldBy ? ` held by ${start.characters[p.heldBy]?.name ?? p.heldBy}` : ""}`), ...Object.entries<any>(start.characters).map(([id, c]) => c.wardrobeId ? `${c.name ?? id} wearing ${start.wardrobe[c.wardrobeId]?.name ?? c.wardrobeId}` : "")]),
        references: textFallback.join("; "),
        lock: freedom.LOCK.join("; "),
        repair: extra.repair?.note ?? "",
    };
    const prompt = Object.entries(sections).filter(([, v]) => v).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join("\n");
    const negativePrompt = J(["extra fingers", "warped hands", "identity drift from references", "text artifacts / garbled logos", "floating objects", ...(freedom.LOCK.length ? ["changes to locked elements"] : [])]);
    return { prompt, negativePrompt, inputs, degradations, warnings, freedomMap: freedom, sections };
}
void all; void route;
export type { Policy };
