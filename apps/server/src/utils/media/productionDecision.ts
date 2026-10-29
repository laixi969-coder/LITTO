import type { QuestionContext } from "@toonflow/tools-scaffold/runtime";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { workspaceProject } from "@/utils/media/jobs";
import { requestVoiceDecision } from "@/utils/media/voiceDecision";
import { z } from "zod";
import conf from "@/utils/conf";
import { listMediaModels } from "@/utils/media/generation";
import { modelSelectionSchema, selectedModel, usesPlatformDefaults } from "@/utils/modelSelection";
import { requestMediaQuality } from "@/utils/media/quality";

async function requestModelDecision(toolCallId: string, input: { data: Record<string, unknown>; reconsider?: boolean }, question: QuestionContext, signal?: AbortSignal) {
  const data = z.strictObject({ kind: z.enum(["image", "video", "audio"]), providerId: z.string().min(1).optional(), modelId: z.string().min(1).optional() })
    .refine(value => !!value.providerId === !!value.modelId, "providerId 和 modelId 须同时提供").parse(input.data);
  const tenant = currentTenant();
  if (tenant) cloud()!.requireModelAccess(tenant.userId);
  const available = await listMediaModels(true);
  const requested = available.find(model => model.type === data.kind && model.providerId === data.providerId && model.modelId === data.modelId);
  if (requested?.lipSync) return {
    title: "口型模型使用独立配音方案", applied: false,
    selection: selectedModel(data.kind) ?? null,
    nextAction: { tool: "requestProductionDecision", operation: "configureVoice", lipSyncProviderId: requested.providerId, lipSyncModelId: requested.modelId },
    answer: "该口型模型可用，但 selectModel 不保存口型选择。先 productionSpec(readVoice)，保留已有角色、台词及候选，在 project 中设置 lipSyncProviderId/lipSyncModelId，再 requestProductionDecision(configureVoice,{project}) 保存。随后用已采用声音和人物原片调用 generateVideo，purpose=standalone，不传 shotId/productionFingerprint。无需修改默认视频模型，也无需放行 approveTake；处理后实际看听、inspectSpeech/importSpeech，再 reviewProduction 采用。",
  };
  if (usesPlatformDefaults()) {
    const selection = selectedModel(data.kind);
    if (!selection) throw new Error("该类平台默认模型尚未设置，请由超级管理员在管理后台 → 默认模型中配置");
    if (!available.some(model => model.type === data.kind && model.providerId === selection.providerId && model.modelId === selection.modelId))
      throw new Error("平台默认模型当前不可用，请联系超级管理员检查配置与额度");
    if (data.providerId && (data.providerId !== selection.providerId || data.modelId !== selection.modelId)) return {
      title: "未更改平台默认模型", applied: false, selection,
      answer: "指定模型未被选用，平台默认模型保持不变。角色配音与专用口型通过 configureVoice 独立绑定，先 listMediaModels{all:true} 核对能力与可用性；不能把默认模型不可切换当成口型不可用。",
    };
    return { title: "沿用平台默认模型", applied: true, selection, answer: "直接使用超级管理员设置的默认模型，无需用户选择或配置" };
  }
  const models = available.filter(model => model.type === data.kind && !model.lipSync && (!data.providerId || model.providerId === data.providerId && model.modelId === data.modelId));
  if (!models.length) throw new Error("没有匹配的可用模型，请先配置供应商或恢复连接与额度");
  const previous = selectedModel(data.kind);
  if (!input.reconsider && previous && models.some(model => model.providerId === previous.providerId && model.modelId === previous.modelId))
    return { title: "模型已选定", applied: true, selection: previous, answer: "沿用已选模型，后续同类任务无需重复选择或确认" };
  const label = { image: "图片", video: "视频", audio: "配音与音频" }[data.kind];
  const request = {
    title: `选择${label}模型`,
    question: `请选择后续${label}任务使用的模型。选择后直接保存为当前工作区默认值，节点和助手共用。`,
    options: [...models.map((model, index) => `${index + 1}. ${model.providerLabel} · ${model.label}`), "暂不决定"],
  };
  const response = await question.ask(toolCallId, request, signal);
  signal?.throwIfAborted();
  const index = request.options.indexOf(response.answer);
  if (response.skipped || index < 0 || index >= models.length) return { ...request, ...response, applied: false };
  const chosen = models[index]!;
  if (!(await listMediaModels(true)).some(model => model.type === data.kind && model.providerId === chosen.providerId && model.modelId === chosen.modelId)) throw new Error("所选模型已不可用，本次未更改设置");
  signal?.throwIfAborted();
  const current = selectedModel(data.kind);
  if (current?.providerId === chosen.providerId && current.modelId === chosen.modelId) return { ...request, applied: true, answer: "该模型已选定，无需重复保存" };
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error("模型选择已在其他操作中改变，本次未覆盖，请重新核对");
  const settings = conf.get("settings", {});
  const selection = modelSelectionSchema.parse(settings.modelSelection ?? {});
  conf.set("settings", { ...settings, modelSelection: { ...selection, [data.kind]: { providerId: chosen.providerId, modelId: chosen.modelId } } });
  return { ...request, applied: true, answer: `已选用 ${chosen.providerLabel} · ${chosen.label}，可继续已授权的任务，无需前往设置页或再次确认` };
}

export async function requestProductionDecision(directory: string, toolCallId: string, input: { operation: string; data: Record<string, unknown>; reconsider?: boolean }, question: QuestionContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (input.operation === "selectQuality") return requestMediaQuality(directory, toolCallId, input, question, signal);
  if (input.operation === "selectModel") return requestModelDecision(toolCallId, input, question, signal);
  if (input.operation === "selectVoice" || input.operation === "configureVoice") return requestVoiceDecision(directory, toolCallId, input, question, signal);
  const api = cloud(), tenant = currentTenant();
  if (!api || !tenant || tenant.role === "VIEWER") throw new Error("制作选择需要已登录且有编辑权限的工作区");
  const projectId = workspaceProject(directory)!;
  const scope = api.scoped(tenant.workspaceId);
  const prepared = api.prepareProductionDecision(scope, projectId, input, input.reconsider);
  if (prepared.completed) return { title: prepared.request.title, applied: true, selectedId: prepared.selectedId, reviewRequired: prepared.reviewRequired,
    answer: prepared.reviewRequired ? "选择已保存，无需重复确认；技术检查须由助手复核，原生成与导出门禁仍生效" : "此决定已保存且仍有效，无需重复确认" };
  if (prepared.action.operation === "updateShot" && !input.reconsider) {
    try {
      const { shotId, patch } = prepared.action.data;
      const result = api.workspaceProduction(scope, projectId, "updateShot", { ...patch, shotId }, tenant.userId);
      return { title: prepared.request.title, applied: true, result, answer: "镜头修改已保存；此修改不需要再次确认" };
    } catch (error) {
      // 复用领域层的确认边界；仅已采用镜头的实质变更继续展示确认卡。
      if ((error as { code?: string }).code !== "needs_confirmation") throw error;
    }
  }
  const response = await question.ask(toolCallId, prepared.request, signal);
  signal?.throwIfAborted();
  if (response.skipped || response.answer === "暂不决定" || response.values?.decision === "暂不决定") return { ...prepared.request, ...response, applied: false };
  const member = api.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
  if (!member || member.role === "VIEWER") throw new Error("制作选择的编辑权限已失效");
  if (workspaceProject(directory) !== projectId) throw new Error("工作目录关联项目已改变，请重新确认");
  const result = await api.applyProductionDecision(scope, projectId, prepared, response, question.decisionSource ? `agent:${tenant.userId}` : tenant.userId);
  if ("feedback" in result) return { ...prepared.request, ...result };
  let answer = result.applied ? "决定已保存，可继续已授权的后续工作" : "本次未采用，已保留候选";
  return { ...prepared.request, ...result, answer };
}
