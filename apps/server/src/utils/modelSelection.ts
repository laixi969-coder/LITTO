import { z } from "zod";
import conf from "@/utils/conf";

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
  if (!isSelectedModel(kind, providerId, modelId)) throw Object.assign(new Error(`用户选定的${label}模型为 ${selected.providerId} / ${selected.modelId}，禁止改用 ${providerId} / ${modelId}。如需更换，${action}。`), { status: 400, retryable: false });
}
