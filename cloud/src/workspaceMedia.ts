import { resolveDialogueMode } from "@toonflow/tool-media-generation/runtime";
import { createHash } from "node:crypto";
import { get, run, scoped, tx } from "./db.ts";
import { createProject } from "./routes/platform.ts";
import { enqueue, jobView } from "./jobs.ts";
import { ADAPTERS, upsertModel, upsertProvider } from "./providers/registry.ts";
import { ProviderError, type GenRequest, type GenResult } from "./providers/adapter.ts";
import { compileShot, compileWorkspacePrompt, requireCompiledInputs, renderCompiledPrompt } from "./domain/compiler.ts";
import { requireReviewed, shotFingerprint } from "./domain/realism.ts";
import { bad, conflict, notFound, now, HttpError } from "./util.ts";
import { compactVideoPrompt } from "@toonflow/providers/media/meta";
import { localRepairSchema, prepareLocalRepair } from "./domain/localRepair.ts";
import { assertSpeechPlan } from "./domain/speechPlanning.ts";

/** Host-only execution bridge. Tenant identity comes from the stored job, never its parameters. */
export function configureWorkspaceMedia(execute: (request: GenRequest) => Promise<GenResult>) {
  ADAPTERS.workspaceMedia = {
    requiresKey: false,
    async submit(request) {
      return { done: await execute(request) };
    },
    async poll() {
      throw new ProviderError("工作区生成不支持远程轮询", false);
    },
    async testConnection() {
      return { ok: true, message: "工作区执行器已连接", latencyMs: 0 };
    },
  };
  upsertProvider("workspaceMedia", {
    name: "MILI MILI 工作区模型",
    adapter: "workspaceMedia",
    priority: 1000,
    timeoutMs: 3600000,
    retryPolicy: { maxAttempts: 1 },
    concurrency: 4,
  });
}

export function linkWorkspaceProject(workspaceId: string, directory: string, name: string) {
  return tx(() => {
    const link = get("SELECT project_id FROM workspace_project_links WHERE workspace_id=? AND directory=?", workspaceId, directory);
    if (link && scoped(workspaceId).get("projects", link.project_id)) return link.project_id as string;
    const project = createProject(scoped(workspaceId), name);
    run(
      "INSERT INTO workspace_project_links VALUES(?,?,?) ON CONFLICT(workspace_id,directory) DO UPDATE SET project_id=excluded.project_id",
      workspaceId,
      directory,
      project.id,
    );
    return project.id as string;
  });
}

export function enqueueWorkspaceMedia(input: {
    workspaceId: string;
    userId: string;
    projectId: string;
    directory: string;
    kind: "image" | "video";
    request: { providerId: string; modelId: string; prompt: string; negativePrompt?: string; seed?: number; [key: string]: unknown };
    /** 固定随机种子：同一镜头可复现同机位变体，便于只改单要素做对照。 */
    seed?: number;
    /** 抽卡候选批次：任务完成后本批产物自动入池，供评分与采用。 */
    candidateBatchId?: string;
    negativePrompt?: string;
    requestId: string;
    assetReferenceFingerprint?: string;
    production?: ReturnType<typeof prepareWorkspaceShot>;
}) {
  if (input.production?.previewOnly) throw bad("提示词预览不能直接提交生成，请重新执行生成前检查");
  if (input.kind === "video" && input.production) {
    const shot = scoped(input.workspaceId).get("shots", input.production.shotId);
    if (!shot || shot.projectId !== input.projectId) throw notFound("project shot");
    assertSpeechPlan(scoped(input.workspaceId), shot);
  }
  const idempotencyKey = "workspaceMedia:" + input.requestId;
  const receipt = get("SELECT response FROM idempotency_keys WHERE workspace_id=? AND key=?", input.workspaceId, idempotencyKey);
  if (receipt) {
    const saved = JSON.parse(receipt.response);
    if (saved.cancelled) throw conflict("生成请求已取消，不会重新提交", "cancelled");
    const previous = scoped(input.workspaceId).get("generation_jobs", saved.id);
    if (!previous || previous.projectId !== input.projectId || previous.parameters?.directory !== input.directory || previous.kind !== input.kind) throw conflict("请求 ID 与原生成任务不一致", "request_conflict");
    return { ...jobView(previous), reused: true };
  }
  const modelId =
    "workspace" +
    createHash("sha256")
      .update(JSON.stringify([input.workspaceId, input.kind, input.request.providerId, input.request.modelId]))
      .digest("hex");
  upsertModel(modelId, {
    providerId: "workspaceMedia",
    externalModelId: JSON.stringify([input.request.providerId, input.request.modelId]),
    name: input.request.modelId,
    type: input.kind,
    limits: { workspaceId: input.workspaceId, workspaceExecution: true },
    price: {},
    capabilities: input.production?.capabilities ?? {},
  });
  const prompt = input.production ? input.request.prompt : compileWorkspacePrompt(scoped(input.workspaceId), input.projectId, input.request.prompt, input.request.purpose);
  if (input.production || input.request.purpose === "asset") {
    const scope = scoped(input.workspaceId);
    const negativePrompt = input.negativePrompt ?? input.request.negativePrompt;
    const references = (request: Record<string, unknown>) => [request.images, request.videos, request.audios, request.firstFrame, request.lastFrame];
    const signature = generationSignature({ ...input.request, seed: input.seed ?? input.request.seed }, prompt, negativePrompt, input.production?.compiled.inputs ?? references(input.request), input.candidateBatchId);
    // ACT: 单进程同步查找与入队之间没有 await；按项目/镜头扫描历史以兼容已有任务，规模增长后改为索引列。
    const matches = scope.list("generation_jobs", { projectId: input.projectId, ...(input.production ? { targetType: "shot", targetId: input.production.shotId } : {}), kind: input.kind }, "created_at DESC")
      .filter(job => job.providerId === "workspaceMedia" && job.parameters?.directory === input.directory && job.parameters?.fingerprint === input.production?.fingerprint
        && (input.production || job.parameters?.assetReferenceFingerprint === input.assetReferenceFingerprint)
        && (input.production || job.parameters?.request?.purpose === "asset")
        && generationSignature(job.parameters.request ?? {}, job.compiledPrompt, job.parameters.negativePrompt, input.production ? job.inputRefs : references(job.parameters.request ?? {}), job.parameters.candidateBatchId) === signature);
    const previous = matches.find(job => job.status === "SUCCEEDED") ?? matches.find(job => ["QUEUED", "RUNNING"].includes(job.status)) ?? matches[0];
    if (previous) {
      const reused = { ...jobView(previous), reused: true };
      run("INSERT INTO idempotency_keys VALUES(?,?,?,?)", idempotencyKey, input.workspaceId, JSON.stringify(reused), now());
      return reused;
    }
  }
  return enqueue({
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    targetType: input.production ? "shot" : undefined,
    targetId: input.production?.shotId,
    modelId,
    compiledPrompt: prompt,
    negativePrompt: input.negativePrompt ?? input.request.negativePrompt,
    parameters: { directory: input.directory, assetReferenceFingerprint: input.assetReferenceFingerprint, request: { ...input.request, prompt, seed: input.seed ?? input.request.seed }, ...(input.production ? { keyframeId: input.production.keyframeId, fingerprint: input.production.fingerprint, specFingerprint: input.production.specFingerprint, ...input.production.repairParameters } : {}), ...(input.candidateBatchId ? { candidateBatchId: input.candidateBatchId } : {}) },
    seed: input.seed ?? input.request.seed,
    inputRefs: input.production?.compiled.inputs ?? [],
    fallbackAllowed: false,
    idempotencyKey,
  });
}

function generationSignature(request: Record<string, unknown>, prompt: string, negativePrompt: unknown, inputs: unknown, candidateBatchId: unknown) {
  // ACT: 旧记录保存了压缩前说明；按真正发送的提示词比较，升级预览后仍复用已付费结果。
  if (request.providerId === "meta" && request.modelId === "MiniMax-H3") prompt = compactVideoPrompt(prompt);
  const { prompt: ignoredPrompt, productionFingerprint, outputDirectory, outputName, shotId, images, videos, audios, firstFrame, lastFrame, negativePrompt: ignoredNegative, ...parameters } = request;
  return JSON.stringify([parameters, prompt, negativePrompt || null, inputs, candidateBatchId ?? null], (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}

export function prepareWorkspaceShot(input: {
  workspaceId: string; projectId: string; shotId: string; kind: "image" | "video";
  providerId: string; modelId: string; mode?: unknown; cameraTrajectory?: boolean; nativeDialogue?: boolean; audio?: boolean | "optional"; localRepair?: unknown; previewOnly?: boolean;
}) {
  const { previewOnly = false, ...generationInput } = input;
  const previewWarnings: string[] = [];
  const s = scoped(input.workspaceId);
  const shot = s.get("shots", input.shotId);
  if (!shot || shot.projectId !== input.projectId) throw notFound("shot");
  if (input.kind === "video" && !previewOnly) assertSpeechPlan(s, shot);
  const mode = input.mode;
  const imageModes = Array.isArray(mode) ? mode : [mode];
  const imageLimit = imageModes.includes("multiReference") ? 64 : imageModes.includes("singleImage") ? 1 : 0;
  const referenceLimit = Array.isArray(mode) ? Number(mode.find(v => String(v).startsWith("imageReference:"))?.split(":")[1] ?? 0) : 0;
  const videoLimit = Array.isArray(mode) ? Number(mode.find(v => String(v).startsWith("videoReference:"))?.split(":")[1] ?? 0) : 0;
  const audioLimit = Array.isArray(mode) ? Number(mode.find(v => String(v).startsWith("audioReference:"))?.split(":")[1] ?? 0) : 0;
  const firstFrame = ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(mode));
  const images = input.kind === "image" ? imageLimit > 0 : referenceLimit > 0;
  const capabilities = { image2video: firstFrame || referenceLimit > 0, startEndFrame: ["startEndRequired", "endFrameOptional"].includes(String(mode)),
    multiReference: images, identityReference: images, compositionReference: images,
    motionReference: videoLimit > 0, cameraControl: input.cameraTrajectory === true, audioReference: audioLimit > 0,
    nativeAudio: !!input.audio, nativeDialogue: input.nativeDialogue === true && !!input.audio,
    maxInputs: input.kind === "image" ? imageLimit : firstFrame ? (mode === "startEndRequired" || mode === "endFrameOptional" ? 2 : 1) : referenceLimit + videoLimit + audioLimit };
  const modelId = "workspace" + createHash("sha256").update(JSON.stringify([input.workspaceId, input.kind, input.providerId, input.modelId])).digest("hex");
  upsertModel(modelId, { providerId: "workspaceMedia", externalModelId: JSON.stringify([input.providerId, input.modelId]), name: input.modelId,
    type: input.kind, limits: { workspaceId: input.workspaceId, workspaceExecution: true }, price: {}, capabilities });
  let keyframe: any;
  if (input.kind === "video") {
    keyframe = shot.heroKeyframeId ? s.get("keyframes", shot.heroKeyframeId) : null;
    if (!keyframe || keyframe.shotId !== shot.id || keyframe.status !== "hero") throw conflict("请先调用 requestKeyframeApproval，在聊天中展示并采用本镜头的关键帧（可合并多个镜头一次确认），再重新 compile。不要让用户去制作面板点击，不用 START_FRAME 绑定或 updateShot 代替采用", "no_hero_frame");
    try { requireReviewed(s, "keyframe", keyframe); }
    catch (cause) {
      if (!previewOnly || !(cause instanceof HttpError) || !["review_required", "qc_blocked"].includes(cause.code)) throw cause;
      previewWarnings.push(`仅预览：主关键帧检查待完成，提交生成仍会阻止；${cause.message}`);
    }
    if (!capabilities.image2video) throw bad("当前模式不能接收主关键帧，请选择图生视频模式");
  }
  const repair = input.localRepair === undefined ? undefined : prepareLocalRepair(s, localRepairSchema.parse(input.localRepair));
  if (repair && (input.kind !== "image" || repair.shot.id !== shot.id)) throw bad("精修原图须属于当前图像镜头");
  // ACT: 工作区适配器以图片输入模式声明参考图编辑能力，未声明蒙版能力，不承诺区域外像素不变。
  if (repair && imageLimit < 1) throw bad("当前图像模型不能接收原图，请选择支持图片输入的编辑模型");
  const compiled = repair?.compiled ?? compileShot(s, shot.id, input.kind, modelId, { startFrameMediaId: keyframe?.mediaId, startFrameAsReference: input.kind === "video" && !firstFrame });
  // ACT: 主帧必占一个输入槽；不得为了多参考丢掉已批准主帧。
  if (compiled.inputs.filter(ref => ref.sent).length > capabilities.maxInputs) throw bad("参考数量超出当前模式容量，请减少参考或更换模式");
  if (mode === "startEndRequired" && !compiled.inputs.some(ref => ref.role === "END_FRAME" && ref.sent)) throw bad("此模式须绑定尾帧");
  requireCompiledInputs(compiled);
  const counts = { image: 0, video: 0, audio: 0 };
  const importedAssets = s.list("assets", { projectId: input.projectId }).filter(asset => asset.attributes?.importedFrom);
  for (const ref of compiled.inputs.filter(ref => ref.sent)) {
    const media = ref.mediaId && s.get("media", ref.mediaId);
    const kind = ref.role === "AUDIO" ? "audio" : ["PERFORMANCE", "CAMERA_MOTION"].includes(ref.role) ? "video" : "image";
    const asset = ref.referenceId.startsWith("asset:") ? s.get("assets", ref.referenceId.slice(6))
      : importedAssets.find(asset => asset.references?.includes(ref.referenceId));
    const library = asset?.attributes?.importedFrom && s.get("library_assets", asset.attributes.importedFrom);
    const libraryReference = asset?.projectId === input.projectId && library && (library.authoritativeReference === ref.mediaId
      || library.referenceSnapshots?.some((reference: { mediaId?: string }) => reference.mediaId === ref.mediaId)
      || library.references?.some((id: string) => s.get("refs", id)?.mediaId === ref.mediaId));
    if (!media || (media.projectId !== input.projectId && !libraryReference) || !media.mime.startsWith(`${kind}/`)) throw bad(`参考须是当前项目或已导入角色库的有效 ${kind} 媒体`);
    counts[kind]++;
  }
  if (input.kind === "video" && Array.isArray(mode) && (counts.image > referenceLimit || counts.video > videoLimit || counts.audio > audioLimit)) throw bad("某类参考数量超过模型的模式上限");
  compiled.warnings.push("参考按媒体类型发送；用途与权重写入提示词，不代表供应商提供像素级锁定或数值权重控制。自动检查不替代观看验收。");
  const inputNumbers = { image: 0, video: 0, audio: 0 };
  const referencePlan = compiled.inputs.filter(ref => ref.sent).map(ref => {
    const media = s.get("media", ref.mediaId!);
    const kind = media!.mime.startsWith("video/") ? "video" : media!.mime.startsWith("audio/") ? "audio" : "image";
    const slot = kind === "image" && ref.role === "END_FRAME" ? "native end frame"
      : kind === "image" && ref.role === "START_FRAME" && input.kind === "video" && firstFrame ? "native start frame"
      : `${kind} ${++inputNumbers[kind]}`;
    const intent = ref.role === "START_FRAME" && !slot.startsWith("native") ? "approved appearance/composition reference; not a native start-frame constraint" : ref.role;
    return `${slot}: ${intent}, ${ref.lockLevel}, intended weight ${ref.weight}, reference ${ref.referenceId}`;
  }).join("; ");
  compiled.sections["Objective" in compiled.sections ? "Reference binding" : "reference plan"] = referencePlan;
  compiled.prompt = renderCompiledPrompt(compiled.sections);
  const nativeDialogue = resolveDialogueMode(shot) === "native";
  const repairParameters = repair ? { localRepairOf: repair.keyframe.id, localRepairKind: repair.kind, localRepairTarget: repair.target } : undefined;
  const fingerprint = createHash("sha256").update(JSON.stringify([shotFingerprint(s, shot.id), generationInput, keyframe?.id, compiled])).digest("hex");
  compiled.warnings.push(...previewWarnings);
  return { shotId: shot.id, keyframeId: keyframe?.id, repairParameters, fingerprint, specFingerprint: shotFingerprint(s, shot.id), previewOnly, compiled, capabilities, duration: shot.generationDuration ?? shot.duration, audioMode: nativeDialogue ? "generated" : shot.musicVideo?.audioMode as string | undefined };
}
