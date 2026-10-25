const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址（百炼工作空间或兼容中转）", value: "", props: { placeholder: "https://你的工作空间.cn-beijing.maas.aliyuncs.com/api/v1" } },
  { type: "input", field: "qwenTtsBaseUrl" as const, title: "Qwen-TTS 地址（独立 DashScope 端点）", value: "https://dashscope.aliyuncs.com/api/v1", props: { placeholder: "请使用与 API Key 同地域的 DashScope 地址" } },
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
  if (result.code && result.code !== 200 && result.code !== "200") throw new Error(context.tool.errorMessage(result) || "百炼请求失败");
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

async function resumeMedia(this: ProviderContext, task: MediaTask & { id: string }): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  const taskId = task.id;
  while (true) {
    const result = await fetchJson(this, `/tasks/${encodeURIComponent(taskId)}`, signal);
    const output = result.output;
    await this.tool.reportTask?.({ id: task.id, status: String(output?.task_status ?? "unknown") });
    if (["failed", "failure", "cancelled", "canceled", "rejected", "error"].includes(String(output?.task_status).toLowerCase())) {
      await this.tool.reportTask?.({ id: task.id, status: "failed" });
      throw Object.assign(new Error(this.tool.errorMessage(result) || "供应商原任务失败"), { retryable: false, fallbackAllowed: false });
    }
    if (output?.task_status === "SUCCEEDED") {
      if (typeof output.video_url !== "string" || !/^https?:\/\//i.test(output.video_url)) throw new Error("百炼未返回有效视频地址");
      return [{ mediaType: "video", type: "url", url: output.video_url }];
    }
    if (!["PENDING", "RUNNING"].includes(output?.task_status)) throw new Error(this.tool.errorMessage(output) || "百炼视频任务失败或状态无效");
    await wait(signal);
  }
}

export default {
  resumeMedia,
  id: "bailian", label: "阿里百炼", version: "1.1.2", rules,
  readme: "支持分页同步工作空间模型目录，接入已适配的图片、视频及 Qwen-Audio-TTS、CosyVoice、Qwen-TTS 非实时配音。请填写同地域 API Key 和以 /api/v1 结尾的工作空间地址。Qwen-TTS 使用单独的 DashScope 地址，请在 qwenTtsBaseUrl 配置同地域端点；不将工作空间端点与其混用。CosyVoice 3.5 需要已创建的复刻或设计音色 ID。目录存在不代表账户已开通权限。\n\n[模型目录](https://help.aliyun.com/zh/model-studio/list-models) · [语音文档](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)",
  models: [
    { id: "qwen-audio-3.1-tts-flash", label: "Qwen Audio 3.1 TTS Flash · 配音", type: "audio", speechInstructions: true, voices: [{ title: "龙安欢", voice: "longanhuan_v3.1" }] },
    { id: "cosyvoice-v3.5-plus", label: "CosyVoice 3.5 Plus · 配音", type: "audio", speechInstructions: true },
    { id: "MiniMax/speech-2.8-hd", label: "MiniMax Speech 2.8 HD · 配音", type: "audio", voices: [{ title: "青涩男声", voice: "male-qn-qingse" }] },
    { id: "qwen3-tts-flash", label: "Qwen3 TTS Flash · 配音", type: "audio", voices: [{ title: "Cherry", voice: "Cherry" }, { title: "Serena", voice: "Serena" }, { title: "Ethan", voice: "Ethan" }] },
    { id: "qwen3-tts-instruct-flash", label: "Qwen3 TTS Instruct · 表演配音", type: "audio", speechInstructions: true, voices: [{ title: "Cherry", voice: "Cherry" }] },
    { id: "qwen-image-2.0-pro", label: "Qwen Image 2.0 Pro", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] },
    { id: "wan2.6-t2v", label: "万相 2.6 文生视频", type: "video", mode: ["text"], audio: true, durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["720P", "1080P"] }] },
    { id: "wan2.6-i2v-flash", label: "万相 2.6 Flash 首帧视频", type: "video", mode: ["singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["720P", "1080P"] }] },
  ] satisfies ProviderModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const signal = this.signal ?? AbortSignal.timeout(60000);
    const models = new Map<string, ProviderModel>();
    // ACT: 官方工作空间目录分页；只映射已实现的协议家族，不把 ASR 或实时会话当音频文件生成。
    for (let page = 1; page <= 100; page++) {
      const result = await fetchJson(this, `/models?page_no=${page}&page_size=100`, signal);
      const items = result.output?.models ?? result.data;
      if (!Array.isArray(items)) throw new Error("百炼模型目录格式错误");
      for (const item of items) {
        const id = item.model ?? item.id;
        if (typeof id !== "string" || modelIds && !modelIds.includes(id)) continue;
        const known = this.models?.find(model => model.id === id);
        let model: ProviderModel | undefined = known;
        if (/^(?:qwen-audio-[\d.]+-tts-(?:flash|plus)|cosyvoice-v[\d.]+(?:-(?:plus|flash))?)(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) model = { ...known, id, label: id, type: "audio", speechInstructions: true };
        const template = this.models?.find(model => /^qwen-image-2\.0/.test(id) ? model.id === "qwen-image-2.0-pro" : /^wan2\.6-t2v/.test(id) ? model.id === "wan2.6-t2v" : /^wan2\.6-i2v-flash/.test(id) && model.id === "wan2.6-i2v-flash");
        if (!model && template) model = { ...template, id, label: id };
        if (/^qwen(?:3)?-tts(?:-instruct)?-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id) || /^qwen-tts(?:-latest|-\d{4}-\d{2}-\d{2})?$/.test(id)) model = { id, label: id, type: "audio", speechInstructions: id.includes("instruct"), voices: [{ title: "Cherry", voice: "Cherry" }, { title: "Serena", voice: "Serena" }, { title: "Ethan", voice: "Ethan" }] };
        if (/^MiniMax\/speech-[\d.]+-(?:hd|turbo)$/.test(id)) model = { ...known, id, label: id, type: "audio", speechInstructions: false };
        if (model) models.set(id, { ...model, label: item.name || item.display_name || model.label });
      }
      const total = result.output?.total;
      if (!result.output || items.length === 0 || typeof total === "number" && page * 100 >= total || total === undefined && items.length < 100) return [...models.values()];
    }
    throw new Error("百炼模型目录超过分页上限，未保存不完整列表");
  },
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    if (Object.keys(request.audioParameters ?? {}).length) throw new Error("百炼语音请通过音色、语速和表演指令等专用字段设置参数");
    const modern = /^(qwen-audio-[\d.]+-tts-|cosyvoice-v)/.test(request.model);
    const classic = /^qwen(?:3)?-tts/.test(request.model) && !/-realtime|-vd|-vc/.test(request.model);
    const minimax = /^MiniMax\/speech-[\d.]+-(?:hd|turbo)$/.test(request.model);
    if (!modern && !classic && !minimax) throw new Error("此模型尚未适配百炼非实时语音合成");
    if (!request.text.trim()) throw new Error("请填写配音文本");
    if (request.audios?.length || request.volume !== undefined && request.volume !== 0) throw new Error("当前语音适配不支持参考音频或音量增益");
    if (request.instructions && !modern && !request.model.includes("instruct")) throw new Error("此模型不支持表演指令");
    if (request.speed !== undefined && (classic && request.speed !== 1 || !Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2)) throw new Error("此模型不支持所选语速");
    const format = request.format ?? (classic ? "wav" : "mp3");
    if (modern && !["mp3", "pcm", "wav", "opus"].includes(format) || classic && format !== "wav" || minimax && !["mp3", "pcm", "wav", "flac"].includes(format)) throw new Error("此模型不支持所选音频格式");
    if (request.sampleRate !== undefined && (classic || !(minimax ? [8000, 16000, 22050, 24000, 32000, 44100] : [8000, 12000, 16000, 22050, 24000, 44100, 48000]).includes(request.sampleRate))) throw new Error("此模型不支持所选采样率");
    if (format === "opus" && request.sampleRate === 22050 || format === "opus" && request.sampleRate === 44100) throw new Error("Opus 不支持此采样率");
    if (modern && !request.voice?.trim()) throw new Error("请填写此模型的系统或已创建音色 ID");
    const input = { text: request.text, voice: request.voice || "Cherry", ...(request.instructions ? { [modern ? "instruction" : "instructions"]: request.instructions } : {}), ...(modern ? { format, ...(request.sampleRate ? { sample_rate: request.sampleRate } : {}), ...(request.speed ? { rate: request.speed } : {}) } : {}) };
    const signal = AbortSignal.any([AbortSignal.timeout(180000), ...(this.signal ? [this.signal] : [])]);
    const context = classic ? { ...this, config: { ...this.config, baseUrl: String(this.config.qwenTtsBaseUrl || "https://dashscope.aliyuncs.com/api/v1").replace(/\/+$/, "") } } : this;
    const result = await fetchJson(context, modern ? "/services/audio/tts/SpeechSynthesizer" : "/services/aigc/multimodal-generation/generation", signal, { model: request.model, input: minimax ? { text: request.text, voice_setting: { voice_id: request.voice || "male-qn-qingse", speed: request.speed ?? 1 }, audio_setting: { format, sample_rate: request.sampleRate ?? 32000 } } : input });
    const url = result.output?.audio?.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("百炼未返回有效音频地址");
    return [{ mediaType: "audio", type: "url", url }];
  },
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
    if (request.firstFrame && request.ratio) await this.tool.assertAspectRatio(request.firstFrame, request.ratio);
    if (!imageMode && request.generateAudio === false) throw new Error("万相 2.6 文生视频会自动生成音频");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const task = await fetchJson(this, "/services/aigc/video-generation/video-synthesis", signal, {
      model: request.model, input: { prompt: request.prompt, ...(request.firstFrame ? { img_url: imageUrl(request.firstFrame) } : {}) },
      parameters: { duration, watermark: request.watermark ?? false, ...(imageMode ? { resolution, audio: request.generateAudio ?? false } : { size: dimensions[ratio]![resolution === "1080P" ? 1 : 0] }) },
    }, true);
    const taskId = task.output?.task_id;
    if (typeof taskId !== "string" || !taskId) throw new Error("百炼未返回任务 ID");
    await this.tool.reportTask?.({ id: taskId, status: "submitted", mediaType: "video" });
    return resumeMedia.call(this, { id: taskId, status: "submitted", mediaType: "video" });
  },
} satisfies ProviderDefinition<typeof rules>;
