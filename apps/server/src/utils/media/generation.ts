import { recordUsage } from "@/utils/usage";
import { createHash } from "node:crypto";
import { guardedFetch } from "@/utils/ssrf";
import { t, translateMessage } from "@/lib/i18n";
import { mkdir, readFile, realpath, stat, unlink } from "@toonflow/file";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { mediaProviders, type Provider, type ProviderTools } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference, MediaShotSpec } from "@toonflow/tools-scaffold/runtime";
import { cameraTrajectorySchema } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { modelAccess } from "@/utils/modelAvailability";
import { assertMediaModelSelection, isSelectedModel } from "@/utils/modelSelection";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { blockingLine } from "@/utils/media/blocking";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { applyMediaQuality } from "@/utils/media/quality";
import { videoMotionTiming } from "@toonflow/tool-media-generation/runtime";
import { validateSpeechInputs } from "@/utils/media/lipSync";

const maxMediaSize = 100 * 1024 * 1024;
const cameraSessions = new Set<string>();

async function runCameraSession<T>(provider: Provider & { config: Record<string, unknown> }, action: () => Promise<T>) {
  if (provider.id !== "gen3c") return action();
  // ACT: 官方服务只有一个可变 3D 缓存。单进程按源站排他；异常时保留占用，
  // 防止取消 HTTP 后仍在运行的 GPU 任务被下一次 seed 清空。恢复须重启两端。
  const endpoint = new URL(String(provider.config.baseUrl)).origin;
  if (cameraSessions.has(endpoint)) throw new Error("GEN3C 服务正在使用或上次结果不确定；不要重试 seed，异常恢复须重启 GEN3C 与 MILI MILI");
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
      ...(model.type === "audio" ? { voices: model.voices, audioTask: model.audioTask, audioParameterSchema: record(model.inputSchema).properties } : {}),
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

/**
 * 写实基底：用可执行的成像行为替代「8K／超写实／电影感」这类空形容词。
 * 只约束成像与材质，不改创作内容；用户明确要求动画或插画时整段跳过。
 */
const PHOTOGRAPHIC_BASELINE = [
  "PHOTOGRAPHICBASELINE 实拍成像基底：35mm 电影镜头，真实光学景深与自然高光滚降，高光不糊成纯白。",
  "皮肤保留毛孔、绒毛、肤色不均与真实皮脂反光，T 区与鼻头有自然油光；妆感可辨——粉底边界、唇部纹理、眉毛根根分明，不做无瑕哑光的塑料皮肤。",
  "布料可见纤维与自然褶皱，金属与玻璃有各自的光泽与反射，不共用同一种塑料光泽。",
  "光源来自画面内可见或可推断的实际光源，方向明确，墙面与地面留有投影，人物与环境受同一光源支配；不用多点均匀柔光把脸拍平。",
  "头发有碎发飞出与不均匀的发丝反光，发根保留蓬松与分缝。",
  "曝光正常，画面明亮通透，中间调不压暗，暗部保留细节但不到死黑。",
  "色彩自然准确，不刻意降低饱和度，不加青橙滤镜，不让人脸与墙面发灰。",
  "画面干净：无明显噪点、无胶片颗粒、无脏污、无划痕、无霉斑、无做旧痕迹。",
  "服装、道具与场景保持干净完整、维护良好；只有剧情明确要求的状态改变才例外，且只影响指定对象。",
  "禁止 3D 渲染感、CG 塑料质感、无瑕均匀皮肤与全画面同焦。",
].join("");

/**
 * 判断提示词是否在写人：编译层会追加 REFERENCEUSE 等模板段落，只取 REQUEST: 到下一个大写标记之间的作者原文，
 * 否则模板里的 "face" 会把空镜误判成人物镜头。
 */
export function looksLikePersonShot(prompt: string) {
  const authored = /REQUEST:\s*([\s\S]*?)(?=\n[A-Z][A-Z0-9]{3,}:|$)/.exec(prompt)?.[1] ?? prompt;
  // 明确声明空镜的请求直接放行：场景与道具的描述里常会提到人物，按关键词一刀切会把空镜全部误拦。
  if (/无人|空镜|不出现人物|不要人物|无人物|\bno people\b|\bempty scene\b/i.test(authored)) return false;
  return /人脸|面容|面部|正脸|肖像|长相|五官|表情|眼神|口型|对白|台词|人物|角色|男主|女主|演员|男人|女人|男子|女子|男性|女性|男孩|女孩|\bface\b|\bportrait\b|\beyes\b|\bdialogue\b|\bman\b|\bwoman\b/i.test(authored);
}

/**
 * 幂等地补上写实基底。入队与执行两处都会调用，靠标记避免重复叠加；
 * 明确要求动画、插画、漫画、3D 渲染等风格时整段跳过，保持「真人要超逼真、漫画照常出漫画」的分流。
 */
/**
 * 把镜头规格编译成结构化指令：景别、运镜、调度、表演、光线逐项写清，
 * 模型不必再从一句散文里猜；空字段直接省略，不补默认值。
 */
export function compileShotSpec(spec: MediaShotSpec | undefined) {
  if (!spec) return "";
  const parts = [
    spec.shotSize ? `景别 ${spec.shotSize}` : "",
    spec.lens ? `焦段 ${spec.lens}` : "",
    spec.cameraMove ? `运镜 ${spec.cameraMove}` : "",
    spec.blocking ? `调度 ${spec.blocking}` : "",
    spec.action ? `动作 ${spec.action}` : "",
    spec.performance ? `表演 ${spec.performance}` : "",
    spec.lighting ? `光线 ${spec.lighting}` : "",
    spec.startState ? `起始 ${spec.startState}` : "",
    spec.endState ? `结束 ${spec.endState}` : "",
  ].filter(Boolean);
  return parts.length ? `SHOTSPEC: ${parts.join("；")}` : "";
}

export function withPhotographicBaseline(prompt: string) {
  if (prompt.includes("PHOTOGRAPHICBASELINE")) return prompt;
  const authored = /REQUEST:\s*([\s\S]*?)(?=\n[A-Z][A-Z0-9]{3,}:|$)/.exec(prompt)?.[1] ?? prompt;
  if (/动画|插画|漫画|卡通|二次元|像素|3D\s*渲染|CG\s*渲染|anime|cartoon|illustration|\brender\b|\bstylized\b/i.test(authored)) return prompt;
  return `${PHOTOGRAPHIC_BASELINE}\n\n${prompt}`;
}

/** 视频未指定时长时的推荐值：取模型可用区间的上限三分之二，避免每次都落在最短档。 */
function recommendedDuration(map: unknown, requested: number | undefined) {
  if (typeof requested === "number" && requested > 0) return requested;
  const ranges = Array.isArray(map) ? map : [];
  const supported = ranges
    .flatMap(entry => Array.isArray((entry as { duration?: unknown })?.duration) ? (entry as { duration: number[] }).duration : [])
    .filter(value => Number.isFinite(value) && value > 0);
  if (!supported.length) return requested;
  return Math.round(Math.max(...supported) * 2 / 3);
}

/**
 * 提示词红线：主动做旧、以及纯文本生成人物镜。
 * 入队前也调用一次——排在队列里执行时才失败，用户看到的是「提交成功然后红了一片」，说不清哪一步错了。
 */
export function assertPromptPolicy(request: MediaGenerationRequest, mediaType: "image" | "video" | "audio", compiledInputs: { sent: boolean; mediaId: string | null; role: string }[] = []) {
  // 禁止主动做旧：默认干净完整是产品底线，只有明确标注设计意图的破败场景才放行。
  const DISTRESSED = /脏|污渍|油污|污垢|破烂|腐烂|发霉|霉斑|生锈|锈蚀|破洞|破损|陈旧|做旧|衰败|荒废|废墟|残破|\bdirty\b|\brusted\b|\bdecayed\b|\bderelict\b|\bgrimy\b/i;
  // 只检查作者自己写的部分：系统注入的基底与锚点段落本身含有「污渍/破损」这类词，
  // 不排除就会自己触发自己的规则（实际发生过）。
  const stripped = request.prompt
    .replace(/PHOTOGRAPHICBASELINE[\s\S]*?\n\n/g, "")
    .replace(/^LOOK: [\s\S]*?\n\n/m, "")
    .replace(/^ERA [\s\S]*?\n\n/m, "")
    .replace(/^CAST: [\s\S]*?\n\n/m, "")
    .replace(/^SHOTSPEC: .*\n\n/m, "");
  const authoredPrompt = /REQUEST:\s*([\s\S]*?)(?=\n[A-Z][A-Z0-9]{3,}:|$)/.exec(stripped)?.[1] ?? stripped;
  // 再剥掉否定句：「没有污渍、破损」是在要求干净，不是在要求做旧。
  const positiveDemand = authoredPrompt
    .replace(/(没有|无|不带|不要|不出现|禁止|避免|去除|不主动|不添加|不做|不得)[^，。；,;.\n]*/g, "")
    .replace(/\b(no|without|avoid|remove|clean of)\b[^,.;\n]*/gi, "");
  if (mediaType !== "audio" && DISTRESSED.test(positiveDemand) && !/DISTRESSED\s*[:：]/i.test(request.prompt)) {
    // 把命中的词直接回给作者：只报「不许做旧」等于让人去猜是哪几个字踩了线。
    const hits = [...new Set(positiveDemand.match(new RegExp(DISTRESSED.source, "gi")) ?? [])].slice(0, 6);
    invalid(`提示词里出现会被生成成脏旧破损的词：${hits.map(word => `「${word}」`).join("、")}。默认不生成脏旧破损的人物、服装与场景。若不是设计需要，换成具体面料、剪裁与颜色；确属设计需要（废墟、贫民窟、战后场景），在提示词里写明「DISTRESSED: 具体理由」，只影响该对象与当前时段`);
  }

  // 人物原视频也是身份锚点；专用口型模型只接收视频与声音，不能误要求额外参考图。
  const hasCompiledIdentity = compiledInputs.some(ref => ref.sent && ref.mediaId && ["IDENTITY", "START_FRAME", "PERFORMANCE"].includes(ref.role));
  if (mediaType === "video" && request.purpose !== "asset" && !hasCompiledIdentity && !request.images?.length && !request.videos?.length && !request.firstFrame && !request.lastFrame) {
    if (looksLikePersonShot(request.prompt)) {
      invalid("人物镜头必须提供身份参考：用 images 传已采用的定妆图、firstFrame 接上一镜末帧，或 videos 传人物原视频。纯文本生成会每镜重新选角，跨镜必然换脸；仅空镜、环境、流体、光效可用纯文本");
    }
  }
}

async function generateMediaUnrecorded(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
  reportTask?: ProviderTools["reportTask"],
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  await assertMediaModelSelection(mediaType, request, cwd);
  const directory = await realpath(cwd);
  // 静音是交付约束，先确认能处理，避免供应商忽略开关后已经付费却无法交付。
  const silentFfmpeg = mediaType === "video" && request.generateAudio === false ? await createWorkspaceFfmpeg(directory, signal, true) : undefined;
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  await resolveWorkspacePath(directory, outputDirectory, true);
  const providerInfo = await getMediaProvider(request.providerId);
  const access = modelAccess("media", request.providerId, request.modelId);
  access.assert();
  const model = providerInfo.models.find(model => model.id === request.modelId && model.type === mediaType);
  if (!model) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  const speechInputs = mediaType === "video" && model.lipSync ? await validateSpeechInputs(directory, request, signal) : undefined;
  validateCameraRequest({ cameraTrajectory: model.cameraTrajectory, promptControl: model.promptControl }, request, mediaType);
  if (mediaType === "audio" && request.instructions?.trim() && model.speechInstructions !== true) invalid("此配音模型未声明支持情绪与语气指令，请更换模型或清空指令");
  if (mediaType === "audio" && Object.keys(request.audioParameters ?? {}).length && !model.inputSchema) invalid("此模型未提供额外音频参数定义，请清空额外参数");
  // 视频未明确指定时长时按模型能力取推荐值：调用方漏传时不再落到供应商默认的最短档，也不强制每镜等长。
  const duration = mediaType === "video" ? recommendedDuration(model.durationResolutionMap, request.duration) : request.duration;
  assertPromptPolicy(request, mediaType);
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const provider = await loadMediaProviderSource(providerInfo.source, record(configurations[providerInfo.id]), signal, undefined, directory, reportTask);
  const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
  if (typeof generate !== "function") invalid(t`此供应商不支持${translateMessage({ image: "图片", video: "视频", audio: "音频" }[mediaType])}生成`);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("请先在媒体模型设置中配置供应商 API Key");
  const spec = request.prompt.includes("SHOTSPEC:") ? "" : compileShotSpec(request.shotSpec);
  const motionTiming = mediaType === "video" && !request.prompt.includes(videoMotionTiming) ? `MOTIONTIMING: ${videoMotionTiming}` : "";
  const prompt = withPhotographicBaseline([spec, request.prompt, motionTiming].filter(Boolean).join("\n\n"));
  // ACT: 仅本次请求复用同路径、声明类型及用途的读取，跨次生成重新检查真实文件。
  const referenceReads = new Map<string, ReturnType<typeof readReference>>();
  const reference = (item: MediaReference, type: string) => {
    const key = JSON.stringify([item.path, item.mimeType, type]);
    if (!referenceReads.has(key)) referenceReads.set(key, readReference(directory, item, type, signal));
    return referenceReads.get(key)!;
  };
  const references = (items: MediaReference[] | undefined, type: string) => items ? Promise.all(items.map(item => reference(item, type))) : undefined;
  const [images, videos, audios, firstFrame, lastFrame] = await Promise.all([
    references(request.images, "image"),
    mediaType === "video" ? references(request.videos, "video") : undefined,
    mediaType !== "image" ? references(request.audios, "audio") : undefined,
    mediaType === "video" && request.firstFrame ? reference(request.firstFrame, "image") : undefined,
    mediaType === "video" && request.lastFrame ? reference(request.lastFrame, "image") : undefined,
  ]);
  if (speechInputs && (createHash("sha256").update(Buffer.from(videos![0]!.data, "base64")).digest("hex") !== speechInputs.videoHash
    || createHash("sha256").update(Buffer.from(audios![0]!.data, "base64")).digest("hex") !== speechInputs.audioHash)) invalid("口型参考在检查后被替换，本次未提交生成");
  signal?.throwIfAborted();
  // 兼容尚未上报远端句柄的适配器：进入调用后不能把无回执当作可安全重试。
  await reportTask?.({ status: "submitting" });
  const assets = await (async () => mediaType === "audio"
    ? await provider.generateAudio!({
      model: request.modelId, text: request.prompt, audios, audioParameters: request.audioParameters,
      voice: request.voice, instructions: request.instructions, speed: request.speed, volume: request.volume, format: request.format, sampleRate: request.sampleRate,
    })
    : mediaType === "image"
    ? await provider.generateImage!({ model: request.modelId, prompt, negativePrompt: request.negativePrompt, seed: request.seed, images, ratio: request.ratio, size: request.size })
    : await runCameraSession(provider, () => provider.generateVideo!({
      model: request.modelId, prompt, negativePrompt: request.negativePrompt, seed: request.seed,
      images,
      videos, audios, firstFrame, lastFrame,
      ratio: request.ratio, resolution: request.resolution, duration,
      generateAudio: request.generateAudio, mode: request.mode,
      cameraTrajectory: request.cameraTrajectory, imageAndCameraOnly: request.imageAndCameraOnly,
    })))().catch(error => {
      // 只记录供应商调用错误，下载结果、写文件或参数错误不代表模型失效。
      if (!signal?.aborted) access.failed(error);
      if (error instanceof Error && access.reason()) Object.assign(error, { retryable: false });
      throw error;
    });
  if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
  // 下载或写入失败不能重新生成已经完成的素材。
  await reportTask?.({ status: "completed" });
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
        let deliveredPath = path;
        if (silentFfmpeg) {
          const probe = await new Promise<import("@toonflow/ffmpeg/types").FfprobeData>((resolve, reject) => silentFfmpeg.ffprobe(file, (error, data) => error ? reject(error) : resolve(data)));
          if (probe.streams.some(stream => stream.codec_type === "audio")) {
            const silentFile = file.replace(/\.[^.]+$/, `Silent.${mediaExtensions[mimeType]}`);
            const silentPath = (await resolveWorkspacePath(directory, silentFile, true)).path;
            const command = silentFfmpeg(file).noAudio().videoCodec("copy");
            const cancel = () => command.kill("SIGKILL");
            signal?.addEventListener("abort", cancel, { once: true });
            try {
              signal?.throwIfAborted();
              await new Promise<void>((resolve, reject) => command.on("error", reject).on("end", () => resolve()).on("start", () => { if (signal?.aborted) cancel(); }).save(silentFile));
              deliveredPath = silentPath;
            } catch (error) {
              await unlink(silentPath).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "ENOENT") throw failure; });
              throw new Error(`原视频已保留：${file}，静音处理失败，仅修复音轨处理，不重新生成视频。${error instanceof Error ? error.message : String(error)}`);
            } finally { signal?.removeEventListener("abort", cancel); }
          }
        } else written.push(path);
        const fileResult: GeneratedMedia = { path: relative(directory, deliveredPath).replace(/\\/g, "/"), mimeType, mediaType };
        if (mediaType === "audio") {
          try {
            const ffmpeg = await createWorkspaceFfmpeg(directory, signal);
            const probe = await new Promise<import("@toonflow/ffmpeg/types").FfprobeData>((resolve, reject) => ffmpeg.ffprobe(file, (error, data) => error ? reject(error) : resolve(data)));
            const actualDuration = Number(probe.format.duration);
            if (!probe.streams.some(stream => stream.codec_type === "audio") || !Number.isFinite(actualDuration) || actualDuration <= 0) throw new Error("无法取得有效音轨时长");
            fileResult.duration = actualDuration;
          } catch (error) {
            // ACT: 付费声音已经保存，探测失败只阻止排时间线，不能诱发重新生成或删除结果。
            fileResult.timingWarning = `音频已保存，但实际时长未验证；先 ffprobe，不能估算排轨或重新生成。${error instanceof Error ? error.message : String(error)}`;
          }
          const { cloud } = await import("@/lib/cloud");
          const { currentTenant } = await import("@/utils/tenant");
          const { workspaceProject } = await import("@/utils/media/jobs");
          const api = cloud(), tenant = currentTenant();
          const projectId = api && tenant ? workspaceProject(directory, false) : undefined;
          // 服务端记录真实生成用途；同字节配音不能重命名为 music/sfx 逃过对白校验。
          if (api && tenant && projectId) await api.importWorkspaceAudio(api.scoped(tenant.workspaceId), projectId, Buffer.from(bytes), model.audioTask === "music" ? "music" : model.audioTask === "soundEffect" ? "sfx" : "speech");
        }
        result.push(fileResult);
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // 已完成的供应商产物保留：取消或后续探测失败不能删除已付费文件，诱发重复生成。
    if (written.length) {
      const savedFiles = written.map(path => relative(directory, path).replaceAll("\\", "/"));
      const failure = new Error(`${err instanceof Error ? err.message : String(err)}。已保存文件：${savedFiles.join("、")}。请复用文件，仅修复后续处理，不重新生成。`, { cause: err });
      throw Object.assign(failure, { savedFiles, retryable: false });
    }
    throw err;
  }
}

const canvasWriteQueue = new Map<string, Promise<unknown>>();

/**
 * 生成结果必须落到画布：outputName 本来就是「画布显示名称」，但此前只用于任务记录，
 * 磁盘上有文件、UI 里没有节点，用户会认为没生成。同一画布串行写入，避免并发任务互相覆盖。
 */
async function registerOnCanvas(cwd: string, file: GeneratedMedia, request: MediaGenerationRequest) {
  if (file.mediaType === "audio") return;
  const canvasPath = join(cwd, "画布1.json");
  const dataType = file.mediaType === "video" ? "VIDEO" : "IMAGE";
  const handle = file.mediaType === "video" ? "video" : "image";
  const label = request.outputName?.trim() || file.path.split("/").pop()?.replace(/\.[^.]+$/, "") || "未命名";
  const previous = canvasWriteQueue.get(canvasPath) ?? Promise.resolve();
  const task = previous.then(async () => {
    let canvas: Record<string, unknown> = { milimiliCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.5 } };
    try {
      if (existsSync(canvasPath)) {
        const parsed: unknown = JSON.parse(readFileSync(canvasPath, "utf8"));
        if (parsed && typeof parsed === "object" && ((parsed as { milimiliCanvas?: unknown }).milimiliCanvas === true || (parsed as { littoCanvas?: unknown }).littoCanvas === true || (parsed as { toonflowCanvas?: unknown }).toonflowCanvas === true)) canvas = parsed as Record<string, unknown>;
      }
    } catch { /* 画布损坏：按默认结构重建，避免一个坏文件卡死后续登记 */ }
    const nodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Record<string, unknown>[]) : [];
    if (nodes.some(node => (node?.data as { sourcePath?: string } | undefined)?.sourcePath === file.path)) return;
    const index = nodes.length;
    nodes.push({
      id: `shot-${crypto.randomUUID()}`,
      type: file.mediaType === "video" ? "remote-videoNode" : "remote-imageNode",
      initialized: true,
      position: { x: (index % 4) * 420, y: Math.floor(index / 4) * 340 },
      data: {
        label,
        sourcePath: file.path,
        outputs: { [handle]: { dataType, value: { url: file.path, mimeType: file.mimeType } } },
        handles: [{ id: handle, type: "source", dataType, label: file.mediaType === "video" ? "视频输出" : "图像输出" }],
        lineageLabel: label,
      },
    });
    canvas.nodes = nodes;
    writeFileSync(canvasPath, JSON.stringify(canvas, null, 1), "utf8");
  }).catch(() => { /* 画布登记失败不影响已生成的素材本身 */ });
  canvasWriteQueue.set(canvasPath, task);
  return task;
}

/** Every media generation (from the canvas nodes, the agent tools, or the HTTP route) is recorded for the user's usage receipts. */
export async function generateMediaDirect(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
  reportTask?: ProviderTools["reportTask"],
): Promise<GeneratedMedia[]> {
  const started = Date.now();
  const base = { kind: mediaType, providerId: request.providerId, modelId: request.modelId, durationMs: 0 };
  try {
    const files = await generateMediaUnrecorded(cwd, mediaType, request, signal, reportTask);
    // 先登记画布再计费返回：用户在 UI 里看到的节点与磁盘文件必须同时存在。
    for (const file of files) await registerOnCanvas(cwd, file, request);
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
export async function generateMedia(cwd: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<GeneratedMedia[]> {
  const { cloud } = await import("@/lib/cloud");
  const { currentTenant } = await import("@/utils/tenant");
  const api = cloud();
  if (request.localRepair && (!api || !currentTenant() || mediaType !== "image" || !request.shotId)) invalid("关键帧精修须使用已连接项目的图像镜头，不能退化成独立文生图");
  if (!api || !currentTenant() || mediaType === "audio") {
    if (mediaType !== "audio") {
      const model = (await listMediaModels()).find(model => model.type === mediaType && model.providerId === request.providerId && model.modelId === request.modelId);
      if (!model) invalid("所选媒体模型不存在或类型不匹配");
      request = await applyMediaQuality(cwd, mediaType, request, model);
      const blocking = request.prompt.includes("BLOCKING:") ? "" : await blockingLine(cwd, request.outputName);
      if (blocking) request = { ...request, prompt: `${blocking}\n\n${request.prompt}` };
    }
    return generateMediaDirect(cwd, mediaType, request, signal);
  }
  signal?.throwIfAborted();
  onProgress?.("正在校验编译规格与参考素材，尚未提交生成");
  const { enqueueMedia } = await import("@/utils/media/jobs");
  const job = await enqueueMedia(cwd, mediaType, request, crypto.randomUUID());
  const started = Date.now();
  let reported = "";
  let reportedAt = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const state = api.jobView(api.scoped(currentTenant()!.workspaceId).get("generation_jobs", job.id, true));
      if (state.status !== reported || Date.now() - reportedAt >= 10000) {
        reported = state.status;
        reportedAt = Date.now();
        const label = state.status === "QUEUED" ? "已入队，等待执行" : state.status === "RUNNING" ? "任务处理中（供应商未提供百分比）" : state.status;
        onProgress?.(`任务 ${job.id} · ${label} · 已等待 ${Math.floor((Date.now() - started) / 1000)} 秒`);
      }
      if (state.status === "SUCCEEDED") return state.files;
      if (["FAILED", "CANCELLED", "TIMEOUT"].includes(state.status)) throw new Error(`${state.error || "媒体生成已停止"}。任务 ${job.id} 已停止。${request.shotId ? "相同镜头请求不会自动重发。确认需要重做后使用新的 regenerationId，同一次重做须复用该 ID。" : "请核查失败原因后再决定是否重试。"}`);
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 2000);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
  } catch (error) {
    if (!("reused" in job && job.reused) && signal?.aborted && signal.reason?.code !== "observerDisconnected") {
      const state = api.scoped(currentTenant()!.workspaceId).get("generation_jobs", job.id, true);
      if (state && ["QUEUED", "RUNNING"].includes(state.status)) api.cancelJob(state.workspaceId, job.id, currentTenant()!.userId);
    }
    throw error;
  }
}
