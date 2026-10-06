import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const ROLES = ["IDENTITY", "GEOMETRY", "WARDROBE", "ENVIRONMENT", "COMPOSITION", "LIGHTING", "LOOK", "PERFORMANCE", "CAMERA_MOTION", "START_FRAME", "END_FRAME", "AUDIO", "DEPTH", "PANORAMA"] as const;
export const ASSET_TYPES = ["Character", "Wardrobe", "Environment", "Prop", "Product", "Vehicle", "Creature", "Custom"] as const;
export const LOCK_LEVELS = ["LOCK", "CONTROL", "ALLOW", "RANDOM"] as const;
export const NARRATIVE_FUNCTIONS = ["Establish", "Reveal", "Reaction", "Contrast", "Transition", "Match", "Rhythm"] as const;

export const worldSchema = z.object({
    era: z.string().default(""), locationLogic: z.string().default(""), architecture: z.string().default(""), culture: z.string().default(""),
    weather: z.string().default(""), time: z.string().default(""), material: z.string().default(""), physics: z.string().default("real-world"),
    realism: z.string().default("photographic"), environmentalConstraints: z.array(z.string()).default([]),
});

export const lookSchema = z.object({
    contrast: z.string().default(""), saturation: z.string().default(""), palette: z.array(z.string()).default([]), skinTone: z.string().default(""),
    blackLevel: z.string().default(""), highlightRolloff: z.string().default(""), shadowBehavior: z.string().default(""), grain: z.string().default(""),
    halation: z.string().default(""), bloom: z.string().default(""), lensCharacter: z.string().default(""), texture: z.string().default(""),
    sharpnessPhilosophy: z.string().default(""), colorReferenceIds: z.array(z.string()).default([]),
});

export const assetInput = z.object({
    type: z.enum(ASSET_TYPES), name: z.string().min(1).max(120),
    description: z.string().default(""),
    attributes: z.record(z.any()).default({}), // type-specific: faceGeometry, bodyProportion, layout, geometry, fabric ...
    references: z.array(z.string()).default([]), // reference ids
    invariants: z.array(z.string()).default([]),
    allowedVariations: z.array(z.string()).default([]),
    forbiddenChanges: z.array(z.string()).default([]),
});

export const referenceCropSchema = z.object({
    x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(), height: z.number().finite().positive(),
    unit: z.enum(["normalized", "pixels"]).default("normalized"),
}).strict().refine(crop => crop.unit === "pixels"
    ? [crop.x, crop.y, crop.width, crop.height].every(Number.isInteger)
    : crop.x + crop.width <= 1 && crop.y + crop.height <= 1, "裁切区域须在图内，像素坐标须为整数");

export const bindingInput = z.object({
    referenceId: z.string(), role: z.enum(ROLES), weight: z.number().min(0).max(1).default(1),
    lockLevel: z.enum(LOCK_LEVELS).default("CONTROL"), crop: referenceCropSchema.nullable().optional(), notes: z.string().optional(),
});

export const cameraSchema = z.object({
    shotSize: z.string().default("MS"), position: z.string().default(""), height: z.string().default("eye level"), angle: z.string().default("neutral"),
    lensMm: z.number().default(35), focus: z.string().default(""), depth: z.string().default(""), motion: z.string().default("static"), motivation: z.string().default(""),
    axisCrossing: z.string().default(""),
    side: z.enum(["A", "B", "none"]).default("none"), // which side of the 180° axis
    screenDirection: z.enum(["left", "right", "none"]).default("none"),
    // 360° view into the Environment panorama (optional so existing shots stay valid)
    viewYaw: z.number().min(-180).max(180).optional(), viewPitch: z.number().min(-90).max(90).optional(), viewFov: z.number().min(10).max(140).optional(),
});
export const lightingSchema = z.object({
    worldSource: z.string().default(""), directionSpace: z.enum(["screen", "world"]).default("screen"),
    motivatedLight: z.string().default(""), key: z.string().default(""), fill: z.string().default(""), negativeFill: z.string().default(""),
    practicals: z.array(z.string()).default([]), exposure: z.string().default(""), keyDirection: z.enum(["left", "right", "front", "back", "top", "none"]).default("none"),
    timeOfDay: z.string().default(""), colorTemp: z.string().default(""),
});

export const freedomMapSchema = z.object({
    LOCK: z.array(z.string()).default([]), CONTROL: z.array(z.string()).default([]), ALLOW: z.array(z.string()).default([]), RANDOM: z.array(z.string()).default([]),
});

export const shotInput = z.object({
    sequenceId: z.string(), sceneId: z.string().optional(), order: z.number().int().optional(),
    title: z.string().default(""),
    narrativeFunction: z.enum(NARRATIVE_FUNCTIONS).default("Establish"),
    assetIds: z.array(z.string()).default([]),
    action: z.string().default(""), performance: z.object({ emotion: z.string().default(""), intensity: z.number().default(0.5), eyeline: z.string().default(""), lookTarget: z.string().default(""), gesture: z.string().default(""), timing: z.string().default("") }).default({}),
    blocking: z.object({ foreground: z.string().default(""), midground: z.string().default(""), background: z.string().default("") }).default({}),
    camera: cameraSchema.default({}), lighting: lightingSchema.default({}),
    intendedStateDelta: z.record(z.any()).default({}),
    freedomMap: freedomMapSchema.optional(), constraints: z.array(z.string()).default([]),
    duration: z.number().finite().positive().max(3600).default(4),
    generationDuration: z.number().finite().positive().max(3600).optional(),
    inspectionRegion: referenceCropSchema.nullable().optional(),
    subtitle: z.string().default(""),
    modelOverride: z.any().optional(),
    realism: z.object({
        surface: z.string().max(4000).default(""),
        imaging: z.string().max(4000).default(""),
        world: z.string().max(4000).default(""),
        motion: z.string().max(4000).default(""),
        cinematic: z.string().max(4000).default(""),
    }).default({}),
});
export type ShotInput = z.infer<typeof shotInput>;
