import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpathSync } from "@toonflow/file";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import type { GenRequest, GenResult } from "@/lib/cloud";
import { cloud } from "@/lib/cloud";
import { currentTenant, tenantStore } from "@/utils/tenant";
import { resolveWorkspaceDirectory } from "@/utils/workspace";
import { resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { assertPromptPolicy, compileShotSpec, generateMediaDirect, listMediaModels, readReference, validateCameraRequest, withPhotographicBaseline } from "@/utils/media/generation";
import { assertMediaModelSelection, assertModelSelection, routeImageEditModel } from "@/utils/modelSelection";
import { applyMediaQuality } from "@/utils/media/quality";
import { compactVideoPrompt } from "@toonflow/providers/media/meta";
import { coverageGate } from "@/utils/media/coverage";
import { blockingLine } from "@/utils/media/blocking";
import { modelAccess } from "@/utils/modelAvailability";
import { validateSpeechInputs } from "@/utils/media/lipSync";
import { assertCurrentSpeechAudio } from "@/utils/media/voiceDecision";
import { isDirectorPrompt } from "@/utils/media/videoPrompt";

export function workspaceProject(directory: string, create = true) {
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api) return undefined;
  directory = realpathSync(directory);
  // ACT: 单工作区按项目数 O(n) 兼容旧路径别名，并拒绝同一真实目录关联不同项目；规模增长时迁移为规范目录唯一索引。
  const links = api.dbAll("SELECT project_id,directory FROM workspace_project_links WHERE workspace_id=?", tenant.workspaceId).filter(row => {
    try { return realpathSync(row.directory) === directory; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
  }).filter(row => api.scoped(tenant.workspaceId).get("projects", row.project_id));
  if (new Set(links.map(row => row.project_id)).size > 1) throw Object.assign(new Error("同一工作目录关联了不同项目，请先修复项目关联，不能绕过原项目的制作校验"), { status: 409 });
  const link = links[0];
  if (link) return link.project_id as string;
  if (tenant.role === "VIEWER" || !create) return undefined;
  return api.linkWorkspaceProject(tenant.workspaceId, directory, basename(directory));
}

export async function enqueueMedia(directory: string, kind: "image" | "video", request: MediaGenerationRequest, requestId: string) {
  if (request.localRepair && (!request.shotId || kind !== "image")) throw Object.assign(new Error("精修须提供图像镜头 shotId"), { status: 400 });
  if (!request.shotId && !request.prompt.trim()) throw Object.assign(new Error("独立素材须提供生成提示词"), { status: 400 });
  await assertMediaModelSelection(kind, request, directory);
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api || tenant.role === "VIEWER") throw Object.assign(new Error("无权生成媒体"), { status: 403 });
  const linkedProjectId = workspaceProject(directory, false);
  if (!request.shotId && !request.purpose && linkedProjectId && api.scoped(tenant.workspaceId).list("shots", { projectId: linkedProjectId }).length) {
    throw Object.assign(new Error("当前项目已有正式镜头，请传 shotId 并先 compile 取得 productionFingerprint，以继承已采用的人物参考与共同质感。基础资产用 purpose=asset，明确独立的画面用 purpose=standalone。此次未提交生成。"), { status: 400 });
  }
  // 覆盖表判 block 的项目不放行视频生成：一镜塞三轮以上对白，成片里必然是「听见他的声音却一直看着另一个人」。
  if (kind === "video" && !request.shotId) {
    const blocked = await coverageGate(directory);
    if (blocked) throw Object.assign(new Error(`对白覆盖未通过：${blocked}`), { status: 400, retryable: false });
  }
  const production = request.shotId ? await prepareShot(directory, kind, request.shotId, request) : undefined;
  let speechSyncInputs: Awaited<ReturnType<typeof validateSpeechInputs>> | undefined;
  if (production && request.productionFingerprint !== production.fingerprint) throw Object.assign(new Error("提交参数或镜头规格与已预览版本不一致；请重新 compile 并完整复用返回的 request，保留画幅、精度和 productionFingerprint"), { status: 409 });
  // ACT: 正式镜头以当前规格和指纹为准，提示词由服务端编译，避免模型逐字复制长文本。
  if (production) request = production.request;
  else {
    // 独立素材先分流再取模型：尺寸、清晰度等参数要按真正执行的编辑模型计算。
    if (kind === "image") request = routeImageEditModel(request);
    const model = (await listMediaModels(true)).find(model => model.providerId === request.providerId && model.modelId === request.modelId && model.type === kind);
    if (!model) {
      // 余额不足会把整个供应商停用，模型随之从列表消失；这时报「类型不匹配」会让人去翻配置。
      const blocked = modelAccess("media", request.providerId, request.modelId).reason();
      if (blocked) throw Object.assign(new Error(`所选模型当前不可用：${blocked}。充值或修好后调 POST /api/providers/reenable 重新启用`), { status: 400, retryable: false });
      throw Object.assign(new Error("所选媒体模型不存在或类型不匹配"), { status: 400 });
    }
    request = await applyMediaQuality(directory, kind, request, model);
    if (kind === "video" && model.lipSync) speechSyncInputs = await validateSpeechInputs(directory, request);
    // 入队前编译镜头规格并补写实基底：让任务记录里的 compiled_prompt 与实际发送内容一致。
    const spec = isDirectorPrompt(request.prompt) ? "" : compileShotSpec(request.shotSpec);
    request = { ...request, prompt: withPhotographicBaseline(spec ? `${spec}\n\n${request.prompt}` : request.prompt) };
  }
  const projectId = workspaceProject(directory)!;
  // 正式镜头的 request 由 compile 产物覆盖，参考图分流要在这之后执行，保证落库模型与实际调用一致。
  // 镜头参考在 compile 的 inputs 里（执行时才落成 images），独立素材直接看 request.images。
  if (kind === "image") request = routeImageEditModel(request, !!request.images?.length || !!production?.compiled.inputs?.some(input => input.sent && input.mediaId));
  // 负面词与种子走独立字段，不拼进提示词正文：拼接后模型只会当作要绘制的文字内容。
  const compiled = production?.compiled;
  const merged = {
    ...request,
    ...(production ? { prompt: compiled!.prompt } : {}),
    ...(compiled?.negativePrompt ? { negativePrompt: compiled!.negativePrompt } : {}),
  };
  const seed = request.seed ?? compiled?.seed;
  let assetReferenceFingerprint: string | undefined;
  if (!production && request.purpose === "asset") {
    const hash = createHash("sha256");
    let count = 0;
    for (const [references, type] of [[request.images ?? [], "image"], [request.videos ?? [], "video"], [request.audios ?? [], "audio"], [[request.firstFrame, request.lastFrame].filter((item): item is NonNullable<typeof item> => !!item), "image"]] as const) {
      for (const reference of references) {
        const content = await readReference(directory, reference, type);
        hash.update(JSON.stringify([type, content.mimeType, content.data]));
        count++;
      }
    }
    if (count) assetReferenceFingerprint = hash.digest("hex");
  }
  // 走位补位也放在入队前：作者没写空间关系时按镜头号取走位板，这样 compiled_prompt 与实发一致。
  // 正式镜头已在 compile 时冻结；独立素材在入队时冻结，执行时不再读取走位板。
  if (!production && !merged.prompt.includes("BLOCKING:")) {
    const blocking = await blockingLine(directory, merged.outputName);
    if (blocking) merged.prompt = `${blocking}\n\n${merged.prompt}`;
  }
  assertPromptPolicy(merged as Parameters<typeof assertPromptPolicy>[0], kind, compiled?.inputs);
  return api.enqueueWorkspaceMedia({
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    projectId,
    directory,
    kind,
    request: { ...merged, ...(speechSyncInputs ? { speechSyncInputs } : {}) },
    seed,
    requestId,
    assetReferenceFingerprint,
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
      if (workspaceProject(directory, false) !== context.projectId) throw new Error("工作目录与项目不匹配");
      const request = { ...input.params.request as MediaGenerationRequest };
      if (request.providerId !== providerId || request.modelId !== modelId) throw new Error("生成模型不匹配");
      if (input.kind === "video" && input.params.fingerprint && request.shotId) {
        try {
          const shot = api.scoped(context.workspaceId).get("shots", request.shotId);
          if (!shot || shot.projectId !== context.projectId) throw new Error("生成镜头已失效");
          if (shot.creativeBrief?.dialogue?.lines?.length && input.params.specFingerprint !== api.shotFingerprint(api.scoped(context.workspaceId), shot.id)) throw new Error("排队后镜头或对白规划已改变，停止旧请求，不自动重新提交");
          api.assertSpeechPlan(api.scoped(context.workspaceId), shot);
          await assertCurrentSpeechAudio(directory, shot, input.signal);
        } catch (cause) { throw Object.assign(cause as Error, { retryable: false, fallbackAllowed: false }); }
      }
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
      const files = await generateMediaDirect(directory, input.kind as "image" | "video", {
        ...request,
        // 任务记录中的负面词与种子优先；镜头编译产出的负面词不能因路径不同而丢失。
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        ...(input.params.seed !== undefined ? { seed: Number(input.params.seed) } : {}),
      }, input.signal, async task => {
        // ACT: 工作区适配器仍是单次执行；远端号作为恢复证据保存，不触发不支持的自动 poll 或重提。
        const previous = api.scoped(context.workspaceId).get("generation_jobs", context.jobId)?.parameters?.remoteTask;
        api.dbRun("UPDATE generation_jobs SET parameters=json_set(parameters,'$.remoteTask',json(?)) WHERE id=? AND workspace_id=?", JSON.stringify({ ...previous, ...task, id: task.id ?? previous?.id, providerId, modelId, updatedAt: new Date().toISOString() }), context.jobId, context.workspaceId);
      });
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

export async function prepareShot(directory: string, kind: "image" | "video", shotId: string, request: MediaGenerationRequest, previewOnly = false) {
  if (kind === "video") {
    const blocked = await coverageGate(directory);
    if (blocked) throw Object.assign(new Error(`对白覆盖未通过：${blocked}`), { status: 400, retryable: false });
  }
  assertModelSelection(kind, request.providerId, request.modelId);
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api || tenant.role === "VIEWER") throw Object.assign(new Error("无权制作镜头"), { status: 403 });
  const model = (await listMediaModels()).find(item => item.providerId === request.providerId && item.modelId === request.modelId && item.type === kind);
  if (!model) throw Object.assign(new Error("模型不存在"), { status: 400 });
  if (request.localRepair) {
    const scope = api.scoped(tenant.workspaceId);
    const frame = scope.get("keyframes", request.localRepair.keyframeId);
    const media = frame?.mediaId && scope.get("media", frame.mediaId);
    if (kind !== "image" || frame?.shotId !== shotId || !media?.width || !media?.height) throw new Error("精修需要当前镜头原图及实际宽高");
    const ratios = request.ratio ? [request.ratio] : model.imageRatios?.length ? model.imageRatios : [`${media.width}:${media.height}`];
    const ratio = ratios.find(value => {
      const [width, height] = value.split(":").map(Number);
      return width > 0 && height > 0 && Math.abs(media.width - media.height * width / height) <= 1;
    });
    if (!ratio) throw new Error("精修须保持原图画幅；当前画幅或模型不支持，不能通过裁剪、拉伸改变原构图");
    request = { ...request, ratio };
  }
  request = await applyMediaQuality(directory, kind, request, model);
  validateCameraRequest(model, request, kind);
  if (kind === "video") {
    // 模式可能是字符串或一组参考上限；按完整候选比较，不能接受客户端自报能力。
    const modes = Array.isArray(model.mode) ? model.mode : [model.mode];
    if (!modes.some(mode => JSON.stringify(mode) === JSON.stringify(request.mode))) throw Object.assign(new Error("所选模式不受模型支持"), { status: 400 });
    if (model.durationResolutionMap?.length && !model.durationResolutionMap.some(rule => rule.duration.includes(request.duration!) && rule.resolution.includes(request.resolution!))) throw Object.assign(new Error("时长与分辨率组合不受模型支持"), { status: 400 });
  }
  const result = api.prepareWorkspaceShot({ workspaceId: tenant.workspaceId, projectId: workspaceProject(directory)!, shotId, kind,
    providerId: request.providerId, modelId: request.modelId, mode: kind === "image" ? model.mode : request.mode, cameraTrajectory: model.cameraTrajectory === true, localRepair: request.localRepair, ...(previewOnly ? { previewOnly: true } : {}) });
  if (kind === "video") {
    try { await assertCurrentSpeechAudio(directory, api.scoped(tenant.workspaceId).get("shots", shotId)!); }
    catch (cause) {
      if (!previewOnly) throw cause;
      result.compiled.warnings.push(`配音规划未完成：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (kind === "video" && request.providerId === "meta" && request.modelId === "MiniMax-H3") {
    result.compiled.prompt = compactVideoPrompt(result.compiled.prompt);
  }
  if (kind === "video" && result.audioMode === "generated" && (!model.audio || request.generateAudio === false || (model.audio === "optional" && request.generateAudio !== true))) {
    throw Object.assign(new Error("本镜对白或声音方案需要生成声音，请选用支持音频的模型并开启 generateAudio；不能删除台词或改成静音绕过"), { status: 400 });
  }
  if (kind === "video" && result.audioMode === "silent" && (model.audio === true || request.generateAudio === true || (model.audio === "optional" && request.generateAudio !== false))) {
    throw Object.assign(new Error("MV 方案要求无声素材，请关闭 generateAudio 或更换支持无声输出的模型"), { status: 400 });
  }
  if (model.promptControl === "imageAndCameraOnly") result.compiled.warnings.push("此模型仅执行首帧与数值相机轨迹：编译文本用于审阅与记录，不会送入逐请求文本控制。表演、声音与文字约束须通过生成后的实际观看验收。");
  if (kind === "video" && request.duration !== result.duration) throw Object.assign(new Error("生成时长须与镜头的生成时长规格一致，请先保存"), { status: 400 });
  if (!result.compiled.prompt.includes("BLOCKING:")) {
    const blocking = await blockingLine(directory, request.outputName);
    if (blocking) result.compiled.prompt = `${blocking}\n\n${result.compiled.prompt}`;
  }
  assertPromptPolicy({ ...request, prompt: result.compiled.prompt }, kind, result.compiled.inputs);
  result.fingerprint = createHash("sha256").update(JSON.stringify([result.fingerprint, result.compiled.prompt, request.ratio, request.size, request.resolution, request.duration, request.generateAudio, request.cameraTrajectory, request.imageAndCameraOnly])).digest("hex");
  return { ...result, request: { ...request, shotId, productionFingerprint: result.fingerprint, prompt: result.compiled.prompt, negativePrompt: result.compiled.negativePrompt || request.negativePrompt, seed: request.seed ?? result.compiled.seed } };
}
