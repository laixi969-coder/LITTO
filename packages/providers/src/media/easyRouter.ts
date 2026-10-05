const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://easyrouter.io/v1" },
] as const;

function mediaUrl(input: MediaInput) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考图须使用 HTTP 地址");
    return input.url;
  }
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

async function fetchResponse(context: ProviderContext, path: string, signal: AbortSignal, body?: string | FormData) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  const baseUrl = String(context.config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!key || !baseUrl) throw new Error("请填写 EasyRouter API Key 和地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", signal, body,
    headers: { Authorization: `Bearer ${key}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) throw new Error(`EasyRouter 请求失败（HTTP ${response.status}）`);
  return response;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: string | FormData) {
  const result = await (await fetchResponse(context, path, signal, body)).json() as Record<string, any>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("EasyRouter 响应格式错误");
  if (result.error || (result.code !== undefined && result.code !== "success" && result.code !== 200)) throw new Error(context.tool.errorMessage(result) || "EasyRouter 请求失败");
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

async function readBytes(response: Response, maxBytes: number) {
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new Error("媒体文件超过大小限制"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("媒体文件为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("媒体文件超过大小限制");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  if (!size) throw new Error("媒体文件为空");
  return Buffer.concat(chunks, size);
}

function videoModel(id: string): ProviderModel | undefined {
  if (["dreamina-seedance-2-0", "dreamina-seedance-2-0-fast"].includes(id)) return { id, label: id, type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10], resolution: ["480P", "720P", "1080P"] }] };
  if (!/^PixVerse\/(c1|v6|v5\.6|v5\.5|v5|v4\.5|v4|v3\.5)$/.test(id)) return;
  const continuous = ["PixVerse/c1", "PixVerse/v6"].includes(id);
  const audio = continuous || ["PixVerse/v5.6", "PixVerse/v5.5"].includes(id);
  return { id, label: id, type: "video", mode: ["text", "singleImage"], audio: audio ? "optional" : false,
    durationResolutionMap: continuous ? [{ duration: Array.from({ length: 15 }, (_, index) => index + 1), resolution: ["720P", "1080P"] }]
      : [{ duration: audio ? [5, 8, 10] : [5, 8], resolution: ["720P"] }, { duration: [5], resolution: ["1080P"] }],
  };
}

export default {
  id: "easyRouter", label: "EasyRouter", version: "1.1.0", rules,
  readme: "EasyRouter 图片与视频共用 API Key。内置 GPT Image 2 文生图/单图编辑、PixVerse V6 和 Seedance 2.0 视频，支持本地视频首帧。视频自动轮询并通过带认证的内容接口下载。\n\n[官方文档](https://docs.easyrouter.io/zh/docs/api)",
  models: [
    { id: "gpt-image-2", label: "GPT Image 2", type: "image", mode: ["text", "singleImage"], imageSizes: ["1K"], imageRatios: ["1:1", "3:2", "2:3"] },
    { id: "PixVerse/v6", label: "PixVerse V6", type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720P", "1080P"] }] },
    { id: "dreamina-seedance-2-0", label: "Seedance 2.0", type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10], resolution: ["480P", "720P", "1080P"] }] },
    { id: "dreamina-seedance-2-0-fast", label: "Seedance 2.0 Fast", type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10], resolution: ["480P", "720P", "1080P"] }] },
  ] satisfies ProviderModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const result = await fetchJson(this, "/models", this.signal ?? AbortSignal.timeout(30000));
    if (!Array.isArray(result.data)) throw new Error("EasyRouter 模型目录格式错误");
    const models = new Map<string, ProviderModel>();
    for (const item of result.data) {
      if (typeof item?.id !== "string" || (modelIds && !modelIds.includes(item.id))) continue;
      const model: ProviderModel | undefined = item.id === "gpt-image-2" ? { id: item.id, label: "GPT Image 2", type: "image", mode: ["text", "singleImage"], imageSizes: ["1K"], imageRatios: ["1:1", "3:2", "2:3"] } : videoModel(item.id);
      if (model) models.set(item.id, { ...model, label: item.display_name || item.displayName || model.label });
    }
    return [...models.values()];
  },
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (request.model !== "gpt-image-2") throw new Error("当前 EasyRouter 图片适配支持 GPT Image 2");
    if (!request.prompt.trim()) throw new Error("请填写提示词");
    if (request.mask || (request.n !== undefined && request.n !== 1) || (request.images?.length ?? 0) > 1) throw new Error("当前每次生成一张图片，支持单图编辑，不支持蒙版");
    if (request.size && request.size !== "1K") throw new Error("当前图片尺寸档位为 1K");
    const dimensions: Record<string, string> = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
    const size = dimensions[request.ratio || "1:1"];
    if (!size) throw new Error("不支持此图片画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const image = request.images?.[0];
    let body: string | FormData = JSON.stringify({ model: request.model, prompt: request.prompt, n: 1, size });
    if (image) {
      let bytes: Uint8Array;
      let mimeType: string;
      if (image.type === "url") {
        const response = await this.tool.fetch(mediaUrl(image), { signal });
        if (!response.ok) throw new Error(`读取参考图失败（HTTP ${response.status}）`);
        bytes = await readBytes(response, 4 * 1024 * 1024);
        mimeType = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
      } else {
        bytes = image.type === "binary" ? image.data : Buffer.from(image.data.replace(/^data:[^,]+,/, ""), "base64");
        mimeType = image.mimeType;
      }
      if (mimeType !== "image/png" || !bytes.byteLength || bytes.byteLength > 4 * 1024 * 1024) throw new Error("EasyRouter 图像编辑参考图须为不超过 4 MB 的 PNG");
      const form = new FormData();
      form.append("model", request.model); form.append("prompt", request.prompt); form.append("n", "1"); form.append("size", size);
      form.append("image", new Blob([new Uint8Array(bytes)], { type: mimeType }), "image.png");
      body = form;
    }
    const result = await fetchJson(this, image ? "/images/edits" : "/images/generations", signal, body);
    if (!Array.isArray(result.data) || !result.data.length) throw new Error("EasyRouter 未返回图片");
    return result.data.map((item: any): MediaAsset => {
      if (typeof item?.url === "string" && /^https?:\/\//i.test(item.url)) return { mediaType: "image", type: "url", url: item.url };
      if (typeof item?.b64_json === "string" && item.b64_json) return { mediaType: "image", type: "base64", data: item.b64_json, mimeType: "image/png" };
      throw new Error("EasyRouter 未返回有效图片");
    });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const seedance = ["dreamina-seedance-2-0", "dreamina-seedance-2-0-fast"].includes(request.model);
    const model = videoModel(request.model);
    if (!model) throw new Error("此 EasyRouter 视频模型尚未适配");
    if (!request.prompt.trim()) throw new Error("请填写提示词");
    if (request.lastFrame || request.images?.length || request.videos?.length || request.audios?.length) throw new Error("当前 EasyRouter 视频仅支持文字或首帧");
    if (request.mode !== undefined && !["text", "singleImage"].includes(String(request.mode))) throw new Error("不支持此视频模式");
    if ((request.mode === "text" && request.firstFrame) || (request.mode === "singleImage" && !request.firstFrame)) throw new Error("视频模式与首帧不匹配");
    const duration = request.duration ?? 5;

    const resolution = (request.resolution || "720P").toLowerCase();
    if (!model.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution.toUpperCase()))) throw new Error("不支持此视频时长与分辨率组合");
    if (request.generateAudio && !model.audio) throw new Error("此模型不支持生成音频");
    const ratio = request.ratio || "16:9";
    if (!(seedance ? ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] : ["16:9", "9:16", "1:1", "4:3", "3:4", "2:3", "3:2", "21:9"]).includes(ratio)) throw new Error("不支持此视频画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const path = seedance ? "/video/generations" : "/videos";
    const task = await fetchJson(this, path, signal, JSON.stringify({
      model: request.model, prompt: request.prompt, duration,
      ...(request.firstFrame ? { image: mediaUrl(request.firstFrame) } : {}),
      ...(seedance ? { metadata: { resolution, ratio, generate_audio: request.generateAudio ?? false, watermark: request.watermark ?? false } }
        : { resolution: resolution.toUpperCase(), metadata: { ...(!request.firstFrame ? { aspect_ratio: ratio } : {}), generate_audio_switch: request.generateAudio ?? false, water_mark: request.watermark ?? false } }),
    }));
    const id = task.task_id ?? task.id;
    if (typeof id !== "string" || !id) throw new Error("EasyRouter 未返回任务 ID");
    while (true) {
      const response = await fetchJson(this, `${path}/${encodeURIComponent(id)}`, signal);
      const result = seedance ? response.data : response;
      const status = String(result?.status ?? "").toLowerCase();
      if (["success", "completed"].includes(status)) {
        const content = await fetchResponse(this, `/videos/${encodeURIComponent(id)}/content`, signal);
        return [{ mediaType: "video", type: "binary", data: await readBytes(content, 100 * 1024 * 1024), mimeType: "video/mp4" }];
      }
      if (!["submitted", "queued", "in_progress"].includes(status)) throw new Error(this.tool.errorMessage(result) || "EasyRouter 任务失败或状态无效");
      await wait(signal);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
