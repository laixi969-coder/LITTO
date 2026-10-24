import { z } from "zod";
import { cameraTrajectorySchema } from "@toonflow/tools-scaffold/runtime";
import { techniquePlan } from "./filmTechniques";

export type { MediaModel, MediaReference, MediaGenerationRequest, GeneratedMedia, MediaContext } from "@toonflow/tools-scaffold/runtime";

/**
 * 肤质两条路径：资产与商业镜头要干净基准，生活与纪实镜头留极少量自然油光。
 * 统一成一条会两头不讨好——定妆图油了不能用，vlog 里全哑光又像塑料。
 * 同一个人同一场景只切换这一条，其余成像约束不动。
 */
export type SkinFinish = "clean" | "natural";

export const skinFinishes: Record<SkinFinish, string> = {
  clean:
    "人物肤色干净均匀，保留既定肤色、年龄与身份特征，以及符合景别的细微纹理和自然血色。默认轻薄半哑光肤面，额鼻反光克制，颧骨与嘴唇高光柔和；已指定的妆容与润泽程度优先。底妆与颈部自然衔接，眉毛和睫毛根根可辨，发根清爽蓬松。不要刻意放大毛孔、绒毛、色斑或皱纹，不加粉底分界、疲态、满脸油光或蜡状磨皮。雨水、汗水与潮湿只作用于头发和衣物；面部皮肤不随场景变湿，雨中人像面部至多零星水珠挂在局部，不做整脸水膜，不给额头、鼻梁、颧骨镜面高光。",
  natural:
    "人物保留既定肤色、年龄特征及符合景别的细微纹理；生活或纪实镜头允许少量自然皮脂反光和局部肤色变化，强度服从当时活动状态。眉毛、睫毛和唇纹自然可辨，不刻意添加粗大毛孔、粉底分界、厚重油膜或疲态，不以磨皮改变人物身份。雨水、汗水与潮湿只作用于头发和衣物；面部皮肤不随场景变湿，雨中人像面部至多零星水珠挂在局部，不做整脸水膜，不给额头、鼻梁、颧骨镜面高光。",
};

export const videoMotionTiming = "Motion defaults to real time. Combat and rescue use compact, continuous causal action: contact triggers response and the next movement; approach, support, transfer and withdrawal connect without idle resets. Let compatible actions overlap naturally while preserving readable contact, force, weight and consequences. Execute the full planned action chain and its visible result; do not reduce body movement, interaction or displacement to blinking, breathing or a held pose. Follow the planned framing and changes of viewing distance; keep both participants and their support/contact readable when the plan calls for it. Do not divide duration into equal action slots or stretch brief actions to fill the clip. Camera follows the action at its actual speed or stays locked; never default to slow pushes, slow pans or waiting for the camera before acting. Slow motion is allowed only for an explicitly designated beat with a clear narrative purpose or user request; resume real time afterwards, never spread it across the whole scene. Preserve explicit dialogue/music sync, planned cuts and purposeful stillness; do not add cuts, events or pauses to fill time.";

export const videoSpeechPlanning = "Measure the selected recorded speech before committing post-dub video generation: productionSpec planSpeech {shotId,bindings?:[{lineIndex,path}]} reuses current valid voiceProject selections or explicitly mapped existing audio, returns real durations and a non-overlapping local schedule without applying edits or generating media. ImportAudio then audio:{mediaId,text} binds each exact original line. Save each visible line coverage:[{start,end,description}] covering its whole speech window with the actual speaker and complete mouth visible; appearing somewhere in the shot is insufficient. Resolve internal cuts and returns before speech starts, and keep that coverage until the full line ends. PlanSpeech returns a capacity lower bound, not permission to stretch combat/rescue or move sound across shots. Reblock or create meaningful dialogue units within the established scene and causal order, preserving each complete line in its corresponding shot. Do not speed, cut words, add idle pauses, freeze/loop action or use generation handles to hide insufficient edit duration. Missing or stale voice duration/coverage blocks generation, not read-only planning. Native dialogue remains a distinct explicitly selected joint audio/video route, never a workaround for unavailable post-dub timing; actual sync still requires playback review. When retiming, preserve the established action order and prerequisites. A conflicting old keyframe remains unresolved input, never a reason to move an attack before its evade or invent evidence, restored power or another rescue. Check actual recording pauses rather than inferring silence from word count or total duration; do not add a second wait over a pause already in the file. Shorten only unnecessary gaps between complete recordings, never cut, speed or relocate their contents. Keep prior continuity ledger entries as context, not commands to repeat completed interactions. Align focus and framing with every visible speech window so the mouth remains readable for the whole line.";

export const videoCoveragePlanning = "Plan coverage across the scene before designing individual shots. Treat draft shot sizes, lenses and static cameras as suggestions, not locked instructions. Choose viewing distance and viewpoint for the information needed: spatial relationships and full-body movement in wider views, interaction and tactics in medium views, decisive contact or information in details, and consequential reactions in closer views. Use the useful subset in a motivated order; no fixed wide-medium-close cycle, shot-count quota or cut rate. Repeated framing must serve continuity, pressure or a deliberate viewpoint, rather than arise from copying the draft. For ongoing action, develop a readable chain of intention, physical attempt, resistance, adaptation and visible consequence using established people, props and space. Compatible actions may overlap; match their scale to framing and the available real-time duration. Add staging and performance detail within the established event, never new plot events, injuries, props or dialogue. A gesture or purposeful stillness can suffice when explicitly intended. Put framing, subject paths, timing, start/end states and cut reasons into the existing shot fields; planned internal cuts belong only in an explicit execution timeline, otherwise use separate shots. Preserve approved references, dialogue coverage, screen direction, action phase and requested continuous takes. A continuous take can develop framing through motivated blocking or tracking; do not add cuts or extra camera moves merely to create variety.";

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
const shotSpecSchema = z.strictObject({
  shotSize: z.string().trim().max(40).optional().describe("景别，如 大远景/中景/近景/特写"),
  lens: z.string().trim().max(40).optional().describe("焦段与成像，如 35mm 浅景深"),
  cameraMove: z.string().trim().max(120).optional().describe("运镜及动机，如 缓慢横移跟随；无动机不动"),
  blocking: z.string().trim().max(200).optional().describe("人物调度：位置、朝向、视线、前后景关系"),
  action: z.string().trim().max(200).optional().describe("本镜可执行的动作与起止"),
  performance: z.string().trim().max(200).optional().describe("表演：目标、触发、反应，不写情绪标签"),
  lighting: z.string().trim().max(200).optional().describe("光源、方向、光比与暗部处理"),
  startState: z.string().trim().max(200).optional().describe("首帧已发生的状态"),
  endState: z.string().trim().max(200).optional().describe("本镜结束时的可见状态"),
}).optional();

const sharedFields = {
  shotSpec: shotSpecSchema.describe("镜头规格。填了就不再靠散文猜景别与运镜；留空则只用 prompt"),
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
  outputName: z.string().trim().min(1).max(200).optional().describe("画布显示名称，如林宁·角色设定图、客厅·日景、取钥匙·视频；仅用于命名，不改变生成内容或触发重生成。"),
  images: z.array(imageReference).max(64).optional(),
  ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
};
const referenceMode = z.templateLiteral([z.enum(["image", "video", "audio"]), "Reference:", z.number()])
  .refine(value => /Reference:(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])$/.test(value), "参考数量必须在 1 到 256 之间");

export const listMediaModelsSchema = z.strictObject({ all: z.boolean().optional().describe("列出可供用户选择的全部已配置媒体模型；不代表已授权切换") });
export const audioReviewSchema = z.strictObject({
  speech: z.enum(["pass", "fail", "unverified", "notApplicable"]), lipSync: z.enum(["pass", "fail", "unverified", "notApplicable"]),
  referenceMediaId: z.string().min(1).optional(), inspectionKey: z.string().length(64).optional(),
  offsetMs: z.number().finite().min(-5000).max(5000).optional(), note: z.string().trim().min(10).max(4000),
});

export function needsLipSync(shot: Record<string, any>) {
  if (shot.creativeBrief?.dialogue?.lines?.some((line: { lipSync: string }) => line.lipSync === "visible")) return true;
  if (typeof shot.musicVideo?.lipSyncRequired === "boolean") return shot.musicVideo.lipSyncRequired;
  // ACT: 兼容旧MV明确的演唱段，新规格用显式字段；普通背景人声不推断为口型需求。
  return shot.musicVideo?.audioMode === "sourceTrack" && /演唱段|本人唱/.test(shot.musicVideo.audioDirection ?? "");
}
export function physicalInteractionPlan(shot: Record<string, any>) {
  // ACT: 旧镜头仍用文本筛查；结构化事件只定义观察窗口，不能证明生成结果符合物理。
  const interaction = /放[进入回到在]|插[进入回在]|塞[进入回]|收[进入回]|取出|拿[起出]|抽出|拔出|装入|倒入|倒出|倾倒|递给|递交|接过|放下|摆放|搁在|立在|铺平|展开|对折|折叠|撕|剥|拧开|调整肩带|拉着.{0,8}行李|\b(?:insert|pour|place|grasp|handover|fold|unfold|peel|tear)\b|\b(?:put|slide|push|pull|take|hand)\b.{0,40}\b(?:into|inside|onto|out of|over|to)\b/i;
  const timeline = shot.camera?.design?.timeline ?? shot.musicVideo?.timeline ?? [];
  const events = shot.interactions ?? [];
  const required = events.length > 0 || interaction.test([shot.action, shot.performance?.gesture, ...timeline.map((beat: any) => beat.description)].join(" "));
  const duration = Number(shot.generationDuration ?? shot.duration);
  const ranges: { start: number; end: number }[] = timeline.filter((beat: any) => interaction.test(beat.description ?? "") && Number.isFinite(beat.start) && Number.isFinite(beat.end)
    && beat.start >= 0 && beat.end > beat.start && Number.isFinite(duration) && beat.start < duration)
    .map((beat: any) => ({ start: beat.start as number, end: Math.min(beat.end, duration) }));
  const instruction = required ? "Follow the specified action and world physics. Establish the actual opening or supporting surface before contact. Keep its location, shape and scale consistent with the reference and earlier frames, including across cuts and occlusion. Align the object with that existing opening or surface; show approach, contact, passage or transfer, then supported settling before release. Preserve grip and object continuity. Do not invent or move an opening, pass through a closed wall, teleport an object, or hide a geometry change with a cut. Apply only explicitly planned transformations." : "";
  return { required, contactTimes: events.map((event: any) => event.contactAt as number), ranges: events.length ? events.map((event: any) => ({ start: event.start, end: event.end })) : ranges,
    instruction: instruction + (events.length ? `\nExecute these contact events in local seconds; preserve each named participant, support and visible result: ${JSON.stringify(events)}` : "") };
}

export function qualityReviewPlan(shot: Record<string, any>, type: "keyframe" | "take" = "take") {
  const duration = Number(shot.generationDuration ?? shot.duration);
  const lines = shot.creativeBrief?.dialogue?.lines ?? [];
  const speech = type === "take" && (needsLipSync(shot) || lines.length > 0);
  const interaction = physicalInteractionPlan(type === "keyframe" ? { ...shot, camera: undefined, musicVideo: undefined, interactions: undefined } : shot);
  const techniques = techniquePlan(shot, type === "keyframe" ? "image" : "video");
  const techniqueMotion = techniques.some(item => item.stages.includes("video") && !item.stages.includes("image"));
  const motionBeats = type === "take" ? shot.camera?.design?.timeline ?? shot.musicVideo?.timeline ?? [] : [];
  // ACT: 检查点从同一执行规格生成，不推断动作是否合格；每项仍须真实播放观察，未观察不填通过。
  const checkpoints: { id: string; start: number; end: number; criterion: string }[] = type === "take" ? [
    ...motionBeats.map((beat: any, index: number) => ({ id: `beat${index}`, start: beat.start, end: beat.end,
      criterion: `${beat.description}；${beat.transition === "cut" ? "检查切点前后姿态、持物、视线和运动方向" : "检查动作持续推进，无无故停顿、复位或隐藏切镜"}` })),
    ...(shot.interactions ?? []).map((event: any, index: number) => ({ id: `contact${index}`, start: event.start, end: event.end,
      criterion: `${event.assetIds.join("、")}：${event.approach} → ${event.contactAt}s ${event.contact}；受力 ${event.force}；承托 ${event.support}；释放 ${event.release}；结果 ${event.endState}` })),
    ...(shot.creativeBrief?.combat?.beats ?? []).map((beat: any, index: number) => ({ id: `combat${index}`,
      start: motionBeats[beat.timelineIndex]?.start ?? 0, end: motionBeats[beat.timelineIndex]?.end ?? duration,
      criterion: `${beat.attackerId} → ${beat.defenderId}：${beat.action} → ${beat.reaction} → ${beat.endState}；其他人物 ${beat.supportingAction}。检查因果、速度、位移、遮挡及接触，不能以身份稳定代替动作达标。` })),
  ] : [];
  const motion = motionBeats.length > 0 || interaction.required || techniqueMotion || shot.creativeBrief?.kind === "combat" || /手指|双手|握住|递给|抓握|打斗|搏斗|救援|救起|承托|转移伤者|hand|grasp|fight|rescue/i.test([shot.action, shot.performance?.gesture].join(" "));
  const visual = motion || techniques.length > 0 || !shot.camera?.shotSize || /^(?:ECU|CU|MCU)$/i.test(shot.camera?.shotSize ?? "") || /近景|特写/.test(shot.camera?.shotSize ?? "")
    || !!shot.inspectionRegion;
  // ACT: 分级只安排检查投入，不据此宣称质量通过；未知景别进入重点档。明确的演唱无逐句时间时覆盖整段。
  const tier = speech ? "speech" : visual || !shot.camera?.shotSize ? "visual" : "basic";
  const speechRanges: { start: number; end: number }[] = speech ? (needsLipSync({ ...shot, creativeBrief: undefined }) ? [{ start: 0, end: duration }] : lines.map((line: any) => ({ start: line.start, end: line.end }))) : [];
  return { tier, sampleCount: tier === "basic" && !techniques.length ? 3 : 8, fullPlayback: type === "take", techniques,
    checks: type === "take" ? ["surface", "imaging", "world", "motion", "cinematic"] : ["surface", "imaging", "world", "cinematic"], speechRanges, interaction,
    motionPlan: type === "take" ? { mode: shot.camera?.design?.mode, beats: motionBeats, checkpoints, note: "逐段对照实际身体任务、接触结果、位移与接点；singleTake的节拍边界不能跳切或复位。完整播放后用 motionReview 逐项记录实际时间点、观察与 pass/revise；计划不是观察证据，未检查保持未验证。" } : undefined };
}

export function finalReviewFields(kind: string, lipSync: boolean, music: boolean) {
  return [
    ["surface", "皮肤、头发与商品材质"], ["motion", "肢体、动作受力与手物接触"],
    ["lighting", "场景光源、曝光与光色"], ["continuity", "人物、服装、空间与动作阶段连续"],
    ["sound", "对白、环境声、音画同步与接缝"], ["narrative", "事件、信息或关系推进"],
    ["performance", "角色目的、触发、反应与调度"], ["dialogueCoverage", "原文台词、说话人与声音通道"],
    ["editing", "节奏、留白与邻镜连接"], ["composition", "构图与视觉主次"], ["color", "整片色调、肤色与产品本色"],
    ...(lipSync ? [["lipSync", "画内对白或演唱的逐字口型"]] : []),
    ...(["adfilm", "brandFilm"].includes(kind) ? [["emotion", "情绪与创意表达"], ["product", "产品证明、识别与品牌记忆"]] : []),
    ...(kind === "musicFilm" || music ? [["musicAlignment", "原曲、乐句、演唱与画面同步"], ["musicProgression", "主副歌层次、视觉母题的发展与回收"]] : []),
  ].map(([id, label]) => ({ id, label }));
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
  observedStateDelta: z.record(z.string(), z.json()).optional().describe("实际观察到的镜尾状态变化，沿用 intendedStateDelta 分组但不得照抄计划；无变化传 {}。完整视频检查通过且提供实际末态时采用为正式镜头，并传递给后镜"),
  audioReview: audioReviewSchema.optional().describe("对白/演唱须按真实完整看听记录声音和逐字口型。帧图不能证明同步，未听未看不填pass"),
  techniqueReview: z.array(z.strictObject({ id: z.string().min(1), verdict: z.enum(["pass", "revise"]), note: z.string().trim().min(10).max(2000) })).max(8).optional().describe("选用技法的视频须逐项对照检查计划，完整播放后记录实际证据；不能用检索结果或提示词冒充通过"),
  motionReview: z.array(z.strictObject({ id: z.string().min(1), verdict: z.enum(["pass", "revise"]), note: z.string().trim().min(10).max(2000) })).max(144).optional().describe("视频按检查计划 motionPlan.checkpoints 的 id 逐项记录实际时间点和动作/空间/接触结果；完整播放后才能 pass，未观察不填。批量由助手记录，不逐项向用户确认。"),
  creativeReview: z.strictObject({ verdict: z.enum(["pass", "revise"]), styling: z.string().trim().min(10).max(2000), staging: z.string().trim().min(10).max(2000) }).optional().describe("有creativeBrief时必填。verdict只能为pass或revise，不能用workingVersion。styling和staging各至少10字，写实际妆造与调度依据。"),
  observations: z.array(z.strictObject({
    kind: z.enum(["creativeMismatch", "anatomy_failure", "wardrobe_drift", "plastic_surface", "imaging_failure", "temporal_drift", "performance_failure", "hand_artifact", "face_artifact", "identity_drift", "composition_off", "motion_physics", "scene_structure", "color_shift", "capability_mismatch", "deliveryResolution", "deliveryUnverified", "logo_distortion"]),
    note: z.string().min(1),
  })).max(40).default([]).describe("仅记录实际缺陷，无缺陷传 []，正常表现写入 note。严重缺陷会阻止采用，重复提交不能消除旧缺陷。"),
});
export const imageGenerationSchema = z.strictObject({
  ...sharedFields,
  localRepair: z.strictObject({
    keyframeId: z.string().min(1), kind: z.enum(["face_artifact", "hand_artifact", "anatomy_failure", "plastic_surface"]),
    target: z.strictObject({ assetId: z.string().min(1).optional(), region: z.string().trim().min(1).max(500) }).optional(),
    note: z.string().trim().max(2000).optional(),
  }).optional().describe("精修已有镜头关键帧：须同时传 shotId，target 写实际对象和部位。原图作为唯一输入，只生成新候选；先 compile，generate 复用同一请求与指纹。不是蒙版编辑。"),
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
  audioParameters: z.record(z.string().min(1).max(100), z.union([z.string().max(20000), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 40, "音频参数最多 40 项").optional().describe("仅使用供应商已同步参数定义中的额外音频参数，例如音乐的 lyrics、instrumental、duration。不能覆盖 model、text、prompt、音色或格式等已有字段。"),
  providerId: sharedFields.providerId,
  modelId: sharedFields.modelId,
  prompt: z.string().trim().min(1).max(100000).describe("语音模型只写实际要念的完整台词，不夹入说话人介绍、声音描述或表演指令；表演写 instructions 并核实模型支持。音乐/音效模型写对应内容提示。"),
  outputDirectory: sharedFields.outputDirectory,
  audios: z.array(audioReference).max(64).optional(),
  instructions: z.string().trim().max(2000).optional(),
  voice: z.string().trim().min(1).max(256).optional(),
  speed: z.number().finite().positive().optional(),
  volume: z.number().finite().optional(),
  format: z.string().trim().min(1).max(64).optional(),
  sampleRate: z.number().int().positive().optional(),
});
