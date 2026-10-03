import { NARRATIVE_FUNCTIONS } from "./schema.ts";

/**
 * Skills output STRUCTURED specs (never just a long prompt). They are deterministic, rule-based experts;
 * an LLM can be layered on top later because the contract (input → spec) does not change.
 */

export type AssetLite = { id: string; name: string; type: string };
export type ShotDraft = {
    title: string; sceneName: string; narrativeFunction: (typeof NARRATIVE_FUNCTIONS)[number]; assetIds: string[]; action: string;
    performance: { emotion: string; intensity: number; eyeline: string; gesture: string; timing: string };
    blocking: { foreground: string; midground: string; background: string };
    camera: { shotSize: string; position: string; height: string; angle: string; lensMm: number; focus: string; depth: string; motion: string; motivation: string; side: "A" | "B" | "none"; screenDirection: "left" | "right" | "none" };
    lighting: { motivatedLight: string; key: string; fill: string; negativeFill: string; practicals: string[]; exposure: string; keyDirection: "left" | "right" | "front" | "back" | "top" | "none"; timeOfDay: string; colorTemp: string };
    intendedStateDelta: Record<string, any>; duration: number; sceneIndex: number;
};

const HEADING = /^\s*((?:INT|EXT|I\/E)[./ ].*|内景.*|外景.*|场景.*|SCENE\b.*)$/i;
const NIGHT = /(night|夜|dusk|黄昏|midnight)/i;
const REVEAL = /(finds?|notices?|discovers?|reveals?|opens?|sees?|spots?|发现|看到|注意到|打开|露出|出现|拿出|掏出)/i;
const CONTRAST = /(but|suddenly|however|instead|然而|突然|可是|但是|却)/i;
const PICKUP = /(picks? up|grabs?|takes?|holds?|拿起|抓起|握住|拿着|带走)/i;
const DROP = /(puts? down|drops?|sets? down|throws?|放下|丢下|扔|摔)/i;
const EMOTION: [RegExp, string, number][] = [
    [/(angry|furious|rage|怒|愤)/i, "anger", 0.85], [/(afraid|terrified|fear|panic|怕|惊恐|恐惧)/i, "fear", 0.8],
    [/(cry|tears|sad|grief|哭|泪|悲)/i, "sadness", 0.7], [/(smile|laugh|happy|joy|笑|开心|喜)/i, "joy", 0.6],
    [/(stare|quiet|silent|still|沉默|凝视|静)/i, "restraint", 0.35],
];

const split = (t: string) => t.split(/(?<=[.!?。！？])\s*/).map((x) => x.trim()).filter(Boolean);

/** Storyboard Director: Script → Sequence → Shots by narrative function (never by full stop). */
export function storyboardDirector(script: string, assets: AssetLite[], opts: { minShots?: number } = {}): ShotDraft[] {
    const minShots = opts.minShots ?? 8;
    type Beat = { text: string; speaker?: string; scene: number; sceneName: string; isDialogue: boolean };
    const beats: Beat[] = [];
    let scene = -1, sceneName = "Scene 1";
    for (const raw of script.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (HEADING.test(line)) { scene++; sceneName = line.replace(/^场景[:：]?/, "").trim(); continue; }
        if (scene < 0) { scene = 0; }
        const dlg = line.match(/^([A-Z][A-Z .'\-]{1,24}|[一-龥]{1,6})\s*[:：]\s*(.+)$/);
        if (dlg) { beats.push({ text: dlg[2], speaker: dlg[1].trim(), scene, sceneName, isDialogue: true }); continue; }
        // Group action sentences into beats: a new beat starts at reveal / contrast / pickup / drop pivots.
        let cur: string[] = [];
        for (const sent of split(line)) {
            const pivot = cur.length && (REVEAL.test(sent) || CONTRAST.test(sent) || PICKUP.test(sent) || DROP.test(sent));
            if (pivot) { beats.push({ text: cur.join(" "), scene, sceneName, isDialogue: false }); cur = []; }
            cur.push(sent);
        }
        if (cur.length) beats.push({ text: cur.join(" "), scene, sceneName, isDialogue: false });
    }
    const named = (t: string) => assets.filter((a) => t.toLowerCase().includes(a.name.toLowerCase()));
    const shots: ShotDraft[] = [];
    let lastScene = -1, prevSpeaker: string | undefined, dialogueFlip = 0;
    const envOf = (sc: number) => shots.find((s) => s.sceneIndex === sc)?.assetIds.filter((id) => assets.find((a) => a.id === id)?.type === "Environment") ?? [];

    for (const b of beats) {
        const found = named(b.text);
        const chars = found.filter((a) => a.type === "Character");
        const isNewScene = b.scene !== lastScene;
        const envs = isNewScene ? assets.filter((a) => a.type === "Environment" && (b.sceneName.toLowerCase().includes(a.name.toLowerCase()) || b.text.toLowerCase().includes(a.name.toLowerCase()))) : [];
        const sceneEnv = isNewScene ? (envs.length ? envs.map((e) => e.id) : (assets.find((a) => a.type === "Environment") ? [assets.find((a) => a.type === "Environment")!.id] : [])) : envOf(b.scene);
        const night = NIGHT.test(b.sceneName);
        const light = { motivatedLight: night ? "practical lamp / moonlight" : "window daylight", key: night ? "low-key warm practical" : "soft window key", fill: night ? "minimal" : "bounce fill", negativeFill: night ? "heavy" : "light", practicals: night ? ["table lamp"] : [], exposure: night ? "low-key, protect highlights" : "normal, protect window highlights", keyDirection: "left" as const, timeOfDay: night ? "night" : "day", colorTemp: night ? "3200K" : "5600K" };
        const emo = EMOTION.find(([re]) => re.test(b.text));
        const base = (fn: ShotDraft["narrativeFunction"], size: string, lens: number, title: string, extra: Partial<ShotDraft> = {}): ShotDraft => ({
            title, sceneName: b.sceneName, narrativeFunction: fn, assetIds: [...new Set([...sceneEnv, ...found.map((a) => a.id)])], action: b.text,
            performance: { emotion: emo?.[1] ?? "neutral", intensity: emo?.[2] ?? 0.4, eyeline: "", gesture: "", timing: "" },
            blocking: { foreground: "", midground: chars[0]?.name ?? "", background: sceneEnv.length ? assets.find((a) => a.id === sceneEnv[0])?.name ?? "" : "" },
            camera: { shotSize: size, position: "", height: "eye level", angle: "neutral", lensMm: lens, focus: "", depth: size === "WS" ? "deep" : "shallow", motion: "static", motivation: "", side: "A", screenDirection: "none" },
            lighting: light, intendedStateDelta: {}, duration: 4, sceneIndex: b.scene, ...extra,
        });
        const delta: Record<string, any> = {};
        for (const p of found.filter((a) => ["Prop", "Product", "Vehicle"].includes(a.type))) {
            if (PICKUP.test(b.text)) delta.props = { ...delta.props, [p.id]: { heldBy: chars[0]?.id ?? "unknown", present: true } };
            else if (DROP.test(b.text)) delta.props = { ...delta.props, [p.id]: { heldBy: null, present: true } };
        }
        if (emo && chars[0]) delta.emotional = { [chars[0].id]: { emotion: emo[1], intensity: emo[2] } };

        if (isNewScene) {
            const prefix = lastScene >= 0 ? "Transition" : "Establish";
            shots.push(base(prefix as any, "WS", 24, `${b.sceneName} — ${prefix === "Transition" ? "transition in" : "establishing"}`, { assetIds: [...sceneEnv], camera: { shotSize: "WS", position: "high corner", height: "above eye level", angle: "neutral", lensMm: 24, focus: "deep", depth: "deep", motion: lastScene >= 0 ? "slow push-in" : "static", motivation: lastScene >= 0 ? "settles the audience into the new place" : "", side: "A", screenDirection: "none" }, intendedStateDelta: {} }));
            lastScene = b.scene;
            dialogueFlip = 0;
            prevSpeaker = undefined;
        }

        if (b.isDialogue) {
            const speaker = assets.find((a) => a.type === "Character" && a.name.toLowerCase() === b.speaker!.toLowerCase());
            const spk = speaker ? [speaker.id] : [];
            const turn = prevSpeaker && prevSpeaker !== b.speaker;
            if (turn) dialogueFlip ^= 1;
            const dir = dialogueFlip ? "left" : "right";
            // Shot–reverse-shot: same side of the axis, opposite eyelines.
            shots.push(base(turn ? "Reaction" : "Rhythm", "MCU", 50, `${b.speaker}: "${b.text.slice(0, 40)}"`, { assetIds: [...new Set([...sceneEnv, ...spk, ...found.map((a) => a.id)])], performance: { emotion: emo?.[1] ?? "neutral", intensity: emo?.[2] ?? 0.45, eyeline: `screen ${dir}`, gesture: "", timing: "on the line" }, camera: { shotSize: "MCU", position: "over-shoulder", height: "eye level", angle: "neutral", lensMm: 50, focus: speaker?.name ?? "", depth: "shallow", motion: "static", motivation: "", side: "A", screenDirection: dir } }));
            prevSpeaker = b.speaker;
            continue;
        }

        let fn: ShotDraft["narrativeFunction"] = "Rhythm";
        if (REVEAL.test(b.text)) fn = "Reveal";
        else if (CONTRAST.test(b.text)) fn = "Contrast";
        else if (shots.length && shots[shots.length - 1].action && PICKUP.test(b.text) && PICKUP.test(shots[shots.length - 1].action)) fn = "Match";
        const size = fn === "Reveal" ? "CU" : fn === "Contrast" ? "MS" : "MWS";
        const lens = fn === "Reveal" ? 85 : fn === "Contrast" ? 35 : 35;
        const motion = fn === "Reveal" ? "slow push-in" : fn === "Contrast" ? "handheld settle" : "static";
        shots.push(base(fn, size, lens, `${b.sceneName} — ${fn.toLowerCase()}: ${b.text.slice(0, 36)}`, { intendedStateDelta: delta, camera: { shotSize: size, position: "", height: "eye level", angle: fn === "Contrast" ? "slightly low" : "neutral", lensMm: lens, focus: chars[0]?.name ?? found[0]?.name ?? "", depth: size === "CU" ? "shallow" : "medium", motion, motivation: motion === "static" ? "" : fn === "Reveal" ? "moves toward what the character notices" : "follows the disturbance", side: "A", screenDirection: "none" } }));
        // Reaction coverage after a Reveal/Contrast beat when a character is present.
        if ((fn === "Reveal" || fn === "Contrast") && chars[0]) shots.push(base("Reaction", "CU", 85, `${chars[0].name} reacts`, { assetIds: [...new Set([...sceneEnv, chars[0].id])], action: `${chars[0].name} reacts to what just happened.`, performance: { emotion: emo?.[1] ?? "tension", intensity: Math.max(0.5, emo?.[2] ?? 0.5), eyeline: "screen right", gesture: "a held breath", timing: "beat after" }, camera: { shotSize: "CU", position: "", height: "eye level", angle: "neutral", lensMm: 85, focus: chars[0].name, depth: "shallow", motion: "static", motivation: "", side: "A", screenDirection: "none" } }));
    }
    // Ensure enough coverage: add inserts (detail) from props until minShots.
    const props = assets.filter((a) => ["Prop", "Product", "Vehicle"].includes(a.type));
    let guard = 0;
    while (shots.length < minShots && shots.length > 0 && guard++ < 20) {
        const idx = shots.findLastIndex((s, i) => i > 0);
        const ref = shots[Math.max(idx, 0)];
        const p = props[guard % Math.max(props.length, 1)];
        const insert: ShotDraft = { ...structuredClone(ref), title: p ? `Insert — ${p.name}` : `Cutaway — ${ref.sceneName}`, narrativeFunction: p ? "Reveal" : "Rhythm", assetIds: [...new Set([...(envOf(ref.sceneIndex)), ...(p ? [p.id] : [])])], action: p ? `Detail of ${p.name}.` : "Cutaway to the surroundings.", intendedStateDelta: {}, camera: { ...ref.camera, shotSize: "ECU", lensMm: 100, depth: "shallow", motion: "static", motivation: "" }, performance: { ...ref.performance, eyeline: "", intensity: 0.3 } };
        shots.splice(shots.indexOf(ref) + 1, 0, insert);
    }
    return shots;
}

export function assetDirector(type: string, name: string, description = "") {
    const common = { forbiddenChanges: ["identity / defining silhouette", "approved colours"], allowedVariations: ["natural lighting response", "minor wrinkles / wear consistent with the world"] };
    const t: Record<string, any> = {
        Character: { views: ["front", "3/4", "profile", "back", "expression sheet (neutral, joy, anger, fear)"], invariants: [`${name}: face geometry and proportions`, "hairline and hair style", "skin tone and age cues", "hands and distinctive marks"], allowedVariations: ["micro-expressions", "natural hair strands"], forbiddenChanges: ["face geometry", "body proportions", "age", "distinctive marks"] },
        Wardrobe: { views: ["front", "back", "fabric macro"], invariants: ["cut / silhouette", "fabric and weave", "colour", "closure details and trim"], allowedVariations: ["natural creasing", "movement of cloth"], forbiddenChanges: ["colour", "silhouette", "logos / trim"] },
        Environment: { views: ["master wide", "reverse wide", "detail of key set dressing"], invariants: ["spatial topology (door/window positions)", "furniture relationships", "materials", "practical light positions"], allowedVariations: ["dust motes", "background extras"], forbiddenChanges: ["room layout", "window / door placement"] },
        Prop: { views: ["front", "side", "top", "scale reference in hand"], invariants: ["geometry and real-world size", "material", "distinctive details / wear"], allowedVariations: ["reflections", "light falloff"], forbiddenChanges: ["shape", "size", "markings"] },
        Product: { views: ["front", "side", "top", "label macro"], invariants: ["geometry and real-world size", "logo and label", "material / finish"], allowedVariations: ["reflections"], forbiddenChanges: ["logo", "proportions", "colourway"] },
        Vehicle: { views: ["front 3/4", "side", "rear 3/4", "interior"], invariants: ["body geometry", "colour / livery", "wear and damage"], allowedVariations: ["reflections", "dust"], forbiddenChanges: ["body shape", "livery"] },
    };
    const x = t[type] ?? { views: ["front"], invariants: [`${name}: defining traits`], ...common };
    return { requiredViews: x.views, invariants: x.invariants, allowedVariations: x.allowedVariations ?? common.allowedVariations, forbiddenChanges: x.forbiddenChanges ?? common.forbiddenChanges, note: description ? `Based on: ${description}` : undefined };
}

export function visualDirector(notes: string) {
    const n = notes.toLowerCase();
    const has = (...w: string[]) => w.some((x) => n.includes(x));
    return {
        look: {
            contrast: has("high contrast", "noir", "harsh") ? "high" : has("flat", "soft") ? "low" : "medium",
            saturation: has("muted", "desaturated", "faded") ? "muted" : has("vivid", "saturated", "neon") ? "rich" : "natural",
            palette: has("teal") ? ["teal", "amber"] : has("noir") ? ["black", "cold white", "amber"] : ["warm neutral", "desaturated green"],
            grain: has("16mm", "film", "grain") ? "visible 16mm-like" : "fine", halation: has("film", "halation") ? "subtle red halation on highlights" : "",
            highlightRolloff: has("film") ? "long, filmic" : "gentle", blackLevel: has("lifted", "faded") ? "lifted" : "rich but not crushed",
        },
        materialLanguage: has("wood") ? "worn wood, matte" : has("metal", "steel") ? "brushed metal, controlled speculars" : "mixed natural materials",
        motifs: [] as string[],
    };
}

export function cinematographer(fn: string, emotion: string, night: boolean) {
    const lens = { Establish: 24, Reveal: 85, Reaction: 85, Contrast: 35, Transition: 28, Match: 50, Rhythm: 50 }[fn] ?? 35;
    return {
        lensMm: lens,
        shotSize: { Establish: "WS", Reveal: "CU", Reaction: "CU", Contrast: "MS", Transition: "WS", Match: "MS", Rhythm: "MCU" }[fn] ?? "MS",
        lighting: { key: night ? "low-key practical" : "soft motivated window", negativeFill: emotion === "fear" || emotion === "anger" ? "heavy" : "light", exposure: night ? "protect highlights, let shadows fall" : "normal" },
        exposureNote: "Expose for skin; keep practicals below clipping; let the sensor noise show in deep shadow.",
        opticalBehavior: "Focus falls off naturally; no artificial sharpening halos; slight lens breathing on rack focus.",
    };
}

export function motionDirector(action: string, duration: number) {
    return {
        anticipation: "Visible wind-up (weight shifts to the back foot / inhale) before the main action.",
        centerOfMass: "Hips lead; head follows with a one-beat delay; weight transfer visible in the planted foot.",
        contact: "Feet and hands make believable contact with surfaces (no floating, no sliding).",
        inertia: "Accelerate and decelerate; objects keep momentum after the hand releases them.",
        secondaryMotion: "Cloth and hair lag the body and settle after movement stops.",
        cameraInertia: "Camera moves ease in and out; handheld has weight, no robotic linearity.",
        timing: `${duration}s: ${Math.round(duration * 0.25)}s anticipation → action → ${Math.round(duration * 0.25)}s settle`,
        action,
    };
}
