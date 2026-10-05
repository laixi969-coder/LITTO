const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址（百炼工作空间或兼容中转）", value: "", props: { placeholder: "https://你的工作空间.cn-beijing.maas.aliyuncs.com/api/v1" } },
] as const;

function imageUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: unknown, asyncTask = false) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请填写百炼 API Key");
  const baseUrl = String(context.config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("请填写百炼工作空间 API 地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(asyncTask ? { "X-DashScope-Async": "enable" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`百炼请求失败（HTTP ${response.status}）`);
  const result = await response.json() as Record<string, any>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("百炼响应格式错误");
  if (result.code) throw new Error(context.tool.errorMessage(result) || "百炼请求失败");
  return result;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 15000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default {
  id: "bailian", label: "阿里百炼", version: "1.0.0", rules,
  readme: "内置 Qwen Image 2.0 Pro、万相 2.6 文生视频及首帧视频。请填写对应地域的 API Key 和工作空间 API 地址，地址以 /api/v1 结尾；兼容百炼协议的中转也可使用。图片参考和视频首帧直接传本地图片。\n\n[图片文档](https://help.aliyun.com/zh/model-studio/qwen-image-api) · [视频文档](https://help.aliyun.com/en/model-studio/legacy-image-to-video-api-reference/)",
  models: [
    { id: "qwen-image-2.0-pro", label: "Qwen Image 2.0 Pro", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] },
    { id: "wan2.6-t2v", label: "万相 2.6 文生视频", type: "video", mode: ["text"], audio: true, durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["720P", "1080P"] }] },
    { id: "wan2.6-i2v-flash", label: "万相 2.6 Flash 首帧视频", type: "video", mode: ["singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["720P", "1080P"] }] },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和提示词");
    if (request.mask) throw new Error("当前未接入蒙版编辑");
    const n = request.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error("图片数量须为 1–6");
    const size = request.size ?? "1K";
    if (!["1K", "2K"].includes(size)) throw new Error("图片尺寸须为 1K 或 2K");
    const ratio = request.ratio ?? "1:1";
    const values = /^(1:1|16:9|9:16|4:3|3:4|3:2|2:3)$/.test(ratio) ? ratio.split(":").map(Number) : [];
    if (!values.length) throw new Error("不支持此图片画幅");
    const pixels = size === "2K" ? 2048 * 2048 : 1024 * 1024;
    const width = Math.floor(Math.sqrt(pixels * values[0]! / values[1]!) / 16) * 16;
    const height = Math.floor(Math.sqrt(pixels * values[1]! / values[0]!) / 16) * 16;
    const images = (request.images ?? []).map(imageUrl);
    if (images.length > 3) throw new Error("最多使用 3 张参考图");
    const signal = AbortSignal.any([AbortSignal.timeout(6 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const result = await fetchJson(this, "/services/aigc/multimodal-generation/generation", signal, {
      model: request.model, input: { messages: [{ role: "user", content: [...images.map(image => ({ image })), { text: request.prompt }] }] },
      parameters: { size: `${width}*${height}`, n, watermark: false },
    });
    const content = result.output?.choices?.[0]?.message?.content;
    const urls = Array.isArray(content) ? content.filter((item: any) => typeof item?.image === "string" && /^https?:\/\//i.test(item.image)) : [];
    if (!urls.length) throw new Error("百炼未返回有效图片地址");
    return urls.map((item: any): MediaAsset => ({ mediaType: "image", type: "url", url: item.image }));
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和提示词");
    if (request.mode !== undefined && !["text", "singleImage"].includes(String(request.mode))) throw new Error("不支持此视频模式");
    if (request.mode === "text" && request.firstFrame) throw new Error("文生视频模式不能附带首帧");
    if (request.lastFrame || request.images?.length || request.videos?.length || request.audios?.length) throw new Error("当前万相仅接通文生视频或首帧视频");
    const imageMode = request.mode === "singleImage" || !!request.firstFrame;
    if (imageMode && !request.firstFrame) throw new Error("请选择视频首帧");
    if (request.model === "wan2.6-t2v" && imageMode) throw new Error("文生视频模型不支持首帧，请选择万相首帧视频");
    if (request.model === "wan2.6-i2v-flash" && !imageMode) throw new Error("万相首帧视频需要首帧图片");
    const duration = request.duration ?? 5;
    if (![5, 10, 15].includes(duration)) throw new Error("视频时长须为 5、10 或 15 秒");
    const resolution = (request.resolution ?? "720P").toUpperCase();
    if (!["720P", "1080P"].includes(resolution)) throw new Error("不支持此视频分辨率");
    const dimensions: Record<string, string[]> = { "16:9": ["1280*720", "1920*1080"], "9:16": ["720*1280", "1080*1920"], "1:1": ["960*960", "1440*1440"], "4:3": ["1088*832", "1632*1248"], "3:4": ["832*1088", "1248*1632"] };
    const ratio = request.ratio ?? "16:9";
    if (!dimensions[ratio]) throw new Error("不支持此视频画幅");
    if (!imageMode && request.generateAudio === false) throw new Error("万相 2.6 文生视频会自动生成音频");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const task = await fetchJson(this, "/services/aigc/video-generation/video-synthesis", signal, {
      model: request.model, input: { prompt: request.prompt, ...(request.firstFrame ? { img_url: imageUrl(request.firstFrame) } : {}) },
      parameters: { duration, watermark: request.watermark ?? false, ...(imageMode ? { resolution, audio: request.generateAudio ?? false } : { size: dimensions[ratio]![resolution === "1080P" ? 1 : 0] }) },
    }, true);
    const taskId = task.output?.task_id;
    if (typeof taskId !== "string" || !taskId) throw new Error("百炼未返回任务 ID");
    while (true) {
      const result = await fetchJson(this, `/tasks/${encodeURIComponent(taskId)}`, signal);
      const output = result.output;
      if (output?.task_status === "SUCCEEDED") {
        if (typeof output.video_url !== "string" || !/^https?:\/\//i.test(output.video_url)) throw new Error("百炼未返回有效视频地址");
        return [{ mediaType: "video", type: "url", url: output.video_url }];
      }
      if (!["PENDING", "RUNNING"].includes(output?.task_status)) throw new Error(this.tool.errorMessage(output) || "百炼视频任务失败或状态无效");
      await wait(signal);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
