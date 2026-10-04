import { basename } from "node:path";
import { readFile } from "@toonflow/file";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import type { GenRequest, GenResult } from "@/lib/cloud";
import { cloud } from "@/lib/cloud";
import { currentTenant, tenantStore } from "@/utils/tenant";
import { resolveWorkspaceDirectory } from "@/utils/workspace";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMediaDirect, listMediaModels } from "@/utils/media/generation";

export function workspaceProject(directory: string) {
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api) return undefined;
  const link = api.dbGet("SELECT project_id FROM workspace_project_links WHERE workspace_id=? AND directory=?", tenant.workspaceId, directory);
  if (link && api.scoped(tenant.workspaceId).get("projects", link.project_id)) return link.project_id as string;
  if (tenant.role === "VIEWER") return undefined;
  return api.linkWorkspaceProject(tenant.workspaceId, directory, basename(directory));
}

export async function enqueueMedia(directory: string, kind: "image" | "video", request: MediaGenerationRequest, requestId: string) {
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api || tenant.role === "VIEWER") throw Object.assign(new Error("无权生成媒体"), { status: 403 });
  const models = await listMediaModels();
  if (!models.some((model) => model.providerId === request.providerId && model.modelId === request.modelId && model.type === kind))
    throw Object.assign(new Error("所选媒体模型不存在或类型不匹配"), { status: 400 });
  const projectId = workspaceProject(directory)!;
  return api.enqueueWorkspaceMedia({
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    projectId,
    directory,
    kind,
    request: { ...request },
    requestId,
  });
}

export async function executeMediaJob(input: GenRequest): Promise<GenResult> {
  const api = cloud();
  const context = input.context;
  if (!api || !context || !["image", "video"].includes(input.kind)) throw new Error("工作区任务上下文无效");
  const member = api.dbGet(
    "SELECT u.id,u.email,u.is_admin,m.role FROM users u JOIN workspace_members m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=? AND m.workspace_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL",
    context.userId,
    context.workspaceId,
  );
  if (!member || member.role === "VIEWER") throw new Error("生成权限已失效");
  const project = api.scoped(context.workspaceId).get("projects", context.projectId!);
  if (!project) throw new Error("项目已失效");
  const [providerId, modelId] = JSON.parse(input.externalModelId) as [string, string];
  return tenantStore.run(
    { userId: member.id, email: member.email, isAdmin: !!member.is_admin, role: member.role, workspaceId: context.workspaceId },
    async () => {
      const directory = await resolveWorkspaceDirectory(String(input.params.directory));
      const link = api.dbGet("SELECT project_id FROM workspace_project_links WHERE workspace_id=? AND directory=?", context.workspaceId, directory);
      if (link?.project_id !== context.projectId) throw new Error("工作目录与项目不匹配");
      const request = input.params.request as MediaGenerationRequest;
      if (request.providerId !== providerId || request.modelId !== modelId) throw new Error("生成模型不匹配");
      const files = await generateMediaDirect(directory, input.kind as "image" | "video", request, input.signal);
      const outputs = [];
      for (const file of files) {
        const { path } = await resolveWorkspacePath(directory, file.path);
        outputs.push({
          data: await readFile(path),
          mime: file.mimeType,
          workspacePath: file.path,
          duration: input.kind === "video" ? request.duration : undefined,
        });
      }
      return { outputs, costUsd: null };
    },
  );
}
