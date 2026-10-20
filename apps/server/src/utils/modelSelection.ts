import { z } from "zod";
import conf from "@/utils/conf";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";

const choice = z.strictObject({ providerId: z.string().trim().min(1).max(200), modelId: z.string().trim().min(1).max(300) }).nullable().optional();
export const modelSelectionSchema = z.strictObject({ text: choice, image: choice, video: choice, audio: choice });
export type ModelKind = keyof z.infer<typeof modelSelectionSchema>;

export function selectedModel(kind: ModelKind) {
  const parsed = modelSelectionSchema.safeParse(conf.get("settings", {}).modelSelection ?? {});
  return parsed.success ? parsed.data[kind] : undefined;
}

export function isSelectedModel(kind: ModelKind, providerId: string, modelId: string) {
  const selected = selectedModel(kind);
  return selected?.providerId === providerId && selected.modelId === modelId;
}

export function assertModelSelection(kind: ModelKind, providerId: string, modelId: string) {
  const label = { text: "对话", image: "图片", video: "视频", audio: "配音" }[kind];
  const selected = selectedModel(kind);
  const action = kind === "text" ? "请在对话的模型选择器中选择并保存" : "请通过 requestProductionDecision(selectModel) 在聊天中选择并保存，无需跳转设置页";
  if (!selected) throw Object.assign(new Error(`尚未设置${label}模型。${action}，系统不会自动选择或切换。`), { status: 400, retryable: false });
  if (!isSelectedModel(kind, providerId, modelId)) {
    // 两边必须一致才能生成：这个镜头记着自己的模型，用户选定的是另一个。说清楚是哪两处不一致，比一句「禁止改用」有用。
    throw Object.assign(new Error(`这个${label}任务用的是 ${providerId} / ${modelId}，你当前选定的是 ${selected.providerId} / ${selected.modelId}，两者不一致。二选一：把这个镜头/节点的模型改回已选定的那个，或者${action}换成前者。系统不会自己替你选。`), { status: 400, retryable: false });
  }
}

export async function assertMediaModelSelection(kind: "image" | "video" | "audio", request: MediaGenerationRequest, directory: string) {
  if (kind === "video") {
    const { isVoiceSyncRequest } = await import("@/utils/media/voiceDecision");
    // 口型选择属于配音方案；仅允许选定声音和原视频的配对请求，不改变正式镜头的默认模型。
    if (await isVoiceSyncRequest(directory, request)) return;
  }
  assertModelSelection(kind, request.providerId, request.modelId);
}
