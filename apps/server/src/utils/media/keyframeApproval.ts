import type { QuestionContext, QuestionRequest } from "@toonflow/tools-scaffold/runtime";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { workspaceProject } from "@/utils/media/jobs";

export async function requestKeyframeApproval(directory: string, toolCallId: string, keyframeIds: string[], question: QuestionContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const api = cloud(), tenant = currentTenant();
  if (!api || !tenant || tenant.role === "VIEWER") throw new Error("采用关键帧需要已登录且有编辑权限的工作区");
  const projectId = workspaceProject(directory)!;
  const scope = api.scoped(tenant.workspaceId);
  const frames = api.prepareKeyframeApproval(scope, projectId, keyframeIds);
  const pending = frames.filter(item => !item.approved);
  const title = `采用 ${pending.length || frames.length} 个镜头的主关键帧`;
  if (!pending.length) return { title, approved: true, keyframes: frames.map(item => ({ shotId: item.shotId, heroKeyframeId: item.id })), answer: "这些关键帧已采用，无需再次确认" };
  const request: QuestionRequest = {
    title,
    question: "请查看下列图片，核对材质、成像、空间关系与电影感。确认后会一次保存为各镜头的主关键帧，可继续生成视频。已有主帧被替换时仍保留旧版本。",
    images: pending.map(item => ({ id: item.id, title: item.title, url: item.media.url.startsWith("/") ? `/cloud${item.media.url}` : item.media.url })),
    options: ["已看过并采用以上全部关键帧", "暂不采用"],
  };
  const response = await question.ask(toolCallId, request, signal);
  signal?.throwIfAborted();
  if (response.skipped || response.answer !== request.options![0]) return { ...request, ...response, approved: false };
  const member = api.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
  if (!member || member.role === "VIEWER") throw new Error("采用关键帧的编辑权限已失效");
  if (workspaceProject(directory) !== projectId) throw new Error("工作目录关联项目已改变，请重新确认");
  const keyframes = api.approveKeyframes(scope, projectId, frames, tenant.userId);
  return { ...request, approved: true, keyframes, answer: `已保存 ${pending.length} 个镜头的主关键帧，可继续已授权的后续工作` };
}
