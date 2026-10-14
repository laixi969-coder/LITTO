import { z } from "zod";
import { cameraTrajectorySchema } from "@toonflow/tools-scaffold/runtime";

export type { MediaModel, MediaReference, MediaGenerationRequest, GeneratedMedia, MediaContext } from "@toonflow/tools-scaffold/runtime";

/** 项目总览不重复回传每个产物的整段编译提示词；原生成记录与其余参数仍保留。 */
export function compactProductionRead<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const result = value as Record<string, any>;
  if (typeof result.projectId !== "string" || !Array.isArray(result.shots) || !Array.isArray(result.keyframes) || !Array.isArray(result.takes)) return value;
  const compact = (item: Record<string, any>) => {
    if (!item || typeof item.meta !== "object" || !item.meta) return item;
    const { prompt, ...meta } = item.meta;
    if (meta.parameters?.request && typeof meta.parameters.request === "object") {
      const { prompt, negativePrompt, ...request } = meta.parameters.request;
      const { negativePrompt: compiledNegative, ...parameters } = meta.parameters;
      meta.parameters = { ...parameters, request };
    }
    return { ...item, meta };
  };
  return { ...result, keyframes: result.keyframes.map(compact), takes: result.takes.map(compact) } as T;
}

const relativePath = z.string().min(1).max(2048).refine(
  path => !/^[\\/]|[:\u0000-\u001f]/.test(path) && path.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含空路径段或 ..",
);
const imageReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i) });
const videoReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i) });
const audioReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i) });
const sharedFields = {
  purpose: z.enum(["asset", "standalone"]).optional().describe("仅无 shotId 时使用：asset 为基础资产，standalone 为用户明确要求的独立画面。已有镜头项目的正式分镜必须使用 shotId，不能标为独立图绕过规格。"),
  shotId: z.string().min(1).max(128).optional(),
  productionFingerprint: z.string().length(64).optional(),
  regenerationId: z.string().uuid().optional().describe("仅明确授权重做或新增候选时创建 UUID；同一次重做始终复用该 ID。默认复用已有镜头任务，失败不自动重发。不能为绕过复用而自动创建新 ID。"),
  providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().trim().min(1).max(256),
  prompt: z.string().trim().max(100000).default("").describe("独立素材须填写提示词；正式镜头可省略，由服务端按 shotId 和 productionFingerprint 编译，不复制长提示词。"),
  negativePrompt: z.string().max(100000).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  outputDirectory: relativePath.optional(),
  images: z.array(imageReference).max(64).optional(),
  ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
};
const referenceMode = z.templateLiteral([z.enum(["image", "video", "audio"]), "Reference:", z.number()])
  .refine(value => /Reference:(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])$/.test(value), "参考数量必须在 1 到 256 之间");

export const listMediaModelsSchema = z.strictObject({ all: z.boolean().optional().describe("列出可供用户选择的全部已配置媒体模型；不代表已授权切换") });
export const audioReviewSchema = z.strictObject({
  speech: z.enum(["pass", "fail", "notApplicable"]), lipSync: z.enum(["pass", "fail", "notApplicable"]),
  referenceMediaId: z.string().min(1).optional(), inspectionKey: z.string().length(64).optional(),
  offsetMs: z.number().finite().min(-5000).max(5000).optional(), note: z.string().trim().min(10).max(4000),
});

export function needsLipSync(shot: Record<string, any>) {
  if (shot.creativeBrief?.dialogue?.lines?.some((line: { lipSync: string }) => line.lipSync === "visible")) return true;
  if (typeof shot.musicVideo?.lipSyncRequired === "boolean") return shot.musicVideo.lipSyncRequired;
  // ACT: 兼容旧MV明确的演唱段，新规格用显式字段；普通背景人声不推断为口型需求。
  return shot.musicVideo?.audioMode === "sourceTrack" && /演唱段|本人唱/.test(shot.musicVideo.audioDirection ?? "");
}
export function qualityReviewPlan(shot: Record<string, any>, type: "keyframe" | "take" = "take") {
  const duration = Number(shot.generationDuration ?? shot.duration);
  const lines = shot.creativeBrief?.dialogue?.lines ?? [];
  const speech = type === "take" && (needsLipSync(shot) || lines.length > 0);
  const motion = shot.creativeBrief?.kind === "combat" || /手指|双手|握住|递给|抓握|打斗|搏斗|hand|grasp|fight/i.test([shot.action, shot.performance?.gesture].join(" "));
  const visual = motion || !shot.camera?.shotSize || /^(?:ECU|CU|MCU)$/i.test(shot.camera?.shotSize ?? "") || /近景|特写/.test(shot.camera?.shotSize ?? "")
    || !!shot.inspectionRegion;
  // ACT: 分级只安排检查投入，不据此宣称质量通过；未知景别进入重点档。明确的演唱无逐句时间时覆盖整段。
  const tier = speech ? "speech" : visual || !shot.camera?.shotSize ? "visual" : "basic";
  const speechRanges: { start: number; end: number }[] = speech ? (needsLipSync({ ...shot, creativeBrief: undefined }) ? [{ start: 0, end: duration }] : lines.map((line: any) => ({ start: line.start, end: line.end }))) : [];
  return { tier, sampleCount: tier === "basic" ? 3 : 8, fullPlayback: type === "take" && motion,
    checks: tier === "basic" ? ["imaging", "world", "cinematic"] : type === "keyframe" || !motion ? ["surface", "imaging", "world", "cinematic"] : ["surface", "imaging", "world", "motion", "cinematic"], speechRanges };
}

export const reviewedSegmentsSchema = z.array(z.strictObject({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).refine(range => range.end > range.start)).max(80).default([]);

export function coversSpeechRanges(required: { start: number; end: number }[], reviewed: { start: number; end: number }[]) {
  return required.length > 0 && required.every(range => {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) return false;
    let end = range.start;
    for (const part of [...reviewed].sort((a, b) => a.start - b.start)) {
      if (!Number.isFinite(part.start) || !Number.isFinite(part.end) || part.end <= part.start) return false;
      if (part.start <= end + 0.001 && part.end > end) end = part.end;
    }
    return end >= range.end - 0.001;
  });
}

export const agentReviewSchema = z.strictObject({
  targetType: z.enum(["keyframe", "take"]),
  targetId: z.string().min(1),
  authorization: z.string().trim().min(1).max(2000).describe("引用用户已明确给予的自主审阅授权原话，不能自行编造。短授权同样有效。"),
  note: z.string().trim().min(10).max(8000),
  frameTimes: z.array(z.number().finite().nonnegative()).max(600).default([]),
  reviewedSegments: reviewedSegmentsSchema.describe("实际看听的局部区间，单位秒；覆盖本镜全部发声区间才可用于声音检查，不能把计划区间当作已看听"),
  fullPlayback: z.boolean().default(false).describe("只有实际完整播放当前视频后才为true，抽帧不能替代看听"),
  audioReview: audioReviewSchema.optional().describe("对白/演唱须按真实完整看听记录声音和逐字口型。帧图不能证明同步，未听未看不填pass"),
  creativeReview: z.strictObject({ verdict: z.enum(["pass", "revise"]), styling: z.string().trim().min(10).max(2000), staging: z.string().trim().min(10).max(2000) }).optional().describe("有creativeBrief时必填。verdict只能为pass或revise，不能用workingVersion。styling和staging各至少10字，写实际妆造与调度依据。"),
  observations: z.array(z.strictObject({
    kind: z.enum(["creativeMismatch", "anatomy_failure", "wardrobe_drift", "plastic_surface", "imaging_failure", "temporal_drift", "performance_failure", "hand_artifact", "face_artifact", "identity_drift", "composition_off", "motion_physics", "scene_structure", "color_shift", "capability_mismatch", "deliveryResolution", "deliveryUnverified", "logo_distortion"]),
    note: z.string().min(1),
  })).max(40).default([]).describe("仅记录实际缺陷，无缺陷传 []，正常表现写入 note。严重缺陷会阻止采用，重复提交不能消除旧缺陷。"),
});
export const imageGenerationSchema = z.strictObject({
  ...sharedFields,
  purpose: z.enum(["asset", "standalone", "storyboard"]).optional().describe("storyboard 仅用于用户明确要求的多格分镜总览；须继承已有镜头规格和资产参考，拆格后用 importKeyframe 登记各镜候选，不能将整张宫格当作单镜主帧。"),
  size: z.string().trim().min(1).max(64).optional(),
});
export const videoGenerationSchema = z.strictObject({
  cameraTrajectory: cameraTrajectorySchema.optional(),
  imageAndCameraOnly: z.boolean().optional(),
  ...sharedFields,
  videos: z.array(videoReference).max(64).optional(),
  audios: z.array(audioReference).max(64).optional(),
  firstFrame: imageReference.optional(),
  lastFrame: imageReference.optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  duration: z.number().finite().positive().max(3600).optional(),
  generateAudio: z.boolean().optional(),
  mode: z.union([
    z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"]),
    z.array(referenceMode).min(1).max(3),
    // 部分工具调用模型会把联合类型中的数组编码为 JSON 字符串；规范化后仍逐项校验，不接受任意模式。
    z.string().max(256).startsWith("[").endsWith("]").transform((value, ctx) => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "多参考模式必须是有效的 JSON 数组" });
        return z.NEVER;
      }
    }).pipe(z.array(referenceMode).min(1).max(3)),
  ]).optional().describe("单图等模式传枚举字符串；多参考模式优先传真实数组，如 [\"imageReference:15\",\"audioReference:3\"]，也兼容该数组的 JSON 字符串。具体值须与 listMediaModels 一致。"),
});
export const audioGenerationSchema = z.strictObject({
  providerId: sharedFields.providerId,
  modelId: sharedFields.modelId,
  prompt: z.string().trim().min(1).max(100000),
  outputDirectory: sharedFields.outputDirectory,
  audios: z.array(audioReference).max(64).optional(),
  instructions: z.string().trim().max(2000).optional(),
  voice: z.string().trim().min(1).max(256).optional(),
  speed: z.number().finite().positive().optional(),
  volume: z.number().finite().optional(),
  format: z.string().trim().min(1).max(64).optional(),
  sampleRate: z.number().int().positive().optional(),
});
