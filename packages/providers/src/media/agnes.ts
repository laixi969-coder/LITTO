const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const apiUrl = "https://apihub.agnes-ai.com/v1";

async function fetchJson(context: ProviderContext, url: string, body?: unknown, signal = context.signal) {
  const apiKey = typeof context.config.apiKey === "string" ? context.config.apiKey.trim().replace(/^Bearer\s+/i, "").trim() : "";
  if (!apiKey) throw new Error("请填写 Agnes API Key");
  signal?.throwIfAborted();
  const response = await context.tool.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Agnes 请求失败（HTTP ${response.status}）`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Agnes 响应格式错误");
  return result as Record<string, unknown>;
}

function imageUrl(input: MediaInput) {
  if (input.type === "url") {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("参考图片须使用 HTTP 或 HTTPS 地址");
    return url.href;
  }
  if (!input.mimeType.startsWith("image/")) throw new Error("参考图片类型无效");
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default {
  id: "agnes",
  label: "Agnes AI",
  version: "1.0.0",
  apiUrl,
  readme: "使用同一个 Agnes API Key 生成图片和视频。Image 2.5 Flash 支持文字生成、本地参考图编辑及多图合成，尺寸为 1K–4K；Video 2.5 Flash 当前提供 720P、4–12 秒的文生视频。Agnes 视频参考需要公网素材地址，本地首尾帧及参考素材上传尚未接通。\n\n[获取 Key](https://apihub.agnes-ai.com/) · [图片文档](https://www.agnes-ai.com/zh-Hans/docs/agnes-image-25-flash) · [视频文档](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash)",
  rules,
  models: [
    {
      id: "agnes-image-2.5-flash",
      label: "Agnes Image 2.5 Flash",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "3K", "4K"],
      imageRatios: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
    },
    {
      id: "agnes-video-2.5-flash",
      label: "Agnes Video 2.5 Flash",
      type: "video",
      // ACT: 工作区参考以本地字节传入，视频 API 仅接受公网 URL；接通上传接口后再开放参考与首尾帧模式。
      mode: ["text"],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["720P"] }],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (request.model !== "agnes-image-2.5-flash") throw new Error("请选择 Agnes Image 2.5 Flash");
    if (!request.prompt.trim()) throw new Error("请输入图片提示词");
    if (request.n !== undefined && request.n !== 1) throw new Error("Agnes 图片每次生成一张");
    const size = request.size || "1K";
    if (!["1K", "2K", "3K", "4K"].includes(size)) throw new Error("Agnes 图片尺寸须为 1K、2K、3K 或 4K");
    const ratio = request.ratio ?? "1:1";
    if (!["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"].includes(ratio)) throw new Error("Agnes 不支持此图片画幅");
    if (request.mask) throw new Error("Agnes 当前未接入蒙版编辑");
    const images = (request.images ?? []).map(imageUrl);
    const signal = AbortSignal.any([AbortSignal.timeout(6 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const result = await fetchJson(this, `${apiUrl}/images/generations`, {
      model: request.model, prompt: request.prompt, size, ratio,
      extra_body: { response_format: "url", ...(images.length ? { image: images } : {}) },
    }, signal);
    if (!Array.isArray(result.data) || !result.data.length) throw new Error("Agnes 未返回图片结果");
    return result.data.map((item: unknown): MediaAsset => {
      if (!item || typeof item !== "object") throw new Error("Agnes 图片结果格式错误");
      const output = item as Record<string, unknown>;
      if (typeof output.url === "string" && /^https?:\/\//i.test(output.url)) return { mediaType: "image", type: "url", url: output.url };
      if (typeof output.b64_json === "string" && output.b64_json.trim()) return { mediaType: "image", type: "base64", mimeType: "image/png", data: output.b64_json };
      throw new Error("Agnes 未返回有效的图片地址或 Base64");
    });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (request.model !== "agnes-video-2.5-flash") throw new Error("请选择 Agnes Video 2.5 Flash");
    if (!request.prompt.trim()) throw new Error("请输入视频提示词");
    if ((request.mode !== undefined && request.mode !== "text") || request.firstFrame || request.lastFrame || request.images?.length || request.audios?.length || request.videos?.length) {
      throw new Error("Agnes 当前仅接通文生视频；本地首尾帧和参考素材需要先接通公网上传");
    }
    const duration = request.duration ?? 5;
    if (!Number.isInteger(duration) || duration < 4 || duration > 12) throw new Error("Agnes 视频时长须为 4–12 秒的整数");
    if (request.resolution && request.resolution.toUpperCase() !== "720P") throw new Error("Agnes Video Flash 仅支持 720P");
    const ratio = request.ratio ?? "16:9";
    if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error("Agnes 不支持此视频画幅");
    if (request.generateAudio !== undefined || request.watermark !== undefined) throw new Error("Agnes 当前未提供音频或水印开关");
    // ACT: 单次最多等待 30 分钟；沿用宿主的停止信号，不重复提交生成任务。
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const task = await fetchJson(this, `${apiUrl}/videos`, {
      model: request.model, prompt: request.prompt, mode: "text", seconds: String(duration), size: "720P", aspect_ratio: ratio, n: 1,
    }, signal);
    if (typeof task.video_id !== "string" || !task.video_id.trim()) throw new Error("Agnes 未返回 video_id");
    const query = new URL("https://apihub.agnes-ai.com/agnesapi");
    query.searchParams.set("video_id", task.video_id);
    query.searchParams.set("model_name", request.model);
    while (true) {
      const result = await fetchJson(this, query.href, undefined, signal);
      if (result.status === "completed") {
        if (typeof result.url !== "string" || !/^https?:\/\//i.test(result.url)) throw new Error("Agnes 未返回有效的视频地址");
        return [{ mediaType: "video", type: "url", url: result.url }];
      }
      if (result.status === "failed") throw new Error(this.tool.errorMessage(result) || "Agnes 视频生成失败");
      if (result.status !== "queued" && result.status !== "in_progress") throw new Error("Agnes 返回了未知的视频任务状态");
      await wait(signal);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
