import { z } from "zod";
import conf from "@/utils/conf";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";

const choice = z.strictObject({ providerId: z.string().trim().min(1).max(200), modelId: z.string().trim().min(1).max(300) }).nullable().optional();
export const modelSelectionSchema = z.strictObject({ text: choice, videoReview: choice, image: choice, imageEdit: choice, video: choice, audio: choice });
export type ModelKind = keyof z.infer<typeof modelSelectionSchema>;

export function usesPlatformDefaults() {
  const tenant = currentTenant();
  return !!tenant && cloud()?.modelPermissions(tenant.userId).canManage === false;
}

export function selectedModel(kind: ModelKind) {
  const parsed = modelSelectionSchema.safeParse(conf.get("settings", {}).modelSelection ?? {});
  return parsed.success ? parsed.data[kind] ?? (kind === "videoReview" ? parsed.data.text : undefined) : undefined;
}

export function isSelectedModel(kind: ModelKind, providerId: string, modelId: string) {
  const selected = selectedModel(kind);
  return selected?.providerId === providerId && selected.modelId === modelId;
}

export function assertModelSelection(kind: ModelKind, providerId: string, modelId: string) {
  const tenant = currentTenant();
  if (tenant) cloud()?.requireModelAccess(tenant.userId);
  const label = { text: "对话", videoReview: "视频审阅", image: "图片", imageEdit: "图片编辑", video: "视频", audio: "配音" }[kind];
  const selected = selectedModel(kind);
  if (usesPlatformDefaults()) {
    if (!selected) throw Object.assign(new Error(`超级管理员尚未设置${label}默认模型，请联系超级管理员配置。`), { status: 400, retryable: false });
    if (!isSelectedModel(kind, providerId, modelId)) throw Object.assign(new Error(`平台${label}默认模型已更新为 ${selected.providerId} / ${selected.modelId}，请刷新后使用管理员设置的默认模型。`), { status: 409, retryable: false });
    return;
  }
  const action = kind === "text" ? "请在对话的模型选择器中选择并保存" : kind === "videoReview" ? "请在设置 → 默认模型中选择支持视频与声音理解的「视频审阅」模型" : kind === "imageEdit" ? "请在设置 → 默认模型中选择「图片编辑 / 溶图」模型，或清空它以跟随图片生成模型" : "请通过 requestProductionDecision(selectModel) 在聊天中选择并保存，无需跳转设置页";
  if (!selected) throw Object.assign(new Error(`尚未设置${label}模型。${action}，系统不会自动选择或切换。`), { status: 400, retryable: false });
  if (!isSelectedModel(kind, providerId, modelId)) {
    // 两边必须一致才能生成：这个镜头记着自己的模型，用户选定的是另一个。说清楚是哪两处不一致，比一句「禁止改用」有用。
    throw Object.assign(new Error(`这个${label}任务用的是 ${providerId} / ${modelId}，你当前选定的是 ${selected.providerId} / ${selected.modelId}，两者不一致。二选一：把这个镜头/节点的模型改回已选定的那个，或者${action}换成前者。系统不会自己替你选。`), { status: 400, retryable: false });
  }
}

/**
 * 带参考图的图像任务（溶图、局部编辑、多图参考）走「图片编辑 / 溶图」模型。
 * 未单独设置时返回原请求，沿用图片生成模型；用户明确另选了非默认模型时不替他改写。
 */
export function routeImageEditModel<T extends MediaGenerationRequest>(request: T, hasImageReferences = !!request.images?.length): T {
  if (!hasImageReferences) return request;
  const edit = selectedModel("imageEdit");
  if (!edit || isSelectedModel("imageEdit", request.providerId, request.modelId)) return request;
  const image = selectedModel("image");
  if (image && !isSelectedModel("image", request.providerId, request.modelId)) return request;
  return { ...request, providerId: edit.providerId, modelId: edit.modelId };
}

export async function assertMediaModelSelection(kind: "image" | "video" | "audio", request: MediaGenerationRequest, directory: string) {
  if (kind === "audio" && request.voiceLineId) {
    const { assertVoiceSpeechRequest } = await import("@/utils/media/voiceDecision");
    return (await assertVoiceSpeechRequest(directory, request)).request;
  }
  if (kind === "video") {
    const { isVoiceSyncRequest } = await import("@/utils/media/voiceDecision");
    // 口型选择属于配音方案；仅允许选定声音和原视频的配对请求，不改变正式镜头的默认模型。
    if (await isVoiceSyncRequest(directory, request)) return request;
  }
  if (kind === "image") request = routeImageEditModel(request);
  const selectionKind: ModelKind = kind === "image" && request.images?.length && selectedModel("imageEdit") ? "imageEdit" : kind;
  assertModelSelection(selectionKind, request.providerId, request.modelId);
  return request;
}
