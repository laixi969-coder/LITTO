const rules = [
  { type: "input", field: "apiKey" as const, title: "TokenHub API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://tokenhub.tencentmaas.com" },
] as const;

const sizes: Record<string, string[]> = {
  "1:1": ["1024x1024", "2048x2048", "4096x4096"], "2:3": ["1024x1536", "1440x2160", "3328x4992"],
  "3:2": ["1536x1024", "2160x1440", "4992x3328"], "3:4": ["1080x1440", "1440x1920", "3584x4800"],
  "4:3": ["1440x1080", "1920x1440", "4800x3584"], "9:16": ["720x1280", "1440x2560", "2160x3840"],
  "16:9": ["1280x720", "2560x1440", "3840x2160"], "21:9": ["1512x648", "2520x1080", "5040x2160"],
};

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: object) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请填写腾讯 TokenHub API Key");
  const baseUrl = (String(context.config.baseUrl ?? "").trim() || "https://tokenhub.tencentmaas.com").replace(/\/+$/, "");
  const response = await context.tool.fetch(`${baseUrl}/v1/wand/${path}`, {
    method: body ? "POST" : "GET", signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw Object.assign(new Error(context.tool.errorMessage(result) || `腾讯 WAND 请求失败（HTTP ${response.status}）`), { status: response.status });
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
  if (task.mediaType !== "image" && task.mediaType !== "video") throw new Error("腾讯 WAND 任务类型无效");
  const kind = task.mediaType;
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  while (true) {
    const result = await fetchJson(this, `vega-${kind === "image" ? "images" : "videos"}/tasks/${encodeURIComponent(task.id)}`, signal);
    const status = String(result.status ?? "");
    await this.tool.reportTask?.({ id: task.id, status });
    if (["failed", "cancelled", "incomplete"].includes(status)) throw Object.assign(new Error(this.tool.errorMessage(result.error ?? result) || "腾讯 WAND 任务失败"), { retryable: false, fallbackAllowed: false });
    if (status === (kind === "image" ? "completed" : "succeeded")) {
      const urls = kind === "image" ? result.data?.map((item: any) => item?.url) : [result.content?.video_url];
      if (!Array.isArray(urls) || !urls.length || urls.some((url: unknown) => typeof url !== "string" || !/^https?:\/\//i.test(url))) throw new Error("腾讯 WAND 未返回有效结果地址");
      return urls.map((url: string) => ({ mediaType: kind, type: "url", url }));
    }
    if (!(kind === "image" ? ["queued", "in_progress"] : ["queued", "running"]).includes(status)) throw new Error("腾讯 WAND 任务状态无效");
    await wait(signal);
  }
}

async function submit(context: ProviderContext, kind: "image" | "video", body: object) {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  await context.tool.reportTask?.({ status: "submitting" });
  let result;
  try {
    result = await fetchJson(context, kind === "image" ? "vega-images/generations" : "vega-videos/tasks", signal, body);
  } catch (error) {
    const rejected = [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(Number((error as { status?: number }).status));
    await context.tool.reportTask?.({ status: rejected ? "rejected" : "unknown" });
    throw error;
  }
  const id = kind === "image" ? result.task_id : result.id;
  if (typeof id !== "string" || !id.trim()) throw new Error("腾讯 WAND 未返回任务 ID，请先检查任务状态，避免重复提交");
  const task = { id, status: "submitted", mediaType: kind } as const;
  await context.tool.reportTask?.(task);
  return resumeMedia.call(context, task);
}

export default {
  id: "tencentWand", label: "腾讯 WAND · TokenHub", version: "1.0.0", rules,
  readme: "使用腾讯云 TokenHub 国内站 API Key。当前接入文生图和文生视频；工作区参考素材暂不支持：腾讯接口要求公网素材地址，milimili 当前传入的是本地文件。负面提示词会合并进正文。\n\n[图片接口文档](https://intl.cloud.tencent.com/zh/document/product/1300/83859) · [视频接口文档](https://cloud.tencent.com/document/product/1823/138195)",
  models: [
    { id: "wand-vega-image-lite", label: "Vega Image Lite", type: "image", mode: ["text"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] },
    { id: "wand-vega-image-flash", label: "Vega Image Flash", type: "image", mode: ["text"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] },
    { id: "wand-vega-image-pro", label: "Vega Image Pro", type: "image", mode: ["text"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] },
    { id: "wand-vega-video-1.0-lite", label: "Vega Video 1.0 Lite", type: "video", mode: ["text"], audio: false, durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "1080P", "2K", "4K"] }] },
  ] satisfies ProviderModel[],
  resumeMedia,
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (!["wand-vega-image-lite", "wand-vega-image-flash", "wand-vega-image-pro"].includes(request.model)) throw new Error("不支持此腾讯 WAND 图片模型");
    if (request.images?.length || request.mask) throw new Error("腾讯 WAND 暂不支持工作区参考图片");
    if (request.seed !== undefined || request.quality || request.outputFormat || (request.n !== undefined && request.n !== 1)) throw new Error("腾讯 WAND 当前不支持指定种子、画质、格式或多张输出");
    const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
    if (!prompt.trim() || prompt.length > 2000) throw new Error("腾讯 WAND 图片提示词须为 1–2000 字符");
    const ratio = request.ratio ?? "1:1";
    const index = ["1K", "2K", "4K"].indexOf((request.size ?? "1K").toUpperCase());
    if (!sizes[ratio] || index < 0) throw new Error("不支持此腾讯 WAND 图片尺寸或画幅");
    return submit(this, "image", { model: request.model, prompt, size: sizes[ratio]![index] });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (request.model !== "wand-vega-video-1.0-lite") throw new Error("不支持此腾讯 WAND 视频模型");
    if (request.firstFrame || request.lastFrame || request.images?.length || request.videos?.length || request.audios?.length) throw new Error("腾讯 WAND 暂不支持工作区参考素材");
    if (request.seed !== undefined || request.cameraTrajectory || request.generateAudio || request.watermark) throw new Error("腾讯 WAND 当前不支持指定种子、相机轨迹、音频或水印");
    const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
    if (!prompt.trim()) throw new Error("请输入视频提示词");
    const duration = request.duration ?? 5;
    const resolution = (request.resolution ?? "768P").toUpperCase();
    if (!Number.isInteger(duration) || duration < 4 || duration > 15 || !["768P", "1080P", "2K", "4K"].includes(resolution)) throw new Error("腾讯 WAND 视频时长或分辨率无效");
    if (request.ratio && !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(request.ratio)) throw new Error("腾讯 WAND 视频画幅无效");
    return submit(this, "video", { model: request.model, content: [{ type: "text", text: prompt }], duration, resolution, ...(request.ratio ? { ratio: request.ratio } : {}) });
  },
} satisfies ProviderDefinition<typeof rules>;
