const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
] as const;

const imageRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const videoRatios = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const videoResolutions = ["480p", "720p", "native1080p", "native4k", "1080p", "2k", "4k"];
const videoDurations = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const apiUrl = "https://www.runninghub.ai/openapi/v2";

async function post(context: ProviderContext, path: string, body: object, signal: AbortSignal) {
  const apiKey = typeof context.config.apiKey === "string" ? context.config.apiKey.trim().replace(/^Bearer\s+/i, "") : "";
  if (!apiKey) throw new Error("请填写 RunningHub API Key");
  const response = await context.tool.fetch(`${apiUrl}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`RunningHub 请求失败（HTTP ${response.status}）`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("RunningHub 响应格式错误");
  return result as Record<string, unknown>;
}

async function upload(context: ProviderContext, input: MediaInput, signal: AbortSignal) {
  if (input.type === "url") {
    const url = new URL(input.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("参考素材地址无效");
    return url.href;
  }
  const apiKey = typeof context.config.apiKey === "string" ? context.config.apiKey.trim().replace(/^Bearer\s+/i, "") : "";
  if (!apiKey) throw new Error("请填写 RunningHub API Key");
  const data = input.type === "binary" ? Buffer.from(input.data) : Buffer.from(input.data.replace(/^data:[^,]+,/, ""), "base64");
  const form = new FormData();
  const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav" } as Record<string, string>)[input.mimeType];
  if (!extension) throw new Error(`RunningHub 不支持上传此素材类型：${input.mimeType}`);
  form.append("file", new Blob([data], { type: input.mimeType }), `reference.${extension}`);
  const response = await context.tool.fetch(`${apiUrl}/media/upload/binary`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal });
  if (!response.ok) throw new Error(`RunningHub 素材上传失败（HTTP ${response.status}）`);
  const result = await response.json() as { code?: number; message?: string; data?: { download_url?: unknown } };
  if (result.code !== 200 || typeof result.data?.download_url !== "string" || !/^https?:\/\//i.test(result.data.download_url)) throw new Error(result.message || "RunningHub 未返回素材地址");
  return result.data.download_url;
}

async function pollTask(this: ProviderContext, task: MediaTask & { id: string }): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  while (true) {
    const result = await post(this, "/query", { taskId: task.id }, signal);
    const status = String(result.status ?? "");
    await this.tool.reportTask?.({ id: task.id, status });
    if (status === "SUCCESS") {
      if (!Array.isArray(result.results) || !result.results.length) throw new Error("RunningHub 未返回媒体结果");
      return result.results.map((item: unknown): MediaAsset => {
        if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).url !== "string") throw new Error("RunningHub 媒体地址无效");
        const url = (item as { url: string }).url;
        if (!/^https?:\/\//i.test(url)) throw new Error("RunningHub 媒体地址无效");
        return { type: "url", mediaType: task.mediaType === "video" ? "video" : "image", url };
      });
    }
    if (["FAILED", "FAILURE", "CANCELLED", "CANCELED"].includes(status)) throw Object.assign(new Error(typeof result.errorMessage === "string" && result.errorMessage || "RunningHub 任务失败"), { retryable: false, fallbackAllowed: false });
    if (status !== "RUNNING" && status !== "QUEUED" && status !== "PENDING") throw new Error(typeof result.errorMessage === "string" && result.errorMessage || `RunningHub 返回未知任务状态：${status}`);
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

export default {
  id: "runningHub", label: "RunningHub", version: "1.5.0", apiUrl, rules,
  readme: "支持 Nano Banana、Midjourney 文生图和参考图，以及 Seedance 2.0 文生视频、首尾帧和多模态参考视频。需使用 Enterprise-Shared API Key。[接口文档](https://www.runninghub.ai/runninghub-api-doc-en/) · [价格目录](https://www.runninghub.ai/call-api/search-api/standard-model)。价格为参考，最终费用以平台结算为准。",
  models: [
    { id: "nanoBanana2", label: "Nano Banana 2", type: "image", price: "价格依分辨率和模式而变，以 RunningHub 价格目录为准", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1"] },
    { id: "nanoBanana2Economy", label: "Nano Banana 2 · 经济", type: "image", price: "以 RunningHub 官方价格目录及结算为准", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"] },
    { id: "nanoBanana2Lite", label: "Nano Banana 2 Lite · 官方", type: "image", price: "以 RunningHub 官方价格目录及结算为准", mode: ["text", "singleImage", "multiReference"], imageSizes: ["默认"], imageRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"] },
    { id: "nanoBanana2LiteEconomy", label: "Nano Banana 2 Lite · 经济", type: "image", price: "以 RunningHub 官方价格目录及结算为准", mode: ["text", "singleImage", "multiReference"], imageSizes: ["默认"], imageRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"] },
    { id: "gptImage2", label: "GPT Image 2 · 官方", type: "image", price: "按分辨率及画质计费，详见 RunningHub 官方价格目录", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "21:9", "9:21", "16:9"] },
    { id: "midjourneyNiji7", label: "Midjourney Niji 7", type: "image", price: "参考标价 $0.09；计价口径以 RunningHub 为准（2026-11-12）", mode: ["text", "singleImage"], imageSizes: ["默认"], imageRatios: ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"] },
    { id: "midjourneyV81", label: "Midjourney V8.1", type: "image", price: "参考标价 $0.09；计价口径以 RunningHub 为准（2026-11-12）", mode: ["text", "singleImage"], imageSizes: ["默认", "HD"], imageRatios: ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"] },
    { id: "midjourneyV82", label: "Midjourney V8.2 Preview", type: "image", price: "以 RunningHub 价格目录为准", mode: ["text", "singleImage"], imageSizes: ["默认", "HD"], imageRatios: ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"] },
    { id: "viduQ3TurboText", label: "Vidu Q3 Turbo · 文生视频", type: "video", price: "参考价格 $0.03/秒；实际费用以平台结算为准", mode: ["text"], audio: "optional", videoRatios: ["4:3", "3:4", "16:9", "9:16", "1:1"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540p", "720p", "1080p"] }] },
    { id: "viduQ3TurboImage", label: "Vidu Q3 Turbo · 首帧视频", type: "video", price: "参考价格 详见 RunningHub 官方价格目录；实际费用以平台结算为准", mode: ["singleImage"], audio: "optional", videoRatios: ["4:3", "3:4", "16:9", "9:16", "1:1"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540p", "720p", "1080p"] }] },
    { id: "viduQ3TurboStartEnd", label: "Vidu Q3 Turbo · 首尾帧视频", type: "video", price: "参考价格 详见 RunningHub 官方价格目录；实际费用以平台结算为准", mode: ["startEndRequired"], audio: "optional", videoRatios: ["4:3", "3:4", "16:9", "9:16", "1:1"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540p", "720p", "1080p"] }] },
    { id: "viduQ3ProText", label: "Vidu Q3 Pro · 文生视频", type: "video", price: "参考价格 $0.05/秒；实际费用以平台结算为准", mode: ["text"], audio: "optional", videoRatios: ["4:3", "3:4", "16:9", "9:16", "1:1"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["360p", "540p", "720p", "1080p"] }] },
    { id: "viduQ3ProImage", label: "Vidu Q3 Pro · 首帧视频", type: "video", price: "参考价格 详见 RunningHub 官方价格目录；实际费用以平台结算为准", mode: ["singleImage"], audio: "optional", videoRatios: ["4:3", "3:4", "16:9", "9:16", "1:1"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["360p", "540p", "720p", "1080p", "2k"] }] },
    { id: "viduQ3ProStartEnd", label: "Vidu Q3 Pro · 首尾帧视频", type: "video", price: "参考价格 详见 RunningHub 官方价格目录；实际费用以平台结算为准", mode: ["startEndRequired"], audio: "optional", videoRatios: ["4:3", "3:4", "16:9", "9:16", "1:1"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540p", "720p", "1080p"] }] },
    { id: "viduQ3ReferenceBase", label: "Vidu Q3 · 标准参考视频", type: "video", price: "按时长及配置计费，详见 RunningHub 官方价格目录", mode: [["imageReference:7"]], audio: "optional", videoRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"], durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540p", "720p", "1080p"] }] },
    { id: "viduQ3ReferenceMix", label: "Vidu Q3 · Mix参考视频", type: "video", price: "参考价 $0.09/秒；实际费用以平台结算为准（2026-11-12）", mode: [["imageReference:7"]], audio: "optional", videoRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["720p", "1080p"] }] },
    { id: "viduQ3ReferenceAd", label: "Vidu Q3 · 广告参考视频", type: "video", price: "按时长及配置计费，详见 RunningHub 官方价格目录", mode: [["imageReference:7"]], audio: "optional", videoRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"], durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["720p", "1080p"] }] },
    { id: "viduQ3ReferenceDrama", label: "Vidu Q3 · 短剧参考视频", type: "video", price: "按时长及配置计费，详见 RunningHub 官方价格目录", mode: [["imageReference:7"]], audio: "optional", videoRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"], durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["1080p"] }] },
    { id: "seedance20", label: "Seedance 2.0", type: "video", price: "按模式、时长及分辨率计费，以 RunningHub 价格目录为准", mode: ["text", "endFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]], audio: "optional", videoRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "native1080p", "native4k", "1080p", "2k", "4k"] }] },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const midjourneyPaths: Record<string, string> = { midjourneyNiji7: "niji7", midjourneyV81: "v81", midjourneyV82: "v82" };
    if (midjourneyPaths[request.model]) {
      if (!request.prompt.trim()) throw new Error("请填写图片提示词");
      if (request.mask || request.seed !== undefined || request.quality || request.outputFormat || request.n !== undefined) throw new Error("Midjourney 当前不支持这些图片参数");
      if (request.negativePrompt) throw new Error("该模型不支持负面提示词");
      const images = request.images ?? [];
      if (images.length > 1 || images.some(input => input.type !== "url" && !["image/png", "image/jpeg", "image/webp"].includes(input.mimeType))) throw new Error("Midjourney 最多支持一张参考图片");
      const hdSupported = ["midjourneyV81", "midjourneyV82"].includes(request.model);
      const size = request.size || "默认", ratio = request.ratio || "1:1";
      if (!(hdSupported ? ["默认", "HD"] : ["默认"]).includes(size) || !["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"].includes(ratio)) throw new Error("Midjourney 不支持此尺寸或画幅");
      const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
      const imageUrl = images.length ? await upload(this, images[0]!, signal) : undefined;
      const task = await post(this, `/youchuan/text-to-image-${midjourneyPaths[request.model]}`, { prompt: request.prompt, aspectRatio: ratio, ...(hdSupported ? { hd: size === "HD" } : {}), ...(imageUrl ? { imageUrl } : {}), ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}) }, signal);
      if (typeof task.taskId !== "string" || !task.taskId) throw new Error(typeof task.errorMessage === "string" && task.errorMessage || "RunningHub 未返回任务 ID");
      await this.tool.reportTask?.({ id: task.taskId, status: "submitted", mediaType: "image", model: request.model });
      return pollTask.call(this, { id: task.taskId, status: "submitted", mediaType: "image", model: request.model });
    }
    if (request.model === "gptImage2") {
      if (!request.prompt.trim() || request.mask || request.negativePrompt || request.seed !== undefined || request.outputFormat || request.n !== undefined && request.n !== 1) throw new Error("请检查提示词；此 GPT Image 接口不支持蒙版、负面词、随机种子或批量生成");
      const images = request.images ?? [];
      const formats = ["image/jpeg", "image/png", "image/webp"];
      if (images.length > 10 || images.some(input => input.type !== "url" && !formats.includes(input.mimeType))) throw new Error("参考图片格式错误或超过 10 张");
      const quality = request.quality || "medium";
      if (!["low", "medium", "high"].includes(quality)) throw new Error("画质须为 low、medium 或 high");
      const size = request.size || "1K";
      const ratio = request.ratio || "1:1";
      const ratios = ["1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "21:9", "9:21", "16:9"];
      if (!["1K", "2K", "4K"].includes(size) || !ratios.includes(ratio)) throw new Error("GPT Image 不支持此尺寸或画幅组合");
      const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
      const imageUrls = await Promise.all(images.map(input => upload(this, input, signal)));
      const task = await post(this, `/rhart-image-g-2-official/${images.length ? "image-to-image" : "text-to-image"}`, { prompt: request.prompt, quality, resolution: size.toLowerCase(), aspectRatio: ratio, ...(images.length ? { imageUrls } : {}) }, signal);
      if (typeof task.taskId !== "string" || !task.taskId) throw new Error(typeof task.errorMessage === "string" && task.errorMessage || "RunningHub 未返回任务 ID");
      await this.tool.reportTask?.({ id: task.taskId, status: "submitted", mediaType: "image", model: request.model });
      return pollTask.call(this, { id: task.taskId, status: "submitted", mediaType: "image", model: request.model });
    }
    const variants: Record<string, { base: string; edit: string; sizes: string[]; ratios: string[]; maxImages: number; resolution: boolean }> = {
      nanoBanana2: { base: "rhart-image-n-g31-flash-official", edit: "image-to-image", sizes: ["1K", "2K", "4K"], ratios: [...imageRatios, "1:4", "4:1", "1:8", "8:1"], maxImages: 14, resolution: true },
      nanoBanana2Economy: { base: "rhart-image-n-g31-flash", edit: "image-to-image", sizes: ["1K", "2K", "4K"], ratios: [...imageRatios, "1:4", "4:1", "1:8", "8:1"], maxImages: 10, resolution: true },
      nanoBanana2Lite: { base: "rhart-image-n-g31-flash-lite-official", edit: "image-to-image", sizes: ["默认"], ratios: [...imageRatios, "1:4", "4:1", "1:8", "8:1"], maxImages: 4, resolution: false },
      nanoBanana2LiteEconomy: { base: "rhart-image-n-g31-flash-lite", edit: "image-to-image", sizes: ["默认"], ratios: [...imageRatios, "1:4", "4:1", "1:8", "8:1"], maxImages: 10, resolution: false },
    };
    const variant = variants[request.model];
    if (!variant || !request.prompt.trim()) throw new Error("请选择模型并填写图片提示词");
    if (request.mask || request.n !== undefined && request.n !== 1 || request.negativePrompt || request.seed !== undefined || request.quality || request.outputFormat) throw new Error("RunningHub 不支持这些图片参数");
    const size = request.size || variant.sizes[0]!, ratio = request.ratio || "3:4";
    if (!variant.sizes.includes(size) || !variant.ratios.includes(ratio)) throw new Error("RunningHub 不支持此图片尺寸或画幅");
    const images = request.images ?? [];
    if (images.length > variant.maxImages || images.some(input => input.type !== "url" && !["image/jpeg", "image/png"].includes(input.mimeType))) throw new Error(`最多支持 ${variant.maxImages} 张 JPG 或 PNG 参考图`);
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const imageUrls = await Promise.all(images.map(input => upload(this, input, signal)));
    const operation = images.length ? variant.edit : "text-to-image";
    const task = await post(this, `/${variant.base}/${operation}`, { prompt: request.prompt, ...(variant.resolution ? { resolution: size.toLowerCase() } : {}), aspectRatio: ratio, ...(images.length ? { imageUrls } : {}) }, signal);
    if (typeof task.taskId !== "string" || !task.taskId) throw new Error(typeof task.errorMessage === "string" && task.errorMessage || "RunningHub 未返回任务 ID");
    await this.tool.reportTask?.({ id: task.taskId, status: "submitted", mediaType: "image", model: request.model });
    return pollTask.call(this, { id: task.taskId, status: "submitted", mediaType: "image", model: request.model });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const viduReference = /^viduQ3Reference(Base|Mix|Ad|Drama)$/.exec(request.model);
    if (viduReference) {
      const kind = viduReference[1]!, images = request.images ?? [];
      if (!request.prompt.trim() || request.prompt.length > 5000) throw new Error("Vidu Q3 参考视频提示词须为 1–5000 字符");
      if (request.mode !== undefined && JSON.stringify(request.mode) !== JSON.stringify(["imageReference:7"]) || images.length < 1 || images.length > 7 || request.firstFrame || request.lastFrame || request.videos?.length || request.audios?.length || request.cameraTrajectory || request.imageAndCameraOnly || request.negativePrompt || request.seed !== undefined || request.watermark !== undefined) throw new Error("Vidu Q3 参考模式需要 1–7 张图片，不支持其他参考或参数");
      if (images.some(input => input.type !== "url" && !["image/jpeg", "image/png", "image/webp"].includes(input.mimeType))) throw new Error("参考图须为 JPG、PNG 或 WebP");
      const duration = request.duration ?? (kind === "Drama" ? 8 : 5), resolution = request.resolution || (kind === "Drama" ? "1080p" : "720p"), ratio = request.ratio || "16:9";
      const min = kind === "Mix" ? 1 : kind === "Drama" ? 2 : 3, max = kind === "Drama" ? 15 : 16;
      const resolutions = kind === "Base" ? ["540p", "720p", "1080p"] : kind === "Drama" ? ["1080p"] : ["720p", "1080p"];
      if (!Number.isInteger(duration) || duration < min || duration > max || !resolutions.includes(resolution) || !["16:9", "9:16", "4:3", "3:4", "1:1"].includes(ratio)) throw new Error("Vidu Q3 参考模式不支持此时长、分辨率或画幅");
      const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
      const imageUrls = await Promise.all(images.map(input => upload(this, input, signal)));
      const suffix = kind === "Base" ? "" : `-${kind.toLowerCase()}`;
      const task = await post(this, `/vidu/reference-to-video-q3${suffix}`, { prompt: request.prompt, imageUrls, duration, resolution, aspectRatio: ratio, audio: String(request.generateAudio ?? true) }, signal);
      if (typeof task.taskId !== "string" || !task.taskId) throw new Error(typeof task.errorMessage === "string" && task.errorMessage || "RunningHub 未返回任务 ID");
      await this.tool.reportTask?.({ id: task.taskId, status: "submitted", mediaType: "video", model: request.model });
      return pollTask.call(this, { id: task.taskId, status: "submitted", mediaType: "video", model: request.model });
    }
    const viduModel = /^viduQ3(Turbo|Pro)(Text|Image|StartEnd)$/.exec(request.model);
    if (viduModel) {
      const tier = viduModel[1]!.toLowerCase(), kind = viduModel[2]!;
      if (!request.prompt.trim()) throw new Error("请填写视频提示词");
      if (request.negativePrompt || request.seed !== undefined || request.watermark !== undefined || request.cameraTrajectory || request.imageAndCameraOnly || request.videos?.length || request.audios?.length) throw new Error("Vidu Q3 当前不支持这些视频参数");
      const firstFrame = request.firstFrame ?? (kind === "Image" && request.images?.length === 1 ? request.images[0] : undefined);
      if (request.images?.length && !(kind === "Image" && request.images.length === 1 && !request.firstFrame)) throw new Error("Vidu Q3 参考图片与模式不匹配");
      const expectedMode = kind === "Text" ? "text" : kind === "Image" ? "singleImage" : "startEndRequired";
      if (request.mode !== undefined && request.mode !== expectedMode || (kind === "Text" ? !!firstFrame || !!request.lastFrame : !firstFrame || (kind === "StartEnd") !== !!request.lastFrame)) throw new Error("Vidu Q3 需要与所选模式匹配的首尾帧");
      if ([firstFrame, request.lastFrame].some(input => input && input.type !== "url" && !["image/jpeg", "image/png"].includes(input.mimeType))) throw new Error("Vidu Q3 首尾帧须为 JPG 或 PNG");
      const duration = request.duration ?? 5, resolution = request.resolution || "720p", ratio = request.ratio || "16:9";
      const supported = tier === "pro" && kind === "Text" ? ["360p", "540p", "720p", "1080p"] : tier === "pro" && kind === "Image" ? ["360p", "540p", "720p", "1080p", "2k"] : ["540p", "720p", "1080p"];
      if (!Number.isInteger(duration) || duration < 1 || duration > 16 || !supported.includes(resolution) || !["4:3", "3:4", "16:9", "9:16", "1:1"].includes(ratio)) throw new Error("Vidu Q3 不支持此时长、分辨率或画幅");
      if (firstFrame) await this.tool.assertAspectRatio(firstFrame, ratio);
      if (request.lastFrame) await this.tool.assertAspectRatio(request.lastFrame, ratio);
      const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
      const path = kind === "Text" ? "text-to-video" : kind === "Image" ? "image-to-video" : "start-end-to-video";
      const firstUrl = firstFrame ? await upload(this, firstFrame, signal) : undefined;
      const lastUrl = request.lastFrame ? await upload(this, request.lastFrame, signal) : undefined;
      const task = await post(this, `/vidu/${path}-q3-${tier}`, { prompt: request.prompt, duration: String(duration), resolution, audio: request.generateAudio ?? true, ...(kind === "Text" ? { style: "general", aspectRatio: ratio } : kind === "Image" ? { imageUrl: firstUrl } : { firstImageUrl: firstUrl, lastImageUrl: lastUrl, movementAmplitude: "auto" }) }, signal);
      if (typeof task.taskId !== "string" || !task.taskId) throw new Error(typeof task.errorMessage === "string" && task.errorMessage || "RunningHub 未返回任务 ID");
      await this.tool.reportTask?.({ id: task.taskId, status: "submitted", mediaType: "video", model: request.model });
      return pollTask.call(this, { id: task.taskId, status: "submitted", mediaType: "video", model: request.model });
    }
    if (request.model !== "seedance20" || !request.prompt.trim()) throw new Error("请选择模型并填写视频提示词");
    if (request.negativePrompt || request.watermark !== undefined || request.cameraTrajectory || request.imageAndCameraOnly) throw new Error("当前 Seedance 2.0 接口不支持这些参数");
    const images = request.images ?? [], videos = request.videos ?? [], audios = request.audios ?? [];
    const referenceMode = Array.isArray(request.mode);
    if (referenceMode && JSON.stringify(request.mode) !== JSON.stringify(["imageReference:9", "videoReference:3", "audioReference:3"])) throw new Error("不支持此多模态参考模式");
    if (images.some(input => input.type !== "url" && !["image/jpeg", "image/png", "image/webp"].includes(input.mimeType)) || videos.some(input => input.type !== "url" && input.mimeType !== "video/mp4") || audios.some(input => input.type !== "url" && !["audio/mpeg", "audio/wav"].includes(input.mimeType))) throw new Error("参考素材格式不受支持");
    if (images.length > 9 || videos.length > 3 || audios.length > 3 || audios.length && !images.length && !videos.length) throw new Error("多模态参考最多 9 图、3 视频、3 音频；音频须搭配图片或视频");
    if (referenceMode && (!images.length && !videos.length || request.firstFrame || request.lastFrame) || !referenceMode && (images.length || videos.length || audios.length)) throw new Error("视频模式与参考素材不匹配");
    if (request.lastFrame && !request.firstFrame) throw new Error("尾帧需要同时提供首帧");
    if (request.mode === "text" && request.firstFrame || request.mode === "endFrameOptional" && !request.firstFrame) throw new Error("视频模式与首帧不匹配");
    if ([request.firstFrame, request.lastFrame].some(input => input && input.type !== "url" && !["image/jpeg", "image/png", "image/webp"].includes(input.mimeType))) throw new Error("视频首尾帧须为 JPG、PNG 或 WebP 图片");
    if (request.mode && !referenceMode && !["text", "endFrameOptional"].includes(request.mode as string)) throw new Error("不支持此视频模式");
    const resolution = request.resolution || "720p";
    const duration = request.duration ?? 5;
    const ratio = request.ratio || "16:9";
    if (!videoResolutions.includes(resolution) || !videoDurations.includes(duration) || !videoRatios.includes(ratio)) throw new Error("RunningHub 不支持此视频分辨率、时长或画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const firstFrameUrl = request.firstFrame ? await upload(this, request.firstFrame, signal) : undefined;
    const lastFrameUrl = request.lastFrame ? await upload(this, request.lastFrame, signal) : undefined;
    const imageUrls = referenceMode ? await Promise.all(images.map(input => upload(this, input, signal))) : [];
    const videoUrls = referenceMode ? await Promise.all(videos.map(input => upload(this, input, signal))) : [];
    const audioUrls = referenceMode ? await Promise.all(audios.map(input => upload(this, input, signal))) : [];
    const prompt = referenceMode ? request.prompt.replace(/(图片|视频|音频)([1-9]\d*)/g, (match, type: string, number: string) => {
      const kind = type === "图片" ? "Image" : type === "视频" ? "Video" : "Audio";
      const count = type === "图片" ? images.length : type === "视频" ? videos.length : audios.length;
      return Number(number) <= count ? `@${kind} ${number}` : match;
    }) : request.prompt;
    const path = referenceMode ? "multimodal-video" : firstFrameUrl ? "image-to-video" : "text-to-video";
    const task = await post(this, `/rhart-video/sparkvideo-2.0/${path}`, { prompt, resolution, duration: String(duration), ratio, ...(imageUrls.length ? { imageUrls } : {}), ...(videoUrls.length ? { videoUrls } : {}), ...(audioUrls.length ? { audioUrls } : {}), ...(firstFrameUrl ? { firstFrameUrl } : {}), ...(lastFrameUrl ? { lastFrameUrl } : {}), ...(request.generateAudio !== undefined ? { generateAudio: request.generateAudio } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}) }, signal);
    if (typeof task.taskId !== "string" || !task.taskId) throw new Error(typeof task.errorMessage === "string" && task.errorMessage || "RunningHub 未返回任务 ID");
    await this.tool.reportTask?.({ id: task.taskId, status: "submitted", mediaType: "video", model: request.model });
    return pollTask.call(this, { id: task.taskId, status: "submitted", mediaType: "video", model: request.model });
  },
} satisfies ProviderDefinition<typeof rules>;
