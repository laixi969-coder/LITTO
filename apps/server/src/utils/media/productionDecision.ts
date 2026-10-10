import type { QuestionContext } from "@toonflow/tools-scaffold/runtime";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { workspaceProject } from "@/utils/media/jobs";
import { requestVoiceDecision } from "@/utils/media/voiceDecision";

export async function requestProductionDecision(directory: string, toolCallId: string, input: { operation: string; data: Record<string, unknown>; reconsider?: boolean }, question: QuestionContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (input.operation === "selectVoice" || input.operation === "configureVoice") return requestVoiceDecision(directory, toolCallId, input, question, signal);
  const api = cloud(), tenant = currentTenant();
  if (!api || !tenant || tenant.role === "VIEWER") throw new Error("制作选择需要已登录且有编辑权限的工作区");
  const projectId = workspaceProject(directory)!;
  const scope = api.scoped(tenant.workspaceId);
  const prepared = api.prepareProductionDecision(scope, projectId, input, input.reconsider);
  if (prepared.completed) return { title: prepared.request.title, applied: true, selectedId: prepared.selectedId, answer: "此决定已保存且仍有效，无需重复确认" };
  const response = await question.ask(toolCallId, prepared.request, signal);
  signal?.throwIfAborted();
  if (response.skipped || response.answer === "暂不决定" || response.values?.decision === "暂不决定") return { ...prepared.request, ...response, applied: false };
  const member = api.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
  if (!member || member.role === "VIEWER") throw new Error("制作选择的编辑权限已失效");
  if (workspaceProject(directory) !== projectId) throw new Error("工作目录关联项目已改变，请重新确认");
  const result = api.applyProductionDecision(scope, projectId, prepared, response, tenant.userId);
  let answer = result.applied ? "决定已保存，可继续已授权的后续工作" : "本次未采用，已保留候选";
  if (result.applied && input.operation === "reviewOutput") answer = "检查记录已保存；存在问题的素材须修复或复核后采用";
  if (result.applied && input.operation === "reviewFinal") answer = (result.result as { status: string }).status === "pass" ? "最终声画验收已通过" : "验收记录已保存，成片尚未通过最终验收";
  return { ...prepared.request, ...result, answer };
}
