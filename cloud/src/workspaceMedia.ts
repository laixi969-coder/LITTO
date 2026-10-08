import { createHash } from "node:crypto";
import { get, run, scoped, tx } from "./db.ts";
import { createProject } from "./routes/platform.ts";
import { enqueue } from "./jobs.ts";
import { ADAPTERS, upsertModel, upsertProvider } from "./providers/registry.ts";
import { ProviderError, type GenRequest, type GenResult } from "./providers/adapter.ts";
import { compileShot, requireCompiledInputs } from "./domain/compiler.ts";
import { requireReviewed, shotFingerprint } from "./domain/realism.ts";
import { bad, conflict, notFound } from "./util.ts";

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
    name: "LITTO 工作区模型",
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
  request: { providerId: string; modelId: string; prompt: string; [key: string]: unknown };
  requestId: string;
  production?: ReturnType<typeof prepareWorkspaceShot>;
}) {
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
  return enqueue({
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    targetType: input.production ? "shot" : undefined,
    targetId: input.production?.shotId,
    modelId,
    compiledPrompt: input.request.prompt,
    parameters: { directory: input.directory, request: input.request, ...(input.production ? { keyframeId: input.production.keyframeId, fingerprint: input.production.fingerprint } : {}) },
    inputRefs: input.production?.compiled.inputs ?? [],
    fallbackAllowed: false,
    idempotencyKey: "workspaceMedia:" + input.requestId,
  });
}

export function prepareWorkspaceShot(input: {
  workspaceId: string; projectId: string; shotId: string; kind: "image" | "video";
  providerId: string; modelId: string; mode?: unknown; cameraTrajectory?: boolean;
}) {
  const s = scoped(input.workspaceId);
  const shot = s.get("shots", input.shotId);
  if (!shot || shot.projectId !== input.projectId) throw notFound("shot");
  if (shot.generationDuration != null && shot.generationDuration < shot.duration) throw bad("生成时长不能短于计划使用时长");
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
    motionReference: videoLimit > 0, cameraControl: input.cameraTrajectory === true, nativeAudio: audioLimit > 0,
    maxInputs: input.kind === "image" ? imageLimit : firstFrame ? (mode === "startEndRequired" || mode === "endFrameOptional" ? 2 : 1) : referenceLimit + videoLimit + audioLimit };
  const modelId = "workspace" + createHash("sha256").update(JSON.stringify([input.workspaceId, input.kind, input.providerId, input.modelId])).digest("hex");
  upsertModel(modelId, { providerId: "workspaceMedia", externalModelId: JSON.stringify([input.providerId, input.modelId]), name: input.modelId,
    type: input.kind, limits: { workspaceId: input.workspaceId, workspaceExecution: true }, price: {}, capabilities });
  let keyframe: any;
  if (input.kind === "video") {
    keyframe = shot.heroKeyframeId ? s.get("keyframes", shot.heroKeyframeId) : null;
    if (!keyframe || keyframe.shotId !== shot.id || keyframe.status !== "hero") throw conflict("先检查并选定主关键帧，再生成视频", "no_hero_frame");
    requireReviewed(s, "keyframe", keyframe);
    if (!capabilities.image2video) throw bad("当前模式不能接收主关键帧，请选择图生视频模式");
  }
  const compiled = compileShot(s, shot.id, input.kind, modelId, { startFrameMediaId: keyframe?.mediaId });
  // ACT: 主帧必占一个输入槽；不得为了多参考丢掉已批准主帧。
  if (compiled.inputs.filter(ref => ref.sent).length > capabilities.maxInputs) throw bad("参考数量超出当前模式容量，请减少参考或更换模式");
  if (mode === "startEndRequired" && !compiled.inputs.some(ref => ref.role === "END_FRAME" && ref.sent)) throw bad("此模式须绑定尾帧");
  requireCompiledInputs(compiled);
  const counts = { image: 0, video: 0, audio: 0 };
  for (const ref of compiled.inputs.filter(ref => ref.sent)) {
    const media = ref.mediaId && s.get("media", ref.mediaId);
    const kind = ref.role === "AUDIO" ? "audio" : ["PERFORMANCE", "CAMERA_MOTION"].includes(ref.role) ? "video" : "image";
    if (!media || media.projectId !== input.projectId || !media.mime.startsWith(`${kind}/`)) throw bad(`参考须是当前项目的有效 ${kind} 媒体`);
    counts[kind]++;
  }
  if (input.kind === "video" && Array.isArray(mode) && (counts.image > referenceLimit || counts.video > videoLimit || counts.audio > audioLimit)) throw bad("某类参考数量超过模型的模式上限");
  compiled.warnings.push("参考按媒体类型发送；用途与权重写入提示词，不代表供应商提供像素级锁定或数值权重控制。自动检查不替代观看验收。");
  const inputNumbers = { image: 0, video: 0, audio: 0 };
  compiled.prompt += "\nREFERENCE PLAN: " + compiled.inputs.filter(ref => ref.sent).map(ref => {
    const media = s.get("media", ref.mediaId!);
    const kind = media!.mime.startsWith("video/") ? "video" : media!.mime.startsWith("audio/") ? "audio" : "image";
    const slot = kind === "image" && ref.role === "END_FRAME" ? "native end frame"
      : kind === "image" && ref.role === "START_FRAME" && input.kind === "video" && firstFrame ? "native start frame"
      : `${kind} ${++inputNumbers[kind]}`;
    const intent = ref.role === "START_FRAME" && !slot.startsWith("native") ? "approved appearance/composition reference; not a native start-frame constraint" : ref.role;
    return `${slot}: ${intent}, ${ref.lockLevel}, intended weight ${ref.weight}, reference ${ref.referenceId}`;
  }).join("; ");
  return { shotId: shot.id, keyframeId: keyframe?.id, fingerprint: createHash("sha256").update(JSON.stringify([shotFingerprint(s, shot.id), input, keyframe?.id, compiled])).digest("hex"), compiled, capabilities, duration: shot.generationDuration ?? shot.duration };
}
