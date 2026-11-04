const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://xingsuan.cloud/api/v3" },
] as const;

function knownModel(id: string): ProviderModel | undefined {
  if (["doubao-seedream-5-0", "doubao-seedream-5-0-pro", "qwen-image-3.0", "qwen-image-3.0-pro"].includes(id)) {
    return { id, label: id, type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"] };
  }
  if (["wan3.0-video", "wan3.0-video-prime", "MiniMax-H3", "MiniMax-H3-Max", "kling-4.0"].includes(id)) {
    const wan = id.startsWith("wan");
    const max = id === "MiniMax-H3-Max";
    const kling = id.startsWith("kling");
    const start = wan ? 2 : kling ? 3 : max ? 5 : 4;
    const end = wan || kling ? 30 : 15;
    return { id, label: id, type: "video", mode: ["text", "singleImage", "endFrameOptional", ...(!max ? [kling ? ["imageReference:10", "videoReference:5"] : wan ? ["imageReference:10", "videoReference:5", "audioReference:5"] : ["imageReference:9", "videoReference:3", "audioReference:3"]] as VideoMode[] : [])],
      audio: wan ? "optional" : kling, nativeDialogue: wan || kling, durationResolutionMap: [{ duration: Array.from({ length: end - start + 1 }, (_, index) => start + index), resolution: wan ? ["480P", "720P", "1080P"] : kling ? ["720P", "1080P"] : max ? ["480P", "768P"] : ["768P", "2K"] }] };
  }
  if (["doubao-seedance-1-0-pro-250528", "doubao-seedance-1-0-pro-fast-251015", "doubao-seedance-1-5-pro-251215"].includes(id)) {
    const is15 = id.includes("1-5");
    return { id, label: id, type: "video", mode: ["text", "singleImage", "endFrameOptional"], audio: is15 ? "optional" : false, nativeDialogue: is15,
      durationResolutionMap: [{ duration: Array.from({ length: is15 ? 9 : 11 }, (_, index) => index + (is15 ? 4 : 2)), resolution: ["480P", "720P", "1080P"] }] };
  }
  const channelModels: Record<string, [number, string[]]> = {
    "k/seedance-2.0-mini": [15, ["480P", "720P"]], "k/seedance-2.0-fast": [15, ["480P", "720P"]],
    "k/seedance-2.0": [15, ["480P", "720P", "1080P", "4K"]], "c/seedance-2.0": [15, ["480P", "720P", "1080P", "4K"]],
    "s/seedance-2.5": [30, ["720P"]], "z/seedance-2.5": [30, ["480P", "720P"]],
    "z/seedance-2.0": [15, ["480P", "720P", "1080P", "4K"]], "z/seedance-2.0-fast": [15, ["480P", "720P"]], "z/seedance-2.0-mini": [15, ["480P", "720P"]],
    "r/seedance-2.5": [30, ["480P", "720P", "1080P"]], "r/seedance-2.0": [15, ["480P", "720P", "1080P", "4K"]],
    "r/seedance-2.0-fast": [15, ["480P", "720P"]], "r/seedance-2.0-mini": [15, ["480P", "720P"]],
    "doubao-seedance-2-5-260628": [30, ["480P", "720P", "1080P"]],
    "doubao-seedance-2-0-260128": [15, ["480P", "720P", "1080P", "4K"]],
    "doubao-seedance-2-0-fast-260128": [15, ["480P", "720P"]], "doubao-seedance-2-0-mini-260615": [15, ["480P", "720P"]],
  };
  const capability = channelModels[id];
  if (!capability) return;
  const is25 = id.includes("2.5") || id.includes("2-5");
  return { id, label: id, type: "video", mode: ["text", "singleImage", "endFrameOptional", is25 ? ["imageReference:30", "videoReference:10", "audioReference:10"] : ["imageReference:9", "videoReference:3", "audioReference:3"]],
    audio: "optional", nativeDialogue: true, durationResolutionMap: [{ duration: Array.from({ length: capability[0] - 3 }, (_, index) => index + 4), resolution: capability[1] }] };
}

function modelsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (!url.pathname.replace(/\/+$/, "").endsWith("/api/v3")) throw new Error("星算云 API 地址须以 /api/v3 结尾");
  url.pathname = url.pathname.replace(/\/+$/, "").slice(0, -7) + "/v1/models";
  return url.toString();
}

function endpointUrl(baseUrl: string, path: string) {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, "");
  if (!prefix.endsWith("/api/v3")) throw new Error("星算云 API 地址须以 /api/v3 结尾");
  const query = path.indexOf("?");
  url.pathname = prefix.slice(0, -7) + (query < 0 ? path : path.slice(0, query));
  url.search = query < 0 ? "" : path.slice(query);
  return url.toString();
}

function imageUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: unknown) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请填写星算云 API Key");
  const baseUrl = String(context.config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("请填写星算云 API 地址");
  const response = await context.tool.fetch(path.startsWith("/api/") || path.startsWith("/kling/") || path.startsWith("/v2/") ? endpointUrl(baseUrl, path) : `${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(context.tool.errorMessage(result.error ?? result) || `星算云请求失败（HTTP ${response.status}）`);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("星算云响应格式错误");
  if (result.error) throw new Error(context.tool.errorMessage(result.error) || "星算云请求失败");
  return result;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function resumeMedia(this: ProviderContext, task: MediaTask & { id: string }): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  while (true) {
    const path = task.operation === "wan" ? `/api/v1/tasks/${encodeURIComponent(task.id)}`
      : task.operation === "minimax" ? `/v2/query/video_generation/${encodeURIComponent(task.id)}`
      : task.operation === "kling" ? `/kling/tasks?task_ids=${encodeURIComponent(task.id)}`
      : `/contents/generations/tasks/${encodeURIComponent(task.id)}`;
    const result = await fetchJson(this, path, signal);
    const detail = task.operation === "wan" ? result.output : task.operation === "minimax" ? result.task : task.operation === "kling" ? result.data?.[0] : result;
    if (!detail || typeof detail !== "object") throw new Error("星算云任务响应格式错误");
    const status = String(detail.task_status ?? detail.status ?? "unknown").toLowerCase();
    await this.tool.reportTask?.({ id: task.id, status, operation: task.operation });
    if (["failed", "failure", "cancelled", "canceled", "rejected", "error", "unknown"].includes(status)) {
      await this.tool.reportTask?.({ id: task.id, status: "failed", operation: task.operation });
      throw Object.assign(new Error(this.tool.errorMessage(detail.error ?? detail) || "供应商原任务失败"), { retryable: false, fallbackAllowed: false });
    }
    if (status === "succeeded") {
      const url = task.operation === "wan" ? detail.video_url : task.operation === "minimax" ? detail.content?.url : task.operation === "kling" ? detail.outputs?.find((item: any) => item.type === "video")?.url : detail.content?.video_url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("星算云未返回有效视频地址");
      return [{ mediaType: "video", type: "url", url }];
    }
    if (!["queued", "pending", "submitted", "processing", "running"].includes(status)) throw new Error("星算云视频任务状态无效");
    await wait(signal);
  }
}

async function generateOtherVideo(this: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
  const model = this.models?.find(item => item.id === request.model && item.type === "video");
  if (!model) throw new Error("此模型尚未适配，请先同步模型");
  const wan = request.model.startsWith("wan3.0-");
  const kling = request.model === "kling-4.0";
  const operation = wan ? "wan" : kling ? "kling" : "minimax";
  let images = request.images ?? [];
  let first = request.firstFrame;
  if (request.mode === "singleImage" && !first && images.length === 1) { first = images[0]; images = []; }
  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  if (request.lastFrame && !first || (first || request.lastFrame) && (images.length || videos.length || audios.length)) throw new Error("首尾帧不能与其他参考素材混用，尾帧须搭配首帧");
  if (Array.isArray(request.mode)) {
    if (!model.mode?.some(mode => Array.isArray(mode) && JSON.stringify(mode) === JSON.stringify(request.mode))) throw new Error("不支持此参考模式");
    const count = (type: string) => Number((request.mode as string[]).find(value => value.startsWith(type + ":"))?.split(":")[1] ?? 0);
    if (!images.length && !videos.length && !audios.length || images.length > count("imageReference") || videos.length > count("videoReference") || audios.length > count("audioReference")) throw new Error("参考素材数量不符合模型要求");
  } else if (images.length || videos.length || audios.length || request.mode === "text" && first || request.mode === "singleImage" && (!first || request.lastFrame) || request.mode === "endFrameOptional" && !first) throw new Error("素材与所选视频模式不匹配");
  const duration = request.duration ?? 5;
  const resolution = (request.resolution ?? (wan ? "720P" : kling ? "1080P" : "768P")).toUpperCase();
  if (!model.durationResolutionMap?.some(row => row.duration.includes(duration) && row.resolution.includes(resolution))) throw new Error("不支持此时长与分辨率组合");
  const ratio = request.ratio ?? "16:9";
  if (!(kling ? ["16:9", "9:16", "1:1", "21:9"] : wan ? ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"] : ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]).includes(ratio)) throw new Error("不支持此画幅");
  if (kling && images.length + videos.length > 15) throw new Error("可灵参考素材总数不能超过 15");
  if (!wan && !kling && request.generateAudio) throw new Error("当前模型未提供音频生成开关");
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  const toUrl = async (input: MediaInput, video = false) => wan || (kling && video) ? this.tool.relayMedia(input) : imageUrl(input);
  const firstUrl = first ? await toUrl(first) : undefined;
  const lastUrl = request.lastFrame ? await toUrl(request.lastFrame) : undefined;
  const imageUrls = await Promise.all(images.map(input => toUrl(input)));
  const videoUrls = await Promise.all(videos.map(input => toUrl(input, true)));
  const audioUrls = await Promise.all(audios.map(input => toUrl(input)));
  const media = [ ...(firstUrl ? [{ type: "first_frame", url: firstUrl }] : []), ...(lastUrl ? [{ type: "last_frame", url: lastUrl }] : []),
    ...imageUrls.map(url => ({ type: "reference_image", url })), ...videoUrls.map(url => ({ type: "reference_video", url })), ...audioUrls.map(url => ({ type: "reference_audio", url })) ];
  let path: string;
  let body: unknown;
  if (wan) {
    path = "/api/v1/services/aigc/video-generation/video-synthesis";
    body = { model: request.model, input: { prompt: request.prompt, ...(media.length ? { media } : {}) }, parameters: { resolution, ratio, duration, audio: request.generateAudio ?? false, watermark: request.watermark ?? false } };
  } else if (kling) {
    const reference = imageUrls.length || videoUrls.length;
    path = `/kling/${reference ? "omni-video" : firstUrl ? "image-to-video" : "text-to-video"}/kling-4.0`;
    const contents = [ { type: "prompt", text: request.prompt }, ...(firstUrl ? [{ type: "first_frame", url: firstUrl }] : []), ...(lastUrl ? [{ type: "last_frame", url: lastUrl }] : []),
      ...imageUrls.map((url, index) => ({ type: "refer_image", url, id: `image_${index + 1}` })), ...videoUrls.map((url, index) => ({ type: "feature_video", url, id: `video_${index + 1}` })) ];
    body = { ...(reference || firstUrl ? { contents } : { prompt: request.prompt }), settings: { resolution: resolution.toLowerCase(), aspect_ratio: ratio, duration }, options: { watermark_info: { enabled: request.watermark ?? false } } };
  } else {
    path = "/v2/video_generation";
    body = { model: request.model, content: [{ type: "text", text: request.prompt }, ...media.map(item => ({ type: item.type.includes("video") ? "video_url" : item.type.includes("audio") ? "audio_url" : "image_url", [item.type.includes("video") ? "video_url" : item.type.includes("audio") ? "audio_url" : "image_url"]: { url: item.url }, role: item.type }))], resolution, duration, ratio: firstUrl ? "adaptive" : ratio, aigc_watermark: request.watermark ?? false };
  }
  if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024) throw new Error("请求体超过 64 MB，请压缩素材或使用公网链接");
  const result = await fetchJson(this, path, signal, body);
  if (kling && result.code !== 0) throw new Error(this.tool.errorMessage(result) || "可灵任务提交失败");
  const id = wan ? result.output?.task_id : kling ? result.data?.id : result.task_id;
  if (typeof id !== "string" || !id) throw new Error("星算云未返回任务 ID");
  const task = { id, status: "submitted", mediaType: "video" as const, operation };
  await this.tool.reportTask?.(task);
  return resumeMedia.call(this, task);
}

export default {
  resumeMedia,
  id: "xingsuan", label: "星算云", version: "1.1.1", rules,
  readme: "星算云 Seedance 火山兼容接口。使用 xsk_ 开头的 API Key；模型权限以星算云控制台为准。\n\n[接口文档](https://docs.xingsuan.cloud/video/seedance)",
  models: [
    { id: "doubao-seedance-2-0-260128", label: "Seedance 2.0", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]], audio: "optional", nativeDialogue: true, durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "720P", "1080P", "4K"] }] },
  ] satisfies ProviderModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const key = String(this.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
    const base = String(this.config.baseUrl ?? "").trim();
    if (!key || !base) throw new Error("请填写星算云 API Key 和地址");
    const response = await this.tool.fetch(modelsUrl(base), { headers: { Authorization: `Bearer ${key}` }, signal: this.signal ?? AbortSignal.timeout(30000) });
    const result = await response.json().catch(() => ({})) as { data?: unknown; error?: unknown };
    if (!response.ok) throw new Error(this.tool.errorMessage(result.error ?? result) || `获取星算云模型失败（HTTP ${response.status}）`);
    if (!Array.isArray(result.data)) throw new Error("星算云模型目录格式错误");
    return result.data.flatMap(item => {
      if (!item || typeof item.id !== "string" || modelIds && !modelIds.includes(item.id)) return [];
      const model = knownModel(item.id);
      return model ? [model] : [];
    });
  },
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const model = this.models?.find(item => item.id === request.model && item.type === "image");
    if (!model || !request.prompt.trim()) throw new Error("请选择已适配的图片模型并填写提示词");
    if (request.mask || request.n !== undefined && request.n !== 1) throw new Error("暂不支持蒙版或一次生成多张图片");
    const qwen = request.model.startsWith("qwen-image-");
    const images = request.images ?? [];
    if (!qwen && Buffer.byteLength(JSON.stringify(images.map(imageUrl))) > 8 * 1024 * 1024) throw new Error("Seedream Base64 参考图请求不能超过 8 MB，请压缩图片");
    if (images.length > (qwen ? 3 : request.model.endsWith("-pro") ? 10 : 14)) throw new Error("参考图片数量超出模型限制");
    const sizes: Record<string, [number, number]> = { "1:1": [1024, 1024], "16:9": [1360, 768], "9:16": [768, 1360], "4:3": [1184, 896], "3:4": [896, 1184] };
    const dimensions = sizes[request.ratio ?? "1:1"];
    const size = request.size ?? "1K";
    if (!dimensions || !["1K", "2K"].includes(size)) throw new Error("不支持此图片尺寸或画幅");
    const scale = size === "2K" ? (qwen ? 2048 / Math.max(...dimensions) : 2) : 1;
    const imageSize = dimensions.map(value => Math.round(value * scale / 16) * 16);
    const signal = AbortSignal.any([AbortSignal.timeout(6 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const result = qwen
      ? await fetchJson(this, "/api/v1/services/aigc/multimodal-generation/generation", signal, { model: request.model, input: { messages: [{ role: "user", content: [...await Promise.all(images.map(async input => ({ image: await this.tool.relayMedia(input) }))), { text: request.prompt }] }] }, parameters: { size: imageSize.join("*"), n: 1, ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}) } })
      : await fetchJson(this, "/images/generations", signal, { model: request.model, prompt: request.prompt, size: imageSize.join("x"), response_format: "url", ...(images.length ? { image: images.map(imageUrl) } : {}) });
    const urls: unknown[] = qwen ? (result.output?.choices ?? []).flatMap((choice: any) => (choice.message?.content ?? []).map((item: any) => item.image)) : (result.data ?? []).map((item: any) => item.url);
    if (!urls.length || urls.some(url => typeof url !== "string" || !/^https?:\/\//i.test(url))) throw new Error("星算云未返回有效图片地址");
    return urls.map(url => ({ mediaType: "image", type: "url", url: url as string }));
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和提示词");
    if (/^(wan3\.0-video|MiniMax-H3|kling-4\.0)/.test(request.model)) return generateOtherVideo.call(this, request);
    // 画布 singleImage 用 images 传一张图；星算云协议将此图作为首帧。
    if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
    const model = this.models?.find(model => model.id === request.model);
    const referenceMode = Array.isArray(request.mode);
    if (referenceMode && !model?.mode?.some(mode => Array.isArray(mode) && JSON.stringify(mode) === JSON.stringify(request.mode))) throw new Error("当前模型未配置此多参考模式");
    if (!referenceMode && request.mode !== undefined && !["text", "singleImage", "endFrameOptional"].includes(String(request.mode))) throw new Error("不支持此视频模式");
    if (referenceMode && (request.firstFrame || request.lastFrame)) throw new Error("身份多参考模式不能同时指定首尾帧");
    if (request.mode === "text" && (request.firstFrame || request.lastFrame)) throw new Error("文生视频模式不能附带首尾帧");
    if ((request.mode === "singleImage" || request.mode === "endFrameOptional") && !request.firstFrame) throw new Error("请选择视频首帧");
    if (request.mode === "singleImage" && request.lastFrame) throw new Error("使用尾帧时请选择尾帧可选模式");
    if (request.videos?.length && !referenceMode) throw new Error("使用视频参考时请选择参考模式");
    if (request.audios?.length && !referenceMode) throw new Error("使用音频参考时请选择参考模式");
    if (request.images?.length && !referenceMode) throw new Error("使用身份图片时请选择模型声明的多参考模式");
    const referenceLimit = Array.isArray(request.mode) ? Number(request.mode.find(value => value.startsWith("imageReference:"))?.split(":")[1] ?? 0) : 0;
    const videoLimit = Array.isArray(request.mode) ? Number(request.mode.find(value => value.startsWith("videoReference:"))?.split(":")[1] ?? 0) : 0;
    const audioLimit = Array.isArray(request.mode) ? Number(request.mode.find(value => value.startsWith("audioReference:"))?.split(":")[1] ?? 0) : 0;
    if (referenceMode && ((!request.images?.length && !request.videos?.length && !request.audios?.length) || (request.images?.length ?? 0) > referenceLimit || (request.videos?.length ?? 0) > videoLimit || (request.audios?.length ?? 0) > audioLimit)) throw new Error("参考素材数量不符合所选模式");
    if (referenceMode && request.audios?.length && !request.images?.length && !request.videos?.length) throw new Error("音频参考须同时提供图片或视频参考");
    let audioDuration = 0;
    const isSeedance25 = /seedance[-/]2[.-]5/.test(request.model) || /Seedance 2\.5/i.test(model?.label ?? "");
    for (const input of request.audios ?? []) {
      if (input.type === "url") throw new Error("参考音频须先导入工作区，以便核验时长");
      const bytes = input.type === "binary" ? Buffer.from(input.data) : Buffer.from(input.data.replace(/^data:[^,]+,/, ""), "base64");
      if (!["audio/mpeg", "audio/wav", "audio/x-wav"].includes(input.mimeType) || !bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error("参考音频须为不超过 15 MB 的 MP3 或 WAV");
      const duration = await this.tool.audioDuration(input);
      // ACT: MP3 管道解码可能包含编码填充，容许 0.1 秒误差，最终以供应商校验为准。
      if (duration < 1.9 || duration > (isSeedance25 ? 30.1 : 15.1)) throw new Error("参考音频时长不符合 Seedance 模型要求");
      audioDuration += duration;
    }
    if (audioDuration > (isSeedance25 ? 30 : 15) + (request.audios?.length ?? 0) * 0.1) throw new Error("参考音频总时长超出 Seedance 模型限制");
    if (request.lastFrame && !request.firstFrame) throw new Error("尾帧须搭配首帧");
    const duration = request.duration ?? 5;
    // ACT: 时长与分辨率按所选模型的 durationResolutionMap 动态校验；
    // 未配置接入点能力时不猜成 30 秒；时长与分辨率必须来自同一条能力记录。
    const capability = model?.durationResolutionMap ?? [];
    if (!capability.length) throw new Error("当前模型未配置 durationResolutionMap，请先同步模型或配置接入点能力");
    const resolution = (request.resolution ?? "720P").toLowerCase();
    if (!Number.isInteger(duration) || !capability.some(row => row.duration.includes(duration) && row.resolution.some(value => value.toLowerCase() === resolution))) throw new Error("当前模型不支持此时长与分辨率组合，请按 durationResolutionMap 配置");
    // Seedance 2.x 首帧模式由输入图决定画幅。
    const channelModel = /^[kcszr]\/seedance-/.test(request.model);
    const seedance2 = /seedance-2-[05]/.test(request.model) || /Seedance 2\.[05]/i.test(model?.label ?? "");
    if (seedance2 && request.firstFrame && request.ratio) await this.tool.assertAspectRatio(request.firstFrame, request.ratio);
    const ratio = !channelModel && seedance2 && request.firstFrame ? "adaptive" : request.ratio ?? "16:9";
    if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].includes(ratio)) throw new Error("不支持此视频画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const toUrl = async (input: MediaInput) => channelModel ? this.tool.relayMedia(input) : imageUrl(input);
    const images = await Promise.all((request.images ?? []).map(toUrl));
    const audios = await Promise.all((request.audios ?? []).map(toUrl));
    const first = request.firstFrame ? await toUrl(request.firstFrame) : undefined;
    const last = request.lastFrame ? await toUrl(request.lastFrame) : undefined;
    const body = {
      model: request.model, content: [
        { type: "text", text: request.prompt },
        ...(referenceMode ? images.map(url => ({ type: "image_url", image_url: { url }, role: "reference_image" })) : []),
        ...(referenceMode ? await Promise.all((request.videos ?? []).map(async input => ({ type: "video_url", video_url: { url: await this.tool.relayMedia(input) }, role: "reference_video" }))) : []),
        ...(referenceMode ? audios.map(url => ({ type: "audio_url", audio_url: { url: url.replace(/^data:audio\/x-wav;/, "data:audio/wav;") }, role: "reference_audio" })) : []),
        ...(first ? [{ type: "image_url", image_url: { url: first }, role: "first_frame" }] : []),
        ...(last ? [{ type: "image_url", image_url: { url: last }, role: "last_frame" }] : []),
      ], duration, resolution, ratio, ...(model?.audio ? { generate_audio: request.generateAudio ?? false } : {}), watermark: request.watermark ?? false,
    };
    if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024) throw new Error("星算云请求体不能超过 64 MB，请压缩参考素材");
    const task = await fetchJson(this, "/contents/generations/tasks", signal, body);
    if (typeof task.id !== "string" || !task.id) throw new Error("星算云未返回任务 ID");
    await this.tool.reportTask?.({ id: task.id, status: "submitted", mediaType: "video" });
    return resumeMedia.call(this, { id: task.id, status: "submitted", mediaType: "video" });
  },
} satisfies ProviderDefinition<typeof rules>;
