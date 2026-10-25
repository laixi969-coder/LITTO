const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://easyrouter.io/v1" },
] as const;

function speechModel(id: string): ProviderModel | undefined {
  if (!/^(?:gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?|tts-1(?:-hd)?|gemini-[\w.-]+-tts(?:-preview)?)$/.test(id)) return;
  return { id, label: id, type: "audio", voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map(voice => ({ title: voice, voice })) };
}

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
  // Seedance 的时长能力按版本给：2.0 单条 15 秒，2.5 单条 30 秒。此前写死 5/10 秒是适配没跟上，不是模型上限。
  const seedanceVersion = /^dreamina-seedance-(\d+)-(\d+)(-fast)?$/.exec(id);
  if (seedanceVersion) {
    const major = Number(seedanceVersion[1]);
    const minor = Number(seedanceVersion[2]);
    const max = major >= 3 || (major === 2 && minor >= 5) ? 30 : major === 2 ? 15 : 10;
    const duration = [5, 10, 15, 20, 25, 30].filter(value => value <= max);
    return { id, label: id, type: "video", mode: ["text", "singleImage"], audio: "optional",
      durationResolutionMap: [{ duration, resolution: ["480P", "720P", "1080P"] }] };
  }
  if (!/^PixVerse\/(c1|v6|v5\.6|v5\.5|v5|v4\.5|v4|v3\.5)$/.test(id)) return;
  const continuous = ["PixVerse/c1", "PixVerse/v6"].includes(id);
  const audio = continuous || ["PixVerse/v5.6", "PixVerse/v5.5"].includes(id);
  return { id, label: id, type: "video", mode: ["text", "singleImage"], audio: audio ? "optional" : false,
    durationResolutionMap: continuous ? [{ duration: Array.from({ length: 15 }, (_, index) => index + 1), resolution: ["720P", "1080P"] }]
      : [{ duration: audio ? [5, 8, 10] : [5, 8], resolution: ["720P"] }, { duration: [5], resolution: ["1080P"] }],
  };
}

async function resumeMedia(this: ProviderContext, task: MediaTask & { id: string }): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  const id = task.id;
  const path = task.operation;
  if (path !== "/video/generations" && path !== "/videos") throw new Error("缺少原视频任务查询路径，不能重新提交");
  const seedance = path === "/video/generations";
  while (true) {
    const response = await fetchJson(this, `${path}/${encodeURIComponent(id)}`, signal);
    const result = seedance ? response.data : response;
    const status = String(result?.status ?? "").toLowerCase();
    await this.tool.reportTask?.({ id: task.id, status: String(status ?? "unknown") });
    if (["failed", "failure", "cancelled", "canceled", "rejected", "error"].includes(String(status).toLowerCase())) {
      await this.tool.reportTask?.({ id: task.id, status: "failed" });
      throw Object.assign(new Error(this.tool.errorMessage(result) || "供应商原任务失败"), { retryable: false, fallbackAllowed: false });
    }
    if (["success", "completed"].includes(status)) {
      const content = await fetchResponse(this, `/videos/${encodeURIComponent(id)}/content`, signal);
      return [{ mediaType: "video", type: "binary", data: await readBytes(content, 100 * 1024 * 1024), mimeType: "video/mp4" }];
    }
    if (!["submitted", "queued", "in_progress"].includes(status)) throw new Error(this.tool.errorMessage(result) || "EasyRouter 任务失败或状态无效");
    await wait(signal);
  }
}

export default {
  resumeMedia,
  id: "easyRouter", label: "EasyRouter", version: "1.2.2", rules,
  readme: "图片、视频和独立配音共用 API Key，可同步目录并选择已适配模型。配音支持 GPT TTS 与 Gemini TTS，使用 /audio/speech 返回音频流；Gemini 保留原生 WAV 和默认语速。支持平台音色 ID，不支持此接口未定义的克隆参考和表演指令。视频自动轮询并通过带认证的内容接口下载。\n\n[配音文档](https://docs.easyrouter.io/en/docs/api/ai-model/audio/speech)",
  models: [
    { id: "gpt-4o-mini-tts", label: "GPT-4o Mini TTS · 配音", type: "audio", voices: [{ title: "Alloy", voice: "alloy" }, { title: "Nova", voice: "nova" }] },
    { id: "gpt-image-2", label: "GPT Image 2", type: "image", mode: ["text", "singleImage"], imageSizes: ["1K"], imageRatios: ["1:1", "3:2", "2:3"] },
    { id: "PixVerse/v6", label: "PixVerse V6", type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720P", "1080P"] }] },
    { id: "dreamina-seedance-2-0", label: "Seedance 2.0", type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["480P", "720P", "1080P"] }] },
    { id: "dreamina-seedance-2-0-fast", label: "Seedance 2.0 Fast", type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["480P", "720P", "1080P"] }] },
  ] satisfies ProviderModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const result = await fetchJson(this, "/models", this.signal ?? AbortSignal.timeout(30000));
    if (!Array.isArray(result.data)) throw new Error("EasyRouter 模型目录格式错误");
    const models = new Map<string, ProviderModel>();
    for (const item of result.data) {
      if (typeof item?.id !== "string" || (modelIds && !modelIds.includes(item.id))) continue;
      const model: ProviderModel | undefined = item.id === "gpt-image-2" ? { id: item.id, label: "GPT Image 2", type: "image", mode: ["text", "singleImage"], imageSizes: ["1K"], imageRatios: ["1:1", "3:2", "2:3"] } : speechModel(item.id) ?? videoModel(item.id);
      if (model) models.set(item.id, { ...model, label: item.display_name || item.displayName || model.label });
    }
    return [...models.values()];
  },
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    if (Object.keys(request.audioParameters ?? {}).length) throw new Error("EasyRouter 语音不支持额外音频参数");
    if (!speechModel(request.model)) throw new Error("此模型尚未适配 EasyRouter 语音协议");
    if (!request.text.trim()) throw new Error("请填写配音文本");
    if (request.audios?.length || request.instructions || request.sampleRate !== undefined || (request.volume !== undefined && request.volume !== 0)) throw new Error("此语音接口不支持参考音频、表演指令、指定采样率或音量增益");
    if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0.25 || request.speed > 4)) throw new Error("语速须为 0.25–4");
    const gemini = request.model.startsWith("gemini-");
    if (gemini && (request.speed !== undefined && request.speed !== 1 || request.format !== undefined && request.format !== "wav")) throw new Error("Gemini TTS 使用原生 WAV 与默认语速，不支持在此接口调整格式或语速");
    const formats: Record<string, string> = { mp3: "audio/mpeg", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", pcm: "audio/pcm" };
    const format = request.format ?? (gemini ? "wav" : "mp3");
    if (!formats[format]) throw new Error("不支持此音频格式");
    const signal = AbortSignal.any([AbortSignal.timeout(180000), ...(this.signal ? [this.signal] : [])]);
    const response = await fetchResponse(this, "/audio/speech", signal, JSON.stringify({ model: request.model, input: request.text, voice: request.voice || "alloy", ...(!gemini ? { response_format: format, speed: request.speed ?? 1 } : {}) }));
    const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mimeType?.startsWith("audio/")) throw new Error("EasyRouter 未返回音频流");
    const data = await readBytes(response, 100 * 1024 * 1024);
    if (!data.length) throw new Error("EasyRouter 返回空音频");
    return [{ mediaType: "audio", type: "binary", data, mimeType }];
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
    const seedance = /^dreamina-seedance-\d+-\d+(-fast)?$/.test(request.model);
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
    if (!seedance && request.firstFrame && request.ratio) await this.tool.assertAspectRatio(request.firstFrame, request.ratio);
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
    await this.tool.reportTask?.({ id, status: "submitted", mediaType: "video", operation: path });
    return resumeMedia.call(this, { id, status: "submitted", mediaType: "video", operation: path });
  },
} satisfies ProviderDefinition<typeof rules>;
