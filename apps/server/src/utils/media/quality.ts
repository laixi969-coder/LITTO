import { readFile, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { MediaGenerationRequest, MediaModel, QuestionContext } from "@toonflow/tools-scaffold/runtime";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { listMediaModels } from "@/utils/media/generation";
import { currentTenant } from "@/utils/tenant";
import { cloud } from "@/lib/cloud";

const qualitySchema = z.strictObject({ kind: z.enum(["image", "video"]), providerId: z.string().min(1), modelId: z.string().min(1), value: z.string().min(1).max(64) });
const preferencesSchema = z.array(qualitySchema).max(200);
const ratioSchema = z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).or(z.literal(""));
const aspectPreferencesSchema = z.strictObject({ imageRatio: ratioSchema.optional(), videoRatio: ratioSchema.optional() });

export async function readMediaAspect(directory: string) {
  const { path } = await resolveWorkspacePath(directory, "mediaPreferences.json", true);
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return content === null ? {} : aspectPreferencesSchema.parse(JSON.parse(content));
}

export function qualityOptions(model: MediaModel) {
  return [...new Set(model.type === "image" ? model.imageSizes ?? [] : model.durationResolutionMap?.flatMap(rule => rule.resolution) ?? [])];
}

export async function readMediaQuality(directory: string) {
  const { path } = await resolveWorkspacePath(directory, "mediaQuality.json", true);
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return { path, content, preferences: content === null ? [] : preferencesSchema.parse(JSON.parse(content)) };
}

/** 只读预检：先暴露整批缺项和单段上限，再组织一次具体确认；不入队、不改模型。 */
export async function planMediaGeneration(directory: string, input: unknown) {
  const { requests } = z.strictObject({ requests: z.array(z.strictObject({
    kind: z.enum(["image", "video"]), count: z.number().int().min(1).max(100),
    quality: z.string().min(1).max(64).optional(), duration: z.number().finite().positive().max(3600).optional(),
    mode: z.union([z.string().min(1).max(100), z.array(z.string().regex(/^(image|video|audio)Reference:\d+$/)).min(1).max(3)]).optional(),
    referenceCount: z.number().int().min(0).max(100).optional(), singleTake: z.boolean().optional(),
  })).min(1).max(60) }).parse(input);
  const [models, saved] = await Promise.all([listMediaModels(), readMediaQuality(directory)]);
  const plans = requests.map(request => {
    const model = models.find(item => item.type === request.kind && !item.lipSync);
    if (!model) return { ...request, ready: false, issues: ["当前没有可用的已选模型，先合并说明所需模型与规格，不能自行换模型"] };
    const options = qualityOptions(model);
    const quality = request.quality ?? saved.preferences.find(item => item.kind === request.kind && item.providerId === model.providerId && item.modelId === model.modelId)?.value ?? (options.length === 1 ? options[0] : undefined);
    const durations = [...new Set(model.durationResolutionMap?.filter(rule => !quality || rule.resolution.includes(quality)).flatMap(rule => rule.duration) ?? [])].sort((a, b) => a - b);
    const modes = Array.isArray(model.mode) ? model.mode : [];
    const mode = request.mode ?? (modes.length === 1 && typeof modes[0] === "string" ? modes[0] : undefined);
    const requiredReferenceCount = mode === "startEndRequired" ? 2 : mode === "singleImage" || mode === "multiReference" ? 1 : 0;
    const issues: string[] = [];
    if (request.mode && !modes.some(item => JSON.stringify(item) === JSON.stringify(request.mode))) issues.push("所需输入模式未受当前模型明确支持，先核对参考条件，不能到生成后再要求改模型");
    if (requiredReferenceCount && (request.referenceCount ?? 0) < requiredReferenceCount) issues.push(`当前模式至少需要${requiredReferenceCount}张实际参考图，先核对已有素材或把缺图制作纳入同一批方案；不能只确认额度后再发现输入不足`);
    if (!quality && options.length > 1) issues.push("精度尚未确定；用户已指定时直接保存，否则纳入本批方案一次询问");
    if (quality && options.length && !options.includes(quality)) issues.push("所选精度不受当前模型支持，不会自动降级");
    if (request.kind === "video" && (!request.duration || !durations.includes(request.duration))) issues.push(request.singleTake
      ? "所需一镜到底时长未受当前模型明确支持；保留长镜头方案，不自动切成短段或把拼接冒充一镜到底"
      : "生成段时长尚未确定或不受当前规格支持；按动作单元规划素材与剪辑，不按上限机械均分");
    return { ...request, mode, requiredReferenceCount, providerId: model.providerId, modelId: model.modelId, quality, qualityOptions: options, supportedDurations: durations,
      maxSingleGenerationDuration: durations.at(-1) ?? null, modes: model.mode, audio: model.audio, ready: issues.length === 0, issues };
  });
  return { ready: plans.every(plan => plan.ready), plans, generated: false,
    note: "本地只读能力预检，不代表参考齐备、已获生成授权或画质通过。先核对实际模式和参考输入，再compile；已授权范围无需重问，缺项集中呈现，真正新增消耗才确认。" };
}

function checkPermission() {
  const tenant = currentTenant();
  if (!tenant) return;
  const member = cloud()?.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
  if (!member || member.role === "VIEWER") throw new Error("无权修改项目生成精度");
}

export async function saveMediaQuality(directory: string, input: unknown, previous?: string | null, signal?: AbortSignal) {
  signal?.throwIfAborted();
  checkPermission();
  const choice = qualitySchema.parse(input);
  const model = (await listMediaModels()).find(model => model.type === choice.kind && model.providerId === choice.providerId && model.modelId === choice.modelId);
  if (!model || !qualityOptions(model).includes(choice.value)) throw new Error("当前选定模型不支持此精度，请查询实际规格后重新选择");
  const { path } = await readMediaQuality(directory);
  const release = lockWorkspaceFiles([path]);
  try {
    const saved = await readMediaQuality(directory);
    if (previous !== undefined && saved.content !== previous) throw new Error("项目精度已在其他操作中改变，本次未覆盖");
    const preferences = saved.preferences.filter(item => item.kind !== choice.kind || item.providerId !== choice.providerId || item.modelId !== choice.modelId).concat(choice);
    preferencesSchema.parse(preferences);
    checkPermission();
    signal?.throwIfAborted();
    await writeAtomic(path, JSON.stringify(preferences, null, 2), { exclusive: saved.content === null });
    return { applied: true, preference: choice, answer: "精度已保存到当前项目，后续使用此模型时沿用，无需再次确认" };
  } finally { release(); }
}

export async function requestMediaQuality(directory: string, toolCallId: string, input: { data: Record<string, unknown>; reconsider?: boolean }, question: QuestionContext, signal?: AbortSignal) {
  checkPermission();
  const { kind } = z.strictObject({ kind: z.enum(["image", "video"]) }).parse(input.data);
  const model = (await listMediaModels()).find(model => model.type === kind && !model.lipSync);
  if (!model) throw new Error("请先在聊天中选择可用的生成模型");
  const options = qualityOptions(model);
  if (!options.length) throw new Error("此模型未提供可选精度，不能假定支持 2K 或 4K");
  const saved = await readMediaQuality(directory);
  const previous = saved.preferences.find(item => item.kind === kind && item.providerId === model.providerId && item.modelId === model.modelId);
  if (!input.reconsider && previous && options.includes(previous.value)) return { applied: true, preference: previous, answer: "沿用已选精度，无需重复确认" };
  const request = { title: kind === "image" ? "选择图片精度" : "选择视频分辨率", question: `${model.providerLabel} · ${model.label}。选择后用于当前项目；较高分辨率可能增加算力消耗。${kind === "video" ? "具体时长须与所选分辨率匹配。" : "多格图的精度指整张图片，拆格后每格像素会减少。"}`, options: options.concat("暂不决定") };
  const response = await question.ask(toolCallId, request, signal);
  signal?.throwIfAborted();
  if (response.skipped || !options.includes(response.answer)) return { ...request, ...response, applied: false };
  return { ...request, ...await saveMediaQuality(directory, { kind, providerId: model.providerId, modelId: model.modelId, value: response.answer }, saved.content, signal) };
}

/** ACT: 按项目和模型记忆精度；单次明确传入的规格优先，队列保存解析后的快照。 */
export async function applyMediaQuality(directory: string, kind: "image" | "video" | "audio", request: MediaGenerationRequest, model: MediaModel) {
  if (kind === "audio") return request;
  if (kind === "video" && request.generateAudio === true && !model.audio) throw new Error("当前模型未声明生成声音能力，不能静默忽略 generateAudio；此次未提交生成");
  const aspect = (await readMediaAspect(directory))[kind === "image" ? "imageRatio" : "videoRatio"];
  if (aspect && request.ratio) {
    const [width, height] = aspect.split(":").map(Number);
    const [requestedWidth, requestedHeight] = request.ratio.split(":").map(Number);
    if (width * requestedHeight !== height * requestedWidth) throw new Error(`项目已选 ${aspect}，本次请求却为 ${request.ratio}；请沿用项目画幅。确需改画幅时先明确更新项目 mediaPreferences.json，此次未提交生成`);
  }
  // 专用口型只核验原片，比例不作为重绘参数发送。
  if (model.lipSync) return request;
  request = { ...request, ratio: aspect || request.ratio };
  const field = kind === "image" ? "size" : "resolution";
  const saved = (await readMediaQuality(directory)).preferences.find(item => item.kind === kind && item.providerId === request.providerId && item.modelId === request.modelId);
  const value = request[field] ?? saved?.value;
  const options = qualityOptions(model);
  if (!value && options.length > 1) throw new Error(`尚未选择${kind === "image" ? "图片精度" : "视频分辨率"}，请用 requestProductionDecision(selectQuality) 在聊天中选择；用户已明确指定时用 productionSpec(setQuality) 保存。此次未提交生成。`);
  if (value && options.length && !options.includes(value)) throw new Error(`所选精度 ${value} 不受当前模型支持，可选：${options.join("、")}。未提交生成，不会静默降级。`);
  const pixels = kind === "image" && value ? /^(\d+)[x*](\d+)$/.exec(value) : null;
  const ratio = request.ratio?.split(":").map(Number);
  if (pixels && ratio?.length === 2 && Number(pixels[1]) * ratio[1]! !== Number(pixels[2]) * ratio[0]!) throw new Error(`图片尺寸 ${value} 与画幅 ${request.ratio} 不一致，请选择匹配规格，不会自动改变用户选择`);
  if (kind === "image" && request.ratio && model.imageRatios?.length && !model.imageRatios.includes(request.ratio) && !pixels) throw new Error(`当前模型不支持图片画幅 ${request.ratio}；不会回退到默认比例，此次未提交生成`);
  if (kind === "video" && value && request.duration !== undefined && model.durationResolutionMap?.length && !model.durationResolutionMap.some(rule => rule.resolution.includes(value) && rule.duration.includes(request.duration!))) throw new Error(`视频 ${value} 不支持 ${request.duration} 秒，请保持所选精度并调整时长，或由用户改选精度`);
  return value ? { ...request, [field]: value } : request;
}
