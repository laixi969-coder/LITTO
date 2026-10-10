import { recordUsage } from "@/utils/usage";
import { guardedFetch } from "@/utils/ssrf";
import { t, translateMessage } from "@/lib/i18n";
import { mkdir, readFile, realpath, stat, unlink } from "@toonflow/file";
import { join, relative } from "node:path";
import { mediaProviders, type Provider } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import { cameraTrajectorySchema } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { modelAccess } from "@/utils/modelAvailability";
import { assertModelSelection, isSelectedModel } from "@/utils/modelSelection";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

const maxMediaSize = 100 * 1024 * 1024;
const cameraSessions = new Set<string>();

async function runCameraSession<T>(provider: Provider & { config: Record<string, unknown> }, action: () => Promise<T>) {
  if (provider.id !== "gen3c") return action();
  // ACT: 官方服务只有一个可变 3D 缓存。单进程按源站排他；异常时保留占用，
  // 防止取消 HTTP 后仍在运行的 GPU 任务被下一次 seed 清空。恢复须重启两端。
  const endpoint = new URL(String(provider.config.baseUrl)).origin;
  if (cameraSessions.has(endpoint)) throw new Error("GEN3C 服务正在使用或上次结果不确定；不要重试 seed，异常恢复须重启 GEN3C 与 LITTO");
  cameraSessions.add(endpoint);
  const result = await action();
  cameraSessions.delete(endpoint);
  return result;
}
const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

export function validateCameraRequest(model: { cameraTrajectory?: unknown; promptControl?: unknown }, request: MediaGenerationRequest, mediaType: string) {
  if (request.cameraTrajectory) {
    if (mediaType !== "video" || model.cameraTrajectory !== true) invalid("所选模型不支持原生数值相机轨迹");
    request.cameraTrajectory = cameraTrajectorySchema.parse(request.cameraTrajectory);
    if (request.duration === undefined || Math.abs(request.duration - request.cameraTrajectory.frames.length / request.cameraTrajectory.fps) > 0.000001) invalid("生成时长须等于轨迹帧数除以帧率");
  }
  if (model.cameraTrajectory === true && !request.cameraTrajectory) invalid("此模型需要数值相机轨迹");
  if (model.promptControl === "imageAndCameraOnly" && request.imageAndCameraOnly !== true) invalid("此模型仅接受图像与相机轨迹，请明确设置 imageAndCameraOnly，不会执行文字表演指令");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(all = false): Promise<MediaModel[]> {
  const installedProviders = await listMediaProviders();
  return installedProviders.flatMap(provider => provider.models.flatMap(model => {
    if (provider.loadError || modelAccess("media", provider.id, model.id).reason()) return [];
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    if (!all && !isSelectedModel(model.type, provider.id, model.id)) return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      cameraTrajectory: model.cameraTrajectory === true, promptControl: model.promptControl === "imageAndCameraOnly" ? "imageAndCameraOnly" : undefined,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio, lipSync: model.lipSync === true, speechInstructions: model.speechInstructions === true,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

function detectMimeType(bytes: Uint8Array, fallback: string) {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const text = header.toString("ascii");
  const mimeType = fallback.split(";")[0].trim().toLowerCase();
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("fLaC")) return "audio/flac";
  if (text.startsWith("OggS")) return mimeType.startsWith("video/") ? "video/ogg" : mimeType === "audio/opus" ? "audio/opus" : "audio/ogg";
  if (header[0] === 0xff && (header[1]! & 0xf6) === 0xf0) return "audio/aac";
  if (text.startsWith("ID3") || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0 && (header[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (text.slice(4, 8) === "ftyp") {
    if (/avif|avis/.test(text.slice(8))) return "image/avif";
    if (/^M4[AB] $/.test(text.slice(8, 12)) || mimeType.startsWith("audio/")) return "audio/mp4";
    return text.slice(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return mimeType.startsWith("audio/") ? "audio/webm" : "video/webm";
  return ({ "image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-flac": "audio/flac" } as Record<string, string>)[mimeType] ?? mimeType;
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(t`参考媒体类型须为 ${mediaType}`);
  return { type: "base64", data: bytes.toString("base64"), mimeType };
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  if (!/^https?:\/\//i.test(url)) invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  // Provider responses are not trusted in multi-tenant mode: a provider pointed at a hostile base URL could return an internal address.
  const response = await guardedFetch(url, { signal });
  if (!response.ok) throw new Error(t`下载生成结果失败（HTTP ${response.status}）`);
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("生成文件不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("生成结果为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMediaSize) invalid("生成文件不能超过 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    mimeType = result.mimeType || mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}

async function generateMediaUnrecorded(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  assertModelSelection(mediaType, request.providerId, request.modelId);
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  await resolveWorkspacePath(directory, outputDirectory, true);
  const providerInfo = await getMediaProvider(request.providerId);
  const access = modelAccess("media", request.providerId, request.modelId);
  access.assert();
  const model = providerInfo.models.find(model => model.id === request.modelId && model.type === mediaType);
  if (!model) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  validateCameraRequest({ cameraTrajectory: model.cameraTrajectory, promptControl: model.promptControl }, request, mediaType);
  if (mediaType === "audio" && request.instructions?.trim() && model.speechInstructions !== true) invalid("此配音模型未声明支持情绪与语气指令，请更换模型或清空指令");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const provider = await loadMediaProviderSource(providerInfo.source, record(configurations[providerInfo.id]), signal, undefined, directory);
  const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
  if (typeof generate !== "function") invalid(t`此供应商不支持${translateMessage({ image: "图片", video: "视频", audio: "音频" }[mediaType])}生成`);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("请先在媒体模型设置中配置供应商 API Key");
  const references = async (items: MediaReference[] | undefined, type: string) => items ? Promise.all(items.map(item => readReference(directory, item, type, signal))) : undefined;
  const images = await references(request.images, "image");
  const videos = mediaType === "video" ? await references(request.videos, "video") : undefined;
  const audios = mediaType === "video" ? await references(request.audios, "audio") : undefined;
  const firstFrame = mediaType === "video" && request.firstFrame ? await readReference(directory, request.firstFrame, "image", signal) : undefined;
  const lastFrame = mediaType === "video" && request.lastFrame ? await readReference(directory, request.lastFrame, "image", signal) : undefined;
  signal?.throwIfAborted();
  const assets = await (async () => mediaType === "audio"
    ? await provider.generateAudio!({
      model: request.modelId, text: request.prompt, audios: await references(request.audios, "audio"),
      voice: request.voice, instructions: request.instructions, speed: request.speed, volume: request.volume, format: request.format, sampleRate: request.sampleRate,
    })
    : mediaType === "image"
    ? await provider.generateImage!({ model: request.modelId, prompt: request.prompt, negativePrompt: request.negativePrompt, seed: request.seed, images, ratio: request.ratio, size: request.size })
    : await runCameraSession(provider, () => provider.generateVideo!({
      model: request.modelId, prompt: request.prompt, negativePrompt: request.negativePrompt, seed: request.seed,
      images,
      videos, audios, firstFrame, lastFrame,
      ratio: request.ratio, resolution: request.resolution, duration: request.duration,
      generateAudio: request.generateAudio, mode: request.mode,
      cameraTrajectory: request.cameraTrajectory, imageAndCameraOnly: request.imageAndCameraOnly,
    })))().catch(error => {
      // 只记录供应商调用错误，下载结果、写文件或参数错误不代表模型失效。
      if (!signal?.aborted) access.failed(error);
      if (error instanceof Error && access.reason()) Object.assign(error, { retryable: false });
      throw error;
    });
  if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
  const written: string[] = [];
  const result: GeneratedMedia[] = [];
  try {
    for (const asset of assets) {
      signal?.throwIfAborted();
      const { bytes, mimeType } = await assetBytes(asset, mediaType, signal);
      signal?.throwIfAborted();
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      const release = lockWorkspaceFiles([output.path]);
      try {
        await mkdir(output.path, { recursive: true });
        const file = join(outputDirectory, `${mediaType}${crypto.randomUUID()}.${mediaExtensions[mimeType]}`);
        const { path } = await resolveWorkspacePath(directory, file);
        signal?.throwIfAborted();
        await writeWorkspaceFile(path, bytes, true);
        written.push(path);
        result.push({ path: relative(directory, path).replace(/\\/g, "/"), mimeType, mediaType });
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // ACT: 只回滚本次创建的文件，保留目录中已有的节点资源。
    await Promise.all(written.map(path => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
    throw err;
  }
}

/** Every media generation (from the canvas nodes, the agent tools, or the HTTP route) is recorded for the user's usage receipts. */
export async function generateMediaDirect(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  const started = Date.now();
  const base = { kind: mediaType, providerId: request.providerId, modelId: request.modelId, durationMs: 0 };
  try {
    const files = await generateMediaUnrecorded(cwd, mediaType, request, signal);
    const seconds = (request as { duration?: number }).duration;
    recordUsage(mediaType === "video" && seconds ? { ...base, units: seconds, unit: "second", durationMs: Date.now() - started }
      : { ...base, units: Math.max(1, files.length), unit: mediaType === "image" ? "image" : "call", durationMs: Date.now() - started });
    return files;
  } catch (error) {
    recordUsage({ ...base, units: 0, unit: mediaType === "video" ? "second" : mediaType === "image" ? "image" : "call", status: signal?.aborted ? "cancelled" : "error", durationMs: Date.now() - started });
    throw error;
  }
}


/** Agent tools keep their awaitable contract; the actual generation is owned by the persistent worker. */
export async function generateMedia(cwd: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal): Promise<GeneratedMedia[]> {
  const { cloud } = await import("@/lib/cloud");
  const { currentTenant } = await import("@/utils/tenant");
  const api = cloud();
  if (!api || !currentTenant() || mediaType === "audio") return generateMediaDirect(cwd, mediaType, request, signal);
  signal?.throwIfAborted();
  const { enqueueMedia } = await import("@/utils/media/jobs");
  const job = await enqueueMedia(cwd, mediaType, request, crypto.randomUUID());
  try {
    while (true) {
      signal?.throwIfAborted();
      const state = api.jobView(api.scoped(currentTenant()!.workspaceId).get("generation_jobs", job.id, true));
      if (state.status === "SUCCEEDED") return state.files;
      if (["FAILED", "CANCELLED", "TIMEOUT"].includes(state.status)) throw new Error(state.error || "媒体生成已停止");
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 500);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
  } catch (error) {
    if (signal?.aborted && signal.reason?.code !== "observerDisconnected") {
      const state = api.scoped(currentTenant()!.workspaceId).get("generation_jobs", job.id, true);
      if (state && ["QUEUED", "RUNNING"].includes(state.status)) api.cancelJob(state.workspaceId, job.id, currentTenant()!.userId);
    }
    throw error;
  }
}
