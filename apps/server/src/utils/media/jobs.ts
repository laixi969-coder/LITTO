import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "@toonflow/file";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import type { GenRequest, GenResult } from "@/lib/cloud";
import { cloud } from "@/lib/cloud";
import { currentTenant, tenantStore } from "@/utils/tenant";
import { resolveWorkspaceDirectory } from "@/utils/workspace";
import { resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { generateMediaDirect, listMediaModels } from "@/utils/media/generation";
import { assertModelSelection } from "@/utils/modelSelection";

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
  assertModelSelection(kind, request.providerId, request.modelId);
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api || tenant.role === "VIEWER") throw Object.assign(new Error("无权生成媒体"), { status: 403 });
  const models = await listMediaModels();
  if (!models.some((model) => model.providerId === request.providerId && model.modelId === request.modelId && model.type === kind))
    throw Object.assign(new Error("所选媒体模型不存在或类型不匹配"), { status: 400 });
  const projectId = workspaceProject(directory)!;
  const production = request.shotId ? await prepareShot(directory, kind, request.shotId, request) : undefined;
  if (production && request.productionFingerprint !== production.fingerprint) throw Object.assign(new Error("镜头规格须先预览；请重新编译后提交"), { status: 409 });
  return api.enqueueWorkspaceMedia({
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    projectId,
    directory,
    kind,
    request: { ...request, ...(production ? { prompt: production.compiled.prompt + "\nAVOID: " + production.compiled.negativePrompt } : {}) },
    requestId,
    production,
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
      const request = { ...input.params.request as MediaGenerationRequest };
      if (request.providerId !== providerId || request.modelId !== modelId) throw new Error("生成模型不匹配");
      if (input.params.fingerprint) {
        request.prompt = input.prompt;
        request.images = [];
        request.videos = [];
        request.audios = [];
        delete request.firstFrame;
        delete request.lastFrame;
        for (const [index, reference] of input.inputs.entries()) {
          if (!reference.data || !/^(image|video|audio)\//.test(reference.mime)) throw new Error("镜头参考媒体不可读");
          const folder = `assets/productionRefs/${context.jobId}`;
          const resolved = await resolveWorkspacePath(directory, folder, true);
          await mkdir(resolved.path, { recursive: true });
          const name = `reference${index}${crypto.randomUUID()}`;
          await writeWorkspaceFile(join(resolved.path, name), reference.data, true);
          const file = { path: `${folder}/${name}`, mimeType: reference.mime };
          if (reference.mime.startsWith("video/")) request.videos.push(file);
          else if (reference.mime.startsWith("audio/")) request.audios.push(file);
          else if (input.kind === "video" && reference.role === "START_FRAME" && !Array.isArray(request.mode)) request.firstFrame = file;
          else if (reference.role === "END_FRAME") request.lastFrame = file;
          else request.images.push(file);
        }
      }
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

export async function prepareShot(directory: string, kind: "image" | "video", shotId: string, request: MediaGenerationRequest) {
  assertModelSelection(kind, request.providerId, request.modelId);
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api || tenant.role === "VIEWER") throw Object.assign(new Error("无权制作镜头"), { status: 403 });
  const model = (await listMediaModels()).find(item => item.providerId === request.providerId && item.modelId === request.modelId && item.type === kind);
  if (!model) throw Object.assign(new Error("模型不存在"), { status: 400 });
  if (kind === "video") {
    // 模式可能是字符串或一组参考上限；按完整候选比较，不能接受客户端自报能力。
    const modes = Array.isArray(model.mode) ? model.mode : [model.mode];
    if (!modes.some(mode => JSON.stringify(mode) === JSON.stringify(request.mode))) throw Object.assign(new Error("所选模式不受模型支持"), { status: 400 });
    if (model.durationResolutionMap?.length && !model.durationResolutionMap.some(rule => rule.duration.includes(request.duration!) && rule.resolution.includes(request.resolution!))) throw Object.assign(new Error("时长与分辨率组合不受模型支持"), { status: 400 });
  }
  const result = api.prepareWorkspaceShot({ workspaceId: tenant.workspaceId, projectId: workspaceProject(directory)!, shotId, kind,
    providerId: request.providerId, modelId: request.modelId, mode: kind === "image" ? model.mode : request.mode });
  if (kind === "video" && request.duration !== result.duration) throw Object.assign(new Error("生成时长须与镜头的生成时长规格一致，请先保存"), { status: 400 });
  result.fingerprint = createHash("sha256").update(JSON.stringify([result.fingerprint, request.ratio, request.size, request.resolution, request.duration, request.generateAudio])).digest("hex");
  return result;
}
