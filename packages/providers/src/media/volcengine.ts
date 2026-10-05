const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址（方舟或兼容中转）", value: "https://ark.cn-beijing.volces.com/api/v3" },
] as const;

function imageUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: unknown) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请填写方舟 API Key");
  const baseUrl = String(context.config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("请填写方舟 API 地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`方舟请求失败（HTTP ${response.status}）`);
  const result = await response.json() as Record<string, any>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("方舟响应格式错误");
  if (result.error) throw new Error(context.tool.errorMessage(result.error) || "方舟请求失败");
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

export default {
  id: "volcengine", label: "火山方舟", version: "1.0.0", rules,
  readme: "使用火山方舟 API Key。内置 Seedream 4.5 与 Seedance 1.5 Pro，支持本地图片参考、首帧和首尾帧。API 地址可改为兼容方舟协议的中转；模型 ID 可在模型配置中替换为控制台接入点 ID。\n\n[官方文档](https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh)",
  models: [
    { id: "doubao-seedream-4-5-251128", label: "Seedream 4.5", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["2K", "4K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "doubao-seedance-1-5-pro-251215", label: "Seedance 1.5 Pro", type: "video", mode: ["text", "singleImage", "endFrameOptional"], audio: "optional", durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480P", "720P", "1080P"] }] },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和提示词");
    if (request.mask) throw new Error("方舟当前未接入蒙版编辑");
    if (request.n !== undefined && request.n !== 1) throw new Error("当前每次生成一张图片");
    const size = request.size ?? "2K";
    if (!["2K", "4K"].includes(size)) throw new Error("图片尺寸须为 2K 或 4K");
    const ratio = request.ratio ?? "1:1";
    const dimensions: Record<string, [number, number]> = { "1:1": [2048, 2048], "16:9": [2560, 1440], "9:16": [1440, 2560], "4:3": [2304, 1728], "3:4": [1728, 2304], "3:2": [2496, 1664], "2:3": [1664, 2496], "21:9": [3024, 1296] };
    const dimensionsValue = dimensions[ratio];
    if (!dimensionsValue) throw new Error("不支持此图片画幅");
    const images = (request.images ?? []).map(imageUrl);
    if (images.length > 14) throw new Error("最多使用 14 张参考图");
    const signal = AbortSignal.any([AbortSignal.timeout(6 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const result = await fetchJson(this, "/images/generations", signal, {
      model: request.model, prompt: request.prompt, size: dimensionsValue.map(value => value * (size === "4K" ? 2 : 1)).join("x"),
      response_format: "url", sequential_image_generation: "disabled", ...(images.length ? { image: images } : {}),
    });
    if (!Array.isArray(result.data) || !result.data.length) throw new Error("方舟未返回图片");
    return result.data.map((item: any): MediaAsset => {
      if (typeof item?.url !== "string" || !/^https?:\/\//i.test(item.url)) throw new Error(this.tool.errorMessage(item?.error) || "方舟未返回有效图片地址");
      return { mediaType: "image", type: "url", url: item.url };
    });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和提示词");
    if (request.mode !== undefined && !["text", "singleImage", "endFrameOptional"].includes(String(request.mode))) throw new Error("不支持此视频模式");
    if (request.mode === "text" && (request.firstFrame || request.lastFrame)) throw new Error("文生视频模式不能附带首尾帧");
    if ((request.mode === "singleImage" || request.mode === "endFrameOptional") && !request.firstFrame) throw new Error("请选择视频首帧");
    if (request.mode === "singleImage" && request.lastFrame) throw new Error("使用尾帧时请选择尾帧可选模式");
    if (request.images?.length || request.videos?.length || request.audios?.length) throw new Error("当前方舟视频仅支持文字、首帧或首尾帧");
    if (request.lastFrame && !request.firstFrame) throw new Error("尾帧须搭配首帧");
    const duration = request.duration ?? 5;
    if (!Number.isInteger(duration) || duration < 4 || duration > 12) throw new Error("视频时长须为 4–12 秒");
    const resolution = (request.resolution ?? "720P").toLowerCase();
    if (!["480p", "720p", "1080p"].includes(resolution)) throw new Error("不支持此视频分辨率");
    const ratio = request.ratio ?? "16:9";
    if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "adaptive"].includes(ratio)) throw new Error("不支持此视频画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const task = await fetchJson(this, "/contents/generations/tasks", signal, {
      model: request.model, content: [
        { type: "text", text: request.prompt },
        ...(request.firstFrame ? [{ type: "image_url", image_url: { url: imageUrl(request.firstFrame) }, role: "first_frame" }] : []),
        ...(request.lastFrame ? [{ type: "image_url", image_url: { url: imageUrl(request.lastFrame) }, role: "last_frame" }] : []),
      ], duration, resolution, ratio, generate_audio: request.generateAudio ?? false, watermark: request.watermark ?? false,
    });
    if (typeof task.id !== "string" || !task.id) throw new Error("方舟未返回任务 ID");
    while (true) {
      const result = await fetchJson(this, `/contents/generations/tasks/${encodeURIComponent(task.id)}`, signal);
      if (result.status === "succeeded") {
        const url = result.content?.video_url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("方舟未返回有效视频地址");
        return [{ mediaType: "video", type: "url", url }];
      }
      if (!["queued", "running"].includes(result.status)) throw new Error(this.tool.errorMessage(result.error) || "方舟视频任务失败或状态无效");
      await wait(signal);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
