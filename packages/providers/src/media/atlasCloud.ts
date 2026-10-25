const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://api.atlascloud.ai/api/v1" },
] as const;

function apiBaseUrl(config: Record<string, unknown>) {
  return String(config.baseUrl || "https://api.atlascloud.ai").trim().replace(/\/+$/, "").replace(/\/(?:api\/)?v1$/i, "");
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: string | FormData) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  const baseUrl = apiBaseUrl(context.config);
  if (!key || !baseUrl) throw new Error("请填写 Atlas Cloud API Key 和地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", signal, body,
    headers: { Authorization: `Bearer ${key}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) throw Object.assign(new Error(`Atlas Cloud 请求失败（HTTP ${response.status}）`), { status: response.status });
  const result = await response.json() as Record<string, any>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Atlas Cloud 响应格式错误");
  if (result.error || Number(result.code) >= 400) throw Object.assign(new Error(context.tool.errorMessage(result) || "Atlas Cloud 请求失败"), { status: Number(result.code) });
  return result;
}

async function uploadMedia(context: ProviderContext, input: MediaInput, signal: AbortSignal, formats: string[], maxBytes: number) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考素材须使用 HTTP 地址");
    return input.url;
  }
  if (!formats.includes(input.mimeType)) throw new Error(`参考素材格式不支持：${input.mimeType}`);
  const bytes = input.type === "binary" ? input.data : Buffer.from(input.data.replace(/^data:[^,]+,/, ""), "base64");
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error(`参考素材须为不超过 ${maxBytes / 1024 / 1024} MB 的非空文件`);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: input.mimeType }), `media.${input.mimeType.split("/")[1]}`);
  const result = await fetchJson(context, "/api/v1/model/uploadMedia", signal, form);
  const url = result.data?.download_url ?? result.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Atlas Cloud 上传未返回有效地址");
  return url;
}

function uploadImage(context: ProviderContext, input: MediaInput, signal: AbortSignal) {
  return uploadMedia(context, input, signal, ["image/png", "image/jpeg", "image/webp"], 10 * 1024 * 1024);
}

function wait(signal: AbortSignal, milliseconds: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function generate(context: ProviderContext, mediaType: "image" | "video" | "audio", body: Record<string, unknown>, signal: AbortSignal): Promise<MediaAsset[]> {
  await context.tool.reportTask?.({ status: "submitting" });
  let task;
  try {
    task = await fetchJson(context, `/api/v1/model/${mediaType === "image" ? "generateImage" : mediaType === "audio" ? "generateAudio" : "generateVideo"}`, signal, JSON.stringify(body));
  } catch (error) {
    const rejected = [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(Number((error as { status?: number }).status));
    await context.tool.reportTask?.({ status: rejected ? "rejected" : "unknown" });
    throw error;
  }
  const result = task.data ?? task;
  const id = result.id;
  if (typeof id !== "string" || !id) throw new Error("Atlas Cloud 未返回任务 ID");
  await context.tool.reportTask?.({ id, status: String(result.status ?? "submitted"), mediaType });
  return resumeMedia.call(context, { id, status: "submitted", mediaType });
}

async function resumeMedia(this: ProviderContext, task: MediaTask & { id: string }): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  const response = await fetchJson(this, `/api/v1/model/prediction/${encodeURIComponent(task.id)}`, signal);
  let result = response.data ?? response;
  const id = task.id;
  const mediaType = task.mediaType ?? "video";
  while (true) {
    await this.tool.reportTask?.({ id, status: String(result.status ?? "unknown") });
    if (["failed", "failure", "cancelled", "canceled", "rejected", "error"].includes(String(result.status).toLowerCase())) {
      await this.tool.reportTask?.({ id, status: "failed" });
      throw Object.assign(new Error(this.tool.errorMessage(result) || "Atlas Cloud 原任务失败"), { retryable: false, fallbackAllowed: false });
    }
    if (result.status === "completed") {
      if (!Array.isArray(result.outputs) || !result.outputs.length) throw new Error("Atlas Cloud 未返回生成结果");
      return result.outputs.map((url: unknown): MediaAsset => {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Atlas Cloud 返回了无效的结果地址");
        return { mediaType, type: "url", url };
      });
    }
    if (!["created", "queued", "pending", "processing"].includes(result.status)) throw new Error(this.tool.errorMessage(result) || "Atlas Cloud 任务失败或状态无效");
    await wait(signal, mediaType === "image" ? 2000 : 5000);
    const response = await fetchJson(this, `/api/v1/model/prediction/${encodeURIComponent(id)}`, signal);
    result = response.data ?? response;
  }
}

type InputField = { type?: string; enum?: (string | number | boolean)[]; default?: unknown; minimum?: number; maximum?: number; step?: number; maxLength?: number; minItems?: number; maxItems?: number };
type AtlasModel = ProviderModel & Record<string, unknown> & { schemaUrl?: string; inputSchema?: { properties: Record<string, InputField>; required?: string[] } };

async function generateSynced(context: ProviderContext, request: ImageRequest | VideoRequest, mediaType: "image" | "video", model: AtlasModel) {
  const schema = model.inputSchema!;
  const fields = schema.properties;
  if (!request.prompt.trim()) throw new Error("请填写提示词");
  const signal = AbortSignal.any([AbortSignal.timeout(mediaType === "image" ? 10 * 60_000 : 30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const body: Record<string, unknown> = { model: request.model, prompt: request.prompt };
  const set = (field: string, value: unknown) => {
    if (!fields[field] || value === undefined) return;
    if (fields[field].enum && !fields[field].enum!.includes(value as string | number)) throw new Error(`模型不支持 ${field} 参数：${value}`);
    body[field] = value;
  };
  // 图片与视频共用画幅字段，不能让图片分支落到 auto 或跟随参考图。
  set("aspect_ratio", request.ratio || fields.aspect_ratio?.default);
  set("ratio", request.ratio || fields.ratio?.default);
  if (mediaType === "image") {
    const input = request as ImageRequest;
    if (input.ratio && !fields.aspect_ratio && !fields.ratio) {
      const pixels = /^(\d+)[x*](\d+)$/.exec(input.size || String(fields.size?.default ?? ""));
      const [width, height] = input.ratio.split(":").map(Number);
      if (!fields.size || !pixels || Number(pixels[1]) * height !== Number(pixels[2]) * width) throw new Error(`此模型不能按当前尺寸保证 ${input.ratio} 画幅，请选择支持的画幅或匹配的像素尺寸；未提交生成`);
    }
    if (input.mask || (input.n !== undefined && input.n !== 1)) throw new Error("当前不支持蒙版或指定生成数量");
    const images = input.images ?? [];
    const imageField = fields.images ?? fields.image ?? fields.reference_images;
    if (images.length && !imageField) throw new Error("文生图模型不能附带参考图");
    if (images.length > (imageField?.maxItems ?? (fields.images || fields.reference_images ? 10 : 1))) throw new Error("参考图数量超过所选模型上限");
    if (schema.required?.some(field => ["image", "images", "reference_images"].includes(field)) && images.length < (imageField?.minItems ?? 1)) {
      throw new Error(`「${request.model}」是编辑模型，必须带参考图：在请求里用 images 传 1–${imageField?.maxItems ?? 10} 张图；只想凭文字出图请切回文生图模型（如 openai/gpt-image-2/text-to-image）`);
    }
    const urls: string[] = [];
    for (const image of images) urls.push(await uploadImage(context, image, signal));
    if (urls.length) body[fields.images ? "images" : fields.image ? "image" : "reference_images"] = fields.image && !fields.images ? urls[0] : urls;
    set("size", input.size || fields.size?.default);
    // 无像素 size 的模型（nano-banana 系）把所选 1k/2k/4k 档传给 resolution。
    if (!fields.size && fields.resolution) set("resolution", input.size || fields.resolution.default);
    set("quality", input.quality);
    set("output_format", input.outputFormat);
  } else {
    const input = request as VideoRequest;
    if (input.ratio && !fields.aspect_ratio && !fields.ratio) {
      if (!input.firstFrame) throw new Error(`此模型没有可控制的画幅参数，无法保证 ${input.ratio}，未提交生成`);
      await context.tool.assertAspectRatio(input.firstFrame, input.ratio);
    }
    if (input.images?.length || input.videos?.length || input.audios?.length || input.watermark) throw new Error("此适配支持文字和首尾帧视频，不支持参考素材或水印");
    const imageMode = model.mode?.includes("singleImage") || model.mode?.includes("endFrameOptional");
    if (imageMode !== !!input.firstFrame || (input.lastFrame && !fields.end_image)) throw new Error("首尾帧与所选模型不匹配");
    if (input.mode !== undefined && !model.mode?.some(mode => JSON.stringify(mode) === JSON.stringify(input.mode))) throw new Error("视频模式与所选模型不匹配");
    if (input.firstFrame) body.image = await uploadImage(context, input.firstFrame, signal);
    if (input.lastFrame) body.end_image = await uploadImage(context, input.lastFrame, signal);
    set("duration", input.duration ?? fields.duration?.default);
    set("resolution", input.resolution || fields.resolution?.default);
    set("sound", input.generateAudio ?? false);
    if (input.generateAudio && !fields.sound) throw new Error("此模型不支持生成音频");
    set("multi_shot", false);
  }
  for (const field of schema.required ?? []) if (body[field] === undefined) throw new Error(`模型缺少必填参数 ${field}，需更新适配`);
  return generate(context, mediaType, body, signal);
}

export default {
  resumeMedia,
  id: "atlasCloud", label: "Atlas Cloud", version: "1.3.7", rules,
  readme: "支持同步图片、视频和独立音频模型。音频模型选择后读取官方参数定义，包括音色、语速、格式和采样率；音乐可通过 audioParameters 填写模型定义中的 lyrics、instrumental 等标量参数。音频任务通过 generateAudio 提交并自动轮询，转录及歌词文本模型不列为音频文件生成。复杂参考、分层和多镜头模型需单独适配。本地参考图自动上传。\n\n[音频文档](https://www.atlascloud.ai/docs/models/audio)",
  models: [
    { id: "bytedance/seed-audio-1.0", label: "Seed Audio 1.0 · 语音", type: "audio", audioTask: "speech", inputSchema: { properties: { text: { type: "string" }, format: { enum: ["mp3", "wav", "pcm", "ogg_opus"] }, sample_rate: { enum: [8000, 16000, 24000, 32000, 44100, 48000] }, speech_rate: { minimum: -50, maximum: 100 } }, required: ["text"] } },
    { id: "suno/chirp-v6", label: "Suno Chirp v6 · 音乐", type: "audio", audioTask: "music", inputSchema: { properties: { prompt: { type: "string" } }, required: ["prompt"] } },
    { id: "sync/lipsync-v3", label: "Sync Lipsync v3 · 已有视频对口型", type: "video", lipSync: true, audio: true, mode: [["videoReference:1", "audioReference:1"]] },
    { id: "bytedance/seedream-v4.5", label: "Seedream 4.5 文生图", type: "image", mode: ["text"], imageSizes: ["2K", "4K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "bytedance/seedream-v4.5/edit", label: "Seedream 4.5 参考图编辑", type: "image", mode: ["singleImage", "multiReference"], imageSizes: ["2K", "4K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "kwaivgi/kling-v2.6-pro/text-to-video", label: "Kling 2.6 Pro 文生视频", type: "video", mode: ["text"], audio: "optional", nativeDialogue: true, durationResolutionMap: [{ duration: [5, 10], resolution: [] }] },
    { id: "kwaivgi/kling-v2.6-pro/image-to-video", label: "Kling 2.6 Pro 首帧视频", type: "video", mode: ["singleImage"], audio: "optional", nativeDialogue: true, durationResolutionMap: [{ duration: [5, 10], resolution: [] }] },
  ] as AtlasModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const baseUrl = apiBaseUrl(this.config);
    const key = String(this.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
    const signal = this.signal ?? AbortSignal.timeout(60000);
    const response = await this.tool.fetch(`${baseUrl}/api/v1/models`, { signal, redirect: "error", headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!response.ok) throw new Error(`获取 Atlas Cloud 目录失败（HTTP ${response.status}）`);
    const result = await response.json() as { data?: Record<string, any>[] };
    if (!Array.isArray(result.data)) throw new Error("Atlas Cloud 目录格式错误");
    // ACT: 只导入已映射请求参数的家族，复杂任务和未知新协议需单独适配；reference-to-video、video-edit、sequential 等多参考与分层任务模式暂不导入。
    const catalogue: AtlasModel[] = result.data.filter(item => item.display_console === true && typeof item.model === "string" && (
      item.type === "Image" && (/^bytedance\/seedream-v[\d.]+(?:-(?:lite|flash|pro))?(?:\/(?:edit|text-to-image))?$/.test(item.model) || /^openai\/gpt-image-2(?:\.\d)?(?:-[a-z]+)?\/(text-to-image|edit|image-to-image)$/.test(item.model) || /^google\/nano-banana-[\d.]+(?:-lite|-pro)?(?:-developer)?\/(text-to-image|edit)$/.test(item.model) || /^microsoft\/mai-image-[\d.]+(?:-[a-z]+)?\/(text-to-image|edit)$/.test(item.model))
      || item.type === "Video" && (/^kwaivgi\/kling-v(?:2\.6|3\.0)-(pro|std)\/(text|image)-to-video$/.test(item.model) || /^bytedance\/seedance-[\w.-]+\/(text|image)-to-video$/.test(item.model) || /^minimax\/h3-[a-z-]+\/(text|image)-to-video$/.test(item.model) || /^alibaba\/wan-[\d.]+(?:-prime)?\/(text|image)-to-video$/.test(item.model) || item.model === "sync/lipsync-v3")
      || item.type === "Audio" && !/asr|stt|transcri|lyrics-generation|voice-clon|voice-design/i.test(item.model)
    )).map(item => ({ id: item.model, label: item.displayName || item.model, type: item.type.toLowerCase(),
      ...(item.price && (item.price.actual?.base_price != null || item.price.origin?.base_price != null) ? { price: JSON.stringify({ actual: item.price.actual?.base_price, origin: item.price.origin?.base_price }) } : {}),
      schemaUrl: item.schema }));
    if (!modelIds) return catalogue;
    const models: AtlasModel[] = [];
    for (const model of catalogue.filter(item => modelIds.includes(item.id))) {
      if (model.id === "sync/lipsync-v3") {
        Object.assign(model, { lipSync: true, audio: true, mode: [["videoReference:1", "audioReference:1"]] });
        models.push(model);
        continue;
      }
      if (typeof model.schemaUrl !== "string" || !/^https:\/\/static\.atlascloud\.ai\/model\/schema\//.test(model.schemaUrl)) throw new Error(`模型 ${model.id} 缺少可信参数定义`);
      const response = await this.tool.fetch(model.schemaUrl, { signal, redirect: "error" });
      if (!response.ok) throw new Error(`读取 ${model.id} 参数失败（HTTP ${response.status}）`);
      const result = await response.json() as Record<string, any>;
      const input = result?.components?.schemas?.Input;
      if (!input?.properties || !Array.isArray(input.required)) throw new Error(`模型 ${model.id} 参数格式错误`);
      const allowed = model.type === "audio" ? Object.entries(input.properties as Record<string, InputField>).filter(([, field]) => ["string", "number", "integer", "boolean"].includes(field.type ?? "")).map(([name]) => name) : ["model", "prompt", "size", "quality", "output_format", "images", "image", "reference_images", "end_image", "duration", "resolution", "aspect_ratio", "ratio", "sound", "multi_shot"];
      if (input.required.some((field: string) => !allowed.includes(field))) throw new Error(`模型 ${model.id} 包含未适配的必填参数`);
      const properties = Object.fromEntries(Object.entries(input.properties as Record<string, InputField>).filter(([field]) => allowed.includes(field)).map(([field, value]) => [field,
        Object.fromEntries(Object.entries(value).filter(([key]) => ["type", "enum", "default", "minimum", "maximum", "maxLength", "minItems", "maxItems"].includes(key))),
      ])) as Record<string, InputField>;
      model.inputSchema = { properties, required: input.required };
      if (model.type === "audio") {
        if (!properties.text && !properties.prompt) throw new Error(`模型 ${model.id} 不是已适配的文字生成音频模型`);
        model.audioTask = properties.text ? "speech" : /sound|effect|sfx/i.test(model.id) ? "soundEffect" : "music";
        model.speechInstructions = !!properties.instructions;
        const voices = (properties.voice ?? properties.voice_id)?.enum?.filter((voice): voice is string => typeof voice === "string").map(voice => ({ title: voice, voice }));
        if (voices?.length) model.voices = voices;
      } else if (model.type === "image") {
        const editing = !!(properties.images || properties.image || properties.reference_images);
        model.mode = editing ? ["singleImage", ...((properties.images || properties.reference_images) ? ["multiReference" as const] : [])] : ["text"];
        let imageSizes = properties.size?.enum?.filter((size): size is string => typeof size === "string" && /^\d+[x*]\d+$/.test(size));
        const imageRatios = (properties.aspect_ratio ?? properties.ratio)?.enum?.filter((ratio): ratio is string => typeof ratio === "string" && /^[1-9]\d*:[1-9]\d*$/.test(ratio));
        if (!imageSizes?.length) {
          // nano-banana 等系列没有像素 size，用 resolution 的 1k/2k/4k 档；生成端把尺寸选择映射到 resolution 参数。
          imageSizes = properties.resolution?.enum?.filter((tier): tier is string => typeof tier === "string" && /^\d+k$/i.test(tier));
        }
        if (imageSizes?.length) model.imageSizes = imageSizes;
        if (imageRatios?.length) model.imageRatios = imageRatios;
        // mai-image 的 size 是无枚举自由字符串（走模型默认）；edit 变体尺寸跟随参考图。仅纯文生图连尺寸字段都没有时视为未适配结构。
        if (!properties.size && !properties.resolution && !editing) throw new Error(`模型 ${model.id} 缺少已适配的尺寸参数`);
      } else {
        model.mode = model.id.endsWith("/image-to-video") ? ["singleImage", ...(properties.end_image ? ["endFrameOptional" as const] : [])] : ["text"];
        model.audio = properties.sound ? "optional" : false;
        model.nativeDialogue = !!model.audio && /^(?:kwaivgi\/kling-v2\.6-pro|bytedance\/seedance-v1\.5-pro)\//.test(model.id);
        // duration 无枚举时（seedance v1.5 系）按 minimum/maximum/step 生成档位；范围也缺失时退回常用档。
        const durationField = properties.duration;
        const duration = durationField?.enum?.filter((value): value is number => typeof value === "number" && value > 0)
          ?? (durationField?.minimum != null || durationField?.maximum != null
            ? Array.from({ length: 24 }, (_, i) => (durationField.minimum ?? 1) + i * (durationField.step ?? 1)).filter(value => durationField.maximum == null || value <= durationField.maximum)
            : [5, 10]);
        if (!duration.length) throw new Error(`模型 ${model.id} 缺少已适配的时长参数`);
        model.durationResolutionMap = [{ duration, resolution: properties.resolution?.enum?.filter((value): value is string => typeof value === "string") ?? [] }];
      }
      models.push(model);
    }
    return models;
  },
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const model = this.models?.find(item => item.id === request.model && item.type === "audio") as AtlasModel | undefined;
    if (!model?.inputSchema) throw new Error("请先同步并选择此音频模型以读取参数定义");
    if (!request.text.trim()) throw new Error("请填写配音文本或音乐、音效描述");
    if (request.audios?.length || (request.volume !== undefined && request.volume !== 0)) throw new Error("当前音频适配不支持参考音频或音量增益");
    const fields = model.inputSchema.properties;
    const body: Record<string, unknown> = { model: request.model, [fields.text ? "text" : "prompt"]: request.text };
    const set = (field: string, value: unknown) => {
      if (value === undefined) return;
      const rule = fields[field];
      if (!rule) throw new Error(`此音频模型不支持参数 ${field}`);
      if (rule.type === "string" && typeof value !== "string" || rule.type === "boolean" && typeof value !== "boolean" || ["number", "integer"].includes(rule.type ?? "") && typeof value !== "number" || rule.type === "integer" && !Number.isInteger(value) || typeof value === "string" && rule.maxLength !== undefined && value.length > rule.maxLength) throw new Error(`音频参数 ${field} 类型或长度错误`);
      if (rule.enum && !rule.enum.includes(value as string | number) || typeof value === "number" && (!Number.isFinite(value) || rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum)) throw new Error(`音频参数 ${field} 超出模型支持范围`);
      body[field] = value;
    };
    set(fields.voice ? "voice" : "voice_id", request.voice || undefined);
    set(fields.format ? "format" : fields.codec ? "codec" : "output_format", request.format);
    set("sample_rate", request.sampleRate);
    set("instructions", request.instructions || undefined);
    if (request.speed !== undefined) set(fields.speed ? "speed" : "speech_rate", fields.speed ? request.speed : Math.round((request.speed - 1) * 100));
    for (const [field, value] of Object.entries(request.audioParameters ?? {})) {
      if (["model", "text", "prompt", "voice", "voice_id", "speed", "speech_rate", "format", "output_format", "codec", "sample_rate", "instructions"].includes(field)) throw new Error(`请通过专用字段填写 ${field}，不能从额外参数覆盖`);
      set(field, value);
    }
    for (const field of model.inputSchema.required ?? []) {
      if (body[field] === undefined && fields[field]?.default !== undefined) body[field] = fields[field].default;
      if (body[field] === undefined) throw new Error(`音频模型缺少必填参数 ${field}，请设置音色或更新适配`);
    }
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    return generate(this, "audio", body, signal);
  },
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const synced = this.models?.find(item => item.id === request.model) as AtlasModel | undefined;
    if (synced?.inputSchema) return generateSynced(this, request, "image", synced);
    if (!request.prompt.trim()) throw new Error("请填写提示词");
    if (request.mask || (request.n !== undefined && request.n !== 1)) throw new Error("当前每次生成一张图片，不支持蒙版");
    if (!["bytedance/seedream-v4.5", "bytedance/seedream-v4.5/edit"].includes(request.model)) throw new Error("当前 Atlas Cloud 图片适配支持 Seedream 4.5");
    const editing = request.model.endsWith("/edit");
    const images = request.images ?? [];
    if (editing ? images.length < 1 || images.length > 10 : images.length > 0) throw new Error("参考图编辑须使用 1–10 张图片；文生图不能附带图片");
    const size = request.size || "2K";
    if (!["2K", "4K"].includes(size)) throw new Error("图片尺寸须为 2K 或 4K");
    const dimensions: Record<string, [string, string]> = {
      "1:1": ["2048*2048", "4096*4096"], "16:9": ["2848*1600", "5504*3040"], "9:16": ["1600*2848", "3040*5504"],
      "4:3": ["2304*1728", "4704*3520"], "3:4": ["1728*2304", "3520*4704"], "3:2": ["2496*1664", "4992*3328"],
      "2:3": ["1664*2496", "3328*4992"], "21:9": ["3136*1344", "6240*2656"],
    };
    const dimension = dimensions[request.ratio || "1:1"]?.[size === "4K" ? 1 : 0];
    if (!dimension) throw new Error("不支持此图片画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const urls: string[] = [];
    for (const image of images) urls.push(await uploadImage(this, image, signal));
    return generate(this, "image", { model: request.model, prompt: request.prompt, size: dimension, ...(editing ? { images: urls } : {}) }, signal);
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (request.model === "sync/lipsync-v3") {
      if (request.videos?.length !== 1 || request.audios?.length !== 1 || request.images?.length || request.firstFrame || request.lastFrame || request.cameraTrajectory) throw new Error("专用对口型需要一段原视频和一段声音，不接受重新生成画面的参考参数");
      if (request.generateAudio === false) throw new Error("对口型结果须保留驱动声音，不能静音");
      if (request.mode !== undefined && JSON.stringify(request.mode) !== JSON.stringify(["videoReference:1", "audioReference:1"])) throw new Error("专用对口型模式须为视频1与音频1");
      const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
      // 使用已验证的 URL 接入，避免内嵌 Base64 视频被受理后失败；上传原素材，不重生成画面。
      const videoUrl = await uploadMedia(this, request.videos[0]!, signal, ["video/mp4", "video/quicktime", "video/webm"], 100 * 1024 * 1024);
      const audioUrl = await uploadMedia(this, request.audios[0]!, signal, ["audio/wav", "audio/mpeg", "audio/mp4"], 100 * 1024 * 1024);
      // ACT: 官方cut_off仅裁至较短素材，不循环、不变速；保持已生成镜头与原曲节奏。
      return generate(this, "video", { model: request.model, video_url: videoUrl, audio_url: audioUrl, sync_mode: "cut_off" }, signal);
    }
    const synced = this.models?.find(item => item.id === request.model) as AtlasModel | undefined;
    if (synced?.inputSchema) return generateSynced(this, request, "video", synced);
    if (!request.prompt.trim()) throw new Error("请填写提示词");
    if (!["kwaivgi/kling-v2.6-pro/text-to-video", "kwaivgi/kling-v2.6-pro/image-to-video"].includes(request.model)) throw new Error("当前 Atlas Cloud 视频适配支持可灵 2.6 Pro");
    const imageMode = request.model.endsWith("/image-to-video");
    if (request.mode !== undefined && request.mode !== (imageMode ? "singleImage" : "text")) throw new Error("视频模式与所选模型不匹配");
    if (request.lastFrame || request.images?.length || request.videos?.length || request.audios?.length) throw new Error("当前 Atlas Cloud 视频仅支持文字或首帧");
    if (imageMode !== !!request.firstFrame) throw new Error("首帧模型须附带一张首帧；文生视频不能附带首帧");
    const duration = request.duration ?? 5;
    if (![5, 10].includes(duration)) throw new Error("可灵视频时长须为 5 或 10 秒");
    const ratio = request.ratio || "16:9";
    if (!imageMode && !["1:1", "16:9", "9:16"].includes(ratio)) throw new Error("不支持此视频画幅");
    if (imageMode && request.ratio) await this.tool.assertAspectRatio(request.firstFrame!, request.ratio);
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    return generate(this, "video", {
      model: request.model, prompt: request.prompt, duration, sound: request.generateAudio ?? false,
      ...(imageMode ? { image: await uploadImage(this, request.firstFrame!, signal) } : { aspect_ratio: ratio }),
    }, signal);
  },
} satisfies ProviderDefinition<typeof rules>;
