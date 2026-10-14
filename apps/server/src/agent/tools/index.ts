import { createHash } from "node:crypto";
import { storyImpact } from "@toonflow/tool-scene-list/storyProject";
import { t } from "@/lib/i18n";
import { listMediaModels, generateMedia, readReference } from "@/utils/media/generation";
import { z } from "zod";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { basename, dirname, join, relative, resolve } from "node:path";
import { access, constants, copyFile, lstat, mkdir, readFile, readdir, rm, rmdir, stat, withFileAccess } from "@toonflow/file";
import {
  defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition,
  detectSupportedImageMimeTypeFromFile, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CanvasContext, QuestionContext, ToolContext, ToolFiles } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { isWithin, resolveWorkspacePath, writeWorkspaceFile, renameWorkspaceFile, lockWorkspaceFiles, protectWorkspaceRoot } from "@/utils/workspace/files";
import { listTools, loadTool, validateToolConfig } from "@/utils/plugins/tools";
import { createSkillContext } from "@/agent/skills";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { workspaceProject, prepareShot } from "@/utils/media/jobs";
import { imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { readStoryContext, readStoryProject, applyStoryAction, checkSources, requestStoryApproval, requestStoryDecision } from "@/utils/story";
import { requestKeyframeApproval } from "@/utils/media/keyframeApproval";
import { requestProductionDecision } from "@/utils/media/productionDecision";
import { readVoiceProject } from "@/utils/media/voiceDecision";
import { readMediaQuality, saveMediaQuality } from "@/utils/media/quality";
import { listAiModels } from "@/utils/ai";

export function createAgentToolContext(cwd: string, config: Record<string, unknown> = {}, canvas?: CanvasContext, question?: QuestionContext, parentSignal?: AbortSignal): ToolContext {
  const skillsDirectory = join(dirname(conf.path), "skills");
  const resolvePath = async (path: string, readOnly = false) => {
    const absolute = resolve(cwd, path);
    const root = readOnly && isWithin(skillsDirectory, absolute) ? skillsDirectory : cwd;
    return (await resolveWorkspacePath(root, relative(root, absolute), true)).path;
  };
  const withWritePaths = async (paths: string[], operation: (targets: string[]) => Promise<void>) => {
    const targets = await Promise.all(paths.map(path => resolvePath(path)));
    const release = lockWorkspaceFiles(targets);
    try { await operation(targets); }
    finally { release(); }
  };
  const mediaSignal = (signal?: AbortSignal) => parentSignal && signal ? AbortSignal.any([parentSignal, signal]) : parentSignal ?? signal;
  async function publishFile(path: string, signal?: AbortSignal) {
    if (!canvas) return;
    try { await canvas.call({ name: "publishFile", args: { path } }, mediaSignal(signal)); }
    catch (error) { throw new Error(`文件已保存：${path}，但画布展示失败：${error instanceof Error ? error.message : error}。仅重试 publishFile，禁止重新生成或覆盖文件。`); }
  }
  async function generateAndPublish(kind: "image" | "video" | "audio", request: Parameters<typeof generateMedia>[2], signal?: AbortSignal, onProgress?: (message: string) => void) {
    if (kind !== "audio" && !request.shotId && !request.purpose) {
      const api = cloud(), tenant = currentTenant();
      const projectId = api && tenant ? workspaceProject(cwd) : undefined;
      if (projectId && api!.scoped(tenant!.workspaceId).list("shots", { projectId }).length) {
        throw new Error("当前项目已有正式镜头，生成分镜须传 shotId 并先 compile 取得 productionFingerprint，以继承共同质感与参考。仅基础资产可标 purpose=asset；用户明确要求的独立画面可标 purpose=standalone。此次未提交生成、未消耗算力。");
      }
    }
    const result = await generateMedia(cwd, kind, request, mediaSignal(signal), onProgress);
    onProgress?.("结果已保存，正在补充画布节点与连线");
    for (const asset of result) await publishFile(asset.path, signal);
    return result;
  }
  const files: ToolFiles = {
    readFile: async (path, readOnly = false) => readFile(await resolvePath(path, readOnly)),
    access: async (path, readOnly = false) => access(await resolvePath(path, readOnly)),
    stat: async (path, readOnly = false) => stat(await resolvePath(path, readOnly)),
    readdir: async (path, readOnly = false) => readdir(await resolvePath(path, readOnly)),
    detectImageMimeType: async (path, readOnly = false) => {
      const target = await resolvePath(path, readOnly);
      return withFileAccess([target], "read", () => detectSupportedImageMimeTypeFromFile(target));
    },
    async writeFile(path, content, exclusive = false) {
      await withWritePaths([path], async ([target]) => { await writeWorkspaceFile(target, content, exclusive); });
      if (/\.(md|markdown|txt)$/i.test(path)) await publishFile(relative(cwd, await resolvePath(path)).split("\\").join("/"));
    },
    async mkdir(path, recursive = false) {
      const target = await resolvePath(path);
      const info = recursive ? await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; }) : null;
      // SDK 写文件前会确保父目录存在；已有目录无需加锁，否则会撞上目录内正在运行的对话锁。
      if (info?.isDirectory()) return;
      await withWritePaths([path], async ([target]) => { await mkdir(target, { recursive }); });
    },
    rename: (path, target) => withWritePaths([path, target], async ([source, destination]) => {
      protectWorkspaceRoot(cwd, source);
      protectWorkspaceRoot(cwd, destination);
      await renameWorkspaceFile(source, resolve(dirname(destination), basename(resolve(cwd, target))));
    }),
    remove: (path, recursive = false) => withWritePaths([path], async ([target]) => {
      protectWorkspaceRoot(cwd, target);
      if ((await lstat(target)).isDirectory() && !recursive) await rmdir(target);
      else await rm(target, { recursive });
    }),
    copyFile: (path, target, exclusive = false) => withWritePaths([path, target], async ([source, destination]) => {
      protectWorkspaceRoot(cwd, destination);
      await copyFile(source, destination, exclusive ? constants.COPYFILE_EXCL : 0);
    }),
  };
  return {
    story: {
      read: () => readStoryContext(cwd),
      validateSources: async () => checkSources(cwd, (await readStoryProject(cwd)).sources),
      apply: (version, action) => applyStoryAction(cwd, version, action),
      requestApproval: question ? (toolCallId, revisionId, signal) => requestStoryApproval(cwd, toolCallId, revisionId, question, mediaSignal(signal)) : undefined,
      requestDecision: question ? (toolCallId, decision, signal) => requestStoryDecision(cwd, toolCallId, decision, question, mediaSignal(signal)) : undefined,
    },
    cwd, config, files, resolvePath, writeFile: files.writeFile, canvas, question, skills: createSkillContext(cwd),
    ffmpeg: signal => createWorkspaceFfmpeg(cwd, signal),
    media: {
      requestProductionDecision: question ? (toolCallId, input, signal) => requestProductionDecision(cwd, toolCallId, input, question, mediaSignal(signal)) : undefined,
      requestKeyframeApproval: question ? (toolCallId, keyframeIds, signal) => requestKeyframeApproval(cwd, toolCallId, keyframeIds, question, mediaSignal(signal)) : undefined,
      async production(operation, data, signal) {
        signal?.throwIfAborted();
        if (operation === "readVoice") return (await readVoiceProject(cwd)).project;
        if (operation === "readQuality") return (await readMediaQuality(cwd)).preferences;
        if (operation === "setQuality") return saveMediaQuality(cwd, data, undefined, signal);
        const api = cloud(), tenant = currentTenant();
        if (!api || !tenant || tenant.role === "VIEWER") throw new Error("制片工具需要已登录且有编辑权限的工作区");
        const scope = api.scoped(tenant.workspaceId), projectId = workspaceProject(cwd)!;
        if (operation === "readVisionModels") return { models: listAiModels(), note: "已选语言模型；图片输入能力以实际供应商响应为准，检查失败不视为通过" };
        if (operation === "analyzeReference" || operation === "inspectAdPilot" || operation === "inspectAdFilm") {
          const models = listAiModels();
          if (!data.model && models.length > 1) throw new Error("当前有多个已选语言模型，请先 readVisionModels 并传 model 指定用于视觉检查的模型");
          const model = data.model ?? (models.length === 1 ? { providerId: models[0]!.providerId, modelId: models[0]!.modelId } : undefined);
          return api.inspectAd(scope, projectId, operation, { ...data, model }, tenant.userId, mediaSignal(signal));
        }
        if ((operation === "shot" || operation === "updateShot") && data.source !== undefined) {
          const source = z.strictObject({ sceneId: z.string().regex(/^s\d{2,3}$/) }).parse(data.source);
          const story = await readStoryProject(cwd);
          const revision = story.revisions.find(item => item.id === story.approvedId);
          const scene = revision?.scenes.find(item => item.sceneId === source.sceneId);
          if (!revision || !scene) throw new Error("来源场次必须属于当前已采用的剧本");
          data = { ...data, source: { sceneId: scene.sceneId, revisionId: revision.id, sceneText: scene.text, speech: scene.speech, knowledge: scene.knowledge } };
        }
        if (operation === "readStoryImpact") {
          const story = await readStoryProject(cwd);
          const revision = story.revisions.find(item => item.id === story.approvedId);
          const shots = scope.list("shots", { projectId });
          const voice = (await readVoiceProject(cwd)).project;
          const impacts = new Map(story.revisions.map(previous => [previous.id, revision ? storyImpact(previous, revision) : null]));
          return { revisionId: revision?.id, shots: shots.map(shot => {
            const scene = revision?.scenes.find(item => item.sceneId === shot.source?.sceneId);
            const sequence = scope.get("sequences", shot.sequenceId);
            const linked = Boolean(shot.source?.sceneId);
            const impact = impacts.get(shot.source?.revisionId);
            const dependent = Boolean(impact?.dependent.includes(shot.source?.sceneId));
            const stale = linked ? !scene || scene.text !== shot.source.sceneText || scene.speech !== shot.source.speech || scene.knowledge !== shot.source.knowledge || Boolean(impact?.changed.includes(shot.source.sceneId)) || dependent
              : shot.source?.scriptHash ? createHash("sha256").update(sequence?.script ?? "").digest("hex") !== shot.source.scriptHash : null;
            const edit = api.getEdit(scope, shot.sequenceId, false);
            return { shotId: shot.id, source: shot.source, stale, dependent,
              voiceLineIds: voice.lines.filter(line => line.shotId === shot.id || linked && line.storySource?.sceneId === shot.source.sceneId).map(line => line.id),
              takeIds: scope.list("takes", { shotId: shot.id }).map(take => take.id),
              clips: edit.clips.filter(clip => clip.shotId === shot.id || clip.refId?.startsWith(`${shot.id}:`) || clip.linkedClipId && edit.clips.some(parent => parent.id === clip.linkedClipId && parent.shotId === shot.id)).map(clip => ({ id: clip.id, start: clip.start, end: clip.start + clip.duration })),
            };
          }) };
        }
        if (operation === "sequence") {
          const story = await readStoryProject(cwd);
          const revision = story.revisions.find(item => item.id === story.approvedId);
          return api.workspaceProduction(scope, projectId, operation, { ...data, kind: data.kind ?? revision?.brief.kind ?? story.brief.kind, storyRevisionId: revision?.id }, tenant.userId);
        }
        if (operation === "importKeyframe") {
          const input = z.strictObject({ shotId: z.string().min(1), path: z.string().min(1).max(2048) }).parse(data);
          if (scope.get("shots", input.shotId)?.projectId !== projectId) throw new Error("镜头不属于当前项目");
          const image = await readReference(cwd, { path: input.path, mimeType: "image/png" }, "image", signal);
          signal?.throwIfAborted();
          return api.importWorkspaceKeyframe(scope, projectId, input.shotId, Buffer.from(image.data, "base64"), input.path);
        }
        if (operation === "inspectFinal") {
          if (typeof data.renderId !== "string" || scope.get("renders", data.renderId)?.projectId !== projectId) throw new Error("成片不属于当前项目");
          return api.inspectFinalQuality(scope, data.renderId);
        }
        if (operation === "inspectQuality") {
          const { targets } = z.object({ targets: z.array(z.object({ type: z.enum(["keyframe", "take"]), id: z.string().min(1) })).min(1).max(100) }).parse(data);
          const results = await Promise.allSettled(targets.map(async target => api.inspectProductionQuality(scope, projectId, target.type, target.id)));
          return { results: results.map((result, index) => result.status === "fulfilled" ? { ...targets[index], ...result.value } : { ...targets[index], error: String(result.reason) }), quality: api.productionQualityView(scope, projectId) };
        }
        if (operation === "suggestCuts" || operation === "previewCut" || operation === "soundBridge") {
          const { sequenceId } = z.object({ sequenceId: z.string().min(1) }).parse(data);
          if (scope.get("sequences", sequenceId)?.projectId !== projectId) throw new Error("序列不属于当前项目");
          if (operation === "soundBridge") return api.soundBridge(scope, sequenceId, api.soundBridgeSchema.parse(data), mediaSignal(signal));
          const input = api.cutPairSchema.parse(data);
          const result = await api[operation](scope, sequenceId, input.leftId, input.rightId, input.expectedVersion);
          mediaSignal(signal)?.throwIfAborted();
          return result;
        }
        if (operation === "readEdit" || operation === "render") {
          if (typeof data.sequenceId !== "string" || scope.get("sequences", data.sequenceId)?.projectId !== projectId) throw new Error("序列不属于当前项目");
          if (operation === "readEdit") return api.editView(scope, api.getEdit(scope, data.sequenceId, true));
          const options = api.renderOptionsSchema.parse(data.options ?? {});
          api.getEdit(scope, data.sequenceId, true);
          const fingerprint = api.sequenceFingerprint(scope, data.sequenceId);
          const existing = scope.list("renders", { sequenceId: data.sequenceId }, "created_at DESC").find(render => ["RUNNING", "SUCCEEDED"].includes(render.status) && render.manifest?.sourceFingerprint === fingerprint && JSON.stringify(render.manifest?.options) === JSON.stringify(options));
          return existing ?? api.startRender(tenant.workspaceId, projectId, data.sequenceId, tenant.userId, options);
        }
        if (operation === "compile") {
          if (data.kind !== "image" && data.kind !== "video" || typeof data.shotId !== "string") throw new Error("须提供 kind 和 shotId");
          const schema = data.kind === "image" ? imageGenerationSchema : videoGenerationSchema;
          const request = schema.parse(data.request);
          return prepareShot(cwd, data.kind, data.shotId, request);
        }
        return api.workspaceProduction(api.scoped(tenant.workspaceId), workspaceProject(cwd)!, operation, data, tenant.userId);
      },
      listModels: listMediaModels,
      generateImage: (request, signal, onProgress) => generateAndPublish("image", request, signal, onProgress),
      generateVideo: (request, signal, onProgress) => generateAndPublish("video", request, signal, onProgress),
      generateAudio: (request, signal, onProgress) => generateAndPublish("audio", request, signal, onProgress),
      async generateShots(kind, requests, signal, onProgress) {
        let completed = 0;
        return Promise.all(requests.map(async request => {
          try {
            mediaSignal(signal)?.throwIfAborted();
            const parsed = (kind === "image" ? imageGenerationSchema : videoGenerationSchema).parse(request);
            if (kind === "image") {
              const api = cloud(), tenant = currentTenant();
              if (api && tenant) {
                const scope = api.scoped(tenant.workspaceId);
                if (scope.get("shots", parsed.shotId!)?.projectId !== workspaceProject(cwd)) throw new Error("镜头不属于当前项目");
                const frames = scope.list("keyframes", { shotId: parsed.shotId });
                const jobs = scope.list("generation_jobs", { targetType: "shot", targetId: parsed.shotId, kind: "image" });
                if (frames.length || jobs.length) throw new Error(`此镜已有关键帧或生成请求，批量补图不会重复生成。请复用已有结果或查看原任务：${jobs.map(job => `${job.id} ${job.status}`).join("、")}`);
              }
            }
            const production = await prepareShot(cwd, kind, parsed.shotId!, parsed);
            const files = await generateAndPublish(kind, { ...production.request, productionFingerprint: production.fingerprint }, signal);
            return { shotId: parsed.shotId!, status: "success" as const, files };
          } catch (error) {
            return { shotId: request.shotId!, status: "blocked" as const, error: error instanceof Error ? error.message : String(error) };
          } finally { onProgress?.(`已返回 ${++completed}/${requests.length} 镜；已有任务复用，失败不自动重发`); }
        }));
      },
    },
    sdk: {
      defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition,
      detectSupportedImageMimeTypeFromFile: path => files.detectImageMimeType(path, true),
    },
  };
}

export async function createAgentTools(cwd: string, canvas?: CanvasContext, question?: QuestionContext, parentSignal?: AbortSignal): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  const names = new Set<string>();
  const context = createAgentToolContext(cwd, {}, canvas, question, parentSignal);
  for (const item of await listTools()) {
    if (!item.enabled) continue;
    if (item.loadError) throw new Error(`${item.displayName}：${item.loadError}`);
    const { plugin, metadata } = await loadTool(item.name);
    const config = validateToolConfig(plugin, item.config);
    const definitions = await plugin.createTools({ ...context, config });
    for (const tool of definitions) {
      if (!tool.name || typeof tool.execute !== "function") throw new Error(t`${item.displayName} 返回了无效的工具`);
      if (names.has(tool.name)) throw new Error(t`工具名称重复：${tool.name}`);
      names.add(tool.name);
      tools.push({
        ...tool,
        promptGuidelines: [
          ...(metadata.prompt ? [metadata.prompt] : []),
          ...(tool.promptGuidelines ?? []),
        ],
      });
    }
  }
  return tools.filter(tool => !["requestStoryApproval", "requestStoryDecision", "requestKeyframeApproval", "requestProductionDecision"].includes(tool.name) || names.has("askUser"));
}
