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
  const reviewRequired = frames.filter(item => item.reviewRequired).map(item => item.id);
  const title = `采用 ${pending.length || frames.length} 个镜头的主关键帧`;
  if (!pending.length) return { title, approved: true, reviewRequired, keyframes: frames.map(item => ({ shotId: item.shotId, heroKeyframeId: item.id })), answer: reviewRequired.length ? "选图决定已保存，无需重新选择或确认。部分镜头规格或检查记录已变化，助手须复核当前素材；技术门禁仍生效，不能靠重复采用解除。" : "这些关键帧已采用，无需再次确认" };
  const request: QuestionRequest = {
    title,
    question: `请查看候选与质感参考，分别核对故事、服装和空间是否正确，以及材质、曝光、光色和构图是否达到目标。参考只借成像关系，场景时段与人物仍按本镜。\n${pending.map(item => `${item.title}：${item.visualTarget || "沿用当前视觉方案"}`).join("\n")}\n确认后保存为主关键帧，可继续已授权的视频生成；旧版本保留。`,
    images: [
      ...pending.map(item => ({ id: item.id, title: `${item.title} · 候选`, url: item.media.url.startsWith("/") ? `/cloud${item.media.url}` : item.media.url })),
      ...[...new Map(pending.flatMap(item => item.lookReferences).map(reference => [reference.media.id, reference])).values()].map(reference => ({ id: reference.media.id, title: `${reference.name} · 质感对照`, url: reference.media.url.startsWith("/") ? `/cloud${reference.media.url}` : reference.media.url })),
    ],
    options: ["已看过并采用以上全部关键帧", "暂不采用"],
  };
  const response = await question.ask(toolCallId, request, signal);
  signal?.throwIfAborted();
  if (response.requestedChanges || response.skipped || response.answer !== request.options![0]) return { ...request, ...response, approved: false };
  const member = api.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
  if (!member || member.role === "VIEWER") throw new Error("采用关键帧的编辑权限已失效");
  if (workspaceProject(directory) !== projectId) throw new Error("工作目录关联项目已改变，请重新确认");
  const keyframes = api.approveKeyframes(scope, projectId, frames, tenant.userId);
  return { ...request, approved: true, reviewRequired, keyframes, answer: `已保存 ${pending.length} 个镜头的主关键帧，可继续已授权的后续工作` };
}
