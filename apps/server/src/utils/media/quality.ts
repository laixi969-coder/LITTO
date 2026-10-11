import { readFile, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { MediaGenerationRequest, MediaModel, QuestionContext } from "@toonflow/tools-scaffold/runtime";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { listMediaModels } from "@/utils/media/generation";
import { currentTenant } from "@/utils/tenant";
import { cloud } from "@/lib/cloud";

const qualitySchema = z.strictObject({ kind: z.enum(["image", "video"]), providerId: z.string().min(1), modelId: z.string().min(1), value: z.string().min(1).max(64) });
const preferencesSchema = z.array(qualitySchema).max(200);

export function qualityOptions(model: MediaModel) {
  return [...new Set(model.type === "image" ? model.imageSizes ?? [] : model.durationResolutionMap?.flatMap(rule => rule.resolution) ?? [])];
}

export async function readMediaQuality(directory: string) {
  const { path } = await resolveWorkspacePath(directory, "mediaQuality.json", true);
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return { path, content, preferences: content === null ? [] : preferencesSchema.parse(JSON.parse(content)) };
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
  if (kind === "audio" || model.lipSync) return request;
  const field = kind === "image" ? "size" : "resolution";
  const saved = (await readMediaQuality(directory)).preferences.find(item => item.kind === kind && item.providerId === request.providerId && item.modelId === request.modelId);
  const value = request[field] ?? saved?.value;
  const options = qualityOptions(model);
  if (!value && options.length > 1) throw new Error(`尚未选择${kind === "image" ? "图片精度" : "视频分辨率"}，请用 requestProductionDecision(selectQuality) 在聊天中选择；用户已明确指定时用 productionSpec(setQuality) 保存。此次未提交生成。`);
  if (value && options.length && !options.includes(value)) throw new Error(`所选精度 ${value} 不受当前模型支持，可选：${options.join("、")}。未提交生成，不会静默降级。`);
  const pixels = kind === "image" && value ? /^(\d+)[x*](\d+)$/.exec(value) : null;
  const ratio = request.ratio?.split(":").map(Number);
  if (pixels && ratio?.length === 2 && Number(pixels[1]) * ratio[1]! !== Number(pixels[2]) * ratio[0]!) throw new Error(`图片尺寸 ${value} 与画幅 ${request.ratio} 不一致，请选择匹配规格，不会自动改变用户选择`);
  if (kind === "video" && value && request.duration !== undefined && model.durationResolutionMap?.length && !model.durationResolutionMap.some(rule => rule.resolution.includes(value) && rule.duration.includes(request.duration!))) throw new Error(`视频 ${value} 不支持 ${request.duration} 秒，请保持所选精度并调整时长，或由用户改选精度`);
  return value ? { ...request, [field]: value } : request;
}
