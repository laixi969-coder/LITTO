const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://api.atlascloud.ai" },
] as const;

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: string | FormData) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  const baseUrl = String(context.config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!key || !baseUrl) throw new Error("请填写 Atlas Cloud API Key 和地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", signal, body,
    headers: { Authorization: `Bearer ${key}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) throw new Error(`Atlas Cloud 请求失败（HTTP ${response.status}）`);
  const result = await response.json() as Record<string, any>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Atlas Cloud 响应格式错误");
  if (result.error || (typeof result.code === "number" && result.code >= 400)) throw new Error(context.tool.errorMessage(result) || "Atlas Cloud 请求失败");
  return result;
}

async function uploadImage(context: ProviderContext, input: MediaInput, signal: AbortSignal) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考图须使用 HTTP 地址");
    return input.url;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(input.mimeType)) throw new Error("参考图须为 PNG、JPEG 或 WebP");
  const bytes = input.type === "binary" ? input.data : Buffer.from(input.data.replace(/^data:[^,]+,/, ""), "base64");
  if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) throw new Error("参考图须为不超过 10 MB 的文件");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: input.mimeType }), `image.${input.mimeType.split("/")[1]}`);
  const result = await fetchJson(context, "/api/v1/model/uploadMedia", signal, form);
  if (typeof result.url !== "string" || !/^https?:\/\//i.test(result.url)) throw new Error("Atlas Cloud 上传未返回有效地址");
  return result.url;
}

function wait(signal: AbortSignal, milliseconds: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function generate(context: ProviderContext, mediaType: "image" | "video", body: Record<string, unknown>, signal: AbortSignal): Promise<MediaAsset[]> {
  const task = await fetchJson(context, `/api/v1/model/${mediaType === "image" ? "generateImage" : "generateVideo"}`, signal, JSON.stringify(body));
  let result = task.data ?? task;
  const id = result.id;
  if (typeof id !== "string" || !id) throw new Error("Atlas Cloud 未返回任务 ID");
  while (true) {
    if (result.status === "completed") {
      if (!Array.isArray(result.outputs) || !result.outputs.length) throw new Error("Atlas Cloud 未返回生成结果");
      return result.outputs.map((url: unknown): MediaAsset => {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Atlas Cloud 返回了无效的结果地址");
        return { mediaType, type: "url", url };
      });
    }
    if (!["created", "queued", "pending", "processing"].includes(result.status)) throw new Error(context.tool.errorMessage(result) || "Atlas Cloud 任务失败或状态无效");
    await wait(signal, mediaType === "image" ? 2000 : 5000);
    const response = await fetchJson(context, `/api/v1/model/prediction/${encodeURIComponent(id)}`, signal);
    result = response.data ?? response;
  }
}

type InputField = { type?: string; enum?: (string | number)[]; default?: unknown; minItems?: number; maxItems?: number };
type AtlasModel = ProviderModel & { schemaUrl?: string; inputSchema?: { properties: Record<string, InputField>; required?: string[] } };

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
  if (mediaType === "image") {
    const input = request as ImageRequest;
    if (input.mask || (input.n !== undefined && input.n !== 1)) throw new Error("当前不支持蒙版或指定生成数量");
    const images = input.images ?? [];
    const imageField = fields.images ?? fields.image;
    if (images.length && !imageField) throw new Error("文生图模型不能附带参考图");
    if (images.length > (imageField?.maxItems ?? (fields.images ? 10 : 1))) throw new Error("参考图数量超过所选模型上限");
    if (schema.required?.some(field => ["image", "images"].includes(field)) && images.length < (imageField?.minItems ?? 1)) throw new Error("此模型需要参考图");
    const urls: string[] = [];
    for (const image of images) urls.push(await uploadImage(context, image, signal));
    if (urls.length) body[fields.images ? "images" : "image"] = fields.images ? urls : urls[0];
    set("size", input.size || fields.size?.default);
    set("quality", input.quality);
    set("output_format", input.outputFormat);
  } else {
    const input = request as VideoRequest;
    if (input.images?.length || input.videos?.length || input.audios?.length || input.watermark) throw new Error("此适配支持文字和首尾帧视频，不支持参考素材或水印");
    const imageMode = model.mode?.includes("singleImage") || model.mode?.includes("endFrameOptional");
    if (imageMode !== !!input.firstFrame || (input.lastFrame && !fields.end_image)) throw new Error("首尾帧与所选模型不匹配");
    if (input.mode !== undefined && !model.mode?.some(mode => JSON.stringify(mode) === JSON.stringify(input.mode))) throw new Error("视频模式与所选模型不匹配");
    if (input.firstFrame) body.image = await uploadImage(context, input.firstFrame, signal);
    if (input.lastFrame) body.end_image = await uploadImage(context, input.lastFrame, signal);
    set("duration", input.duration ?? fields.duration?.default);
    set("resolution", input.resolution || fields.resolution?.default);
    set("aspect_ratio", input.ratio || fields.aspect_ratio?.default);
    set("sound", input.generateAudio ?? false);
    if (input.generateAudio && !fields.sound) throw new Error("此模型不支持生成音频");
    set("multi_shot", false);
  }
  for (const field of schema.required ?? []) if (body[field] === undefined) throw new Error(`模型缺少必填参数 ${field}，需更新适配`);
  return generate(context, mediaType, body, signal);
}

export default {
  id: "atlasCloud", label: "Atlas Cloud", version: "1.1.0", rules,
  readme: "支持同步 Atlas Cloud 实时目录并选取已适配的 Seedream、GPT Image 2 图片和可灵视频。所选模型的尺寸、时长、分辨率从官方参数定义更新；复杂参考、分层和多镜头模型需单独适配，不加入可用目录。本地参考图自动上传。\n\n[官方文档](https://www.atlascloud.ai/docs/zh)",
  models: [
    { id: "bytedance/seedream-v4.5", label: "Seedream 4.5 文生图", type: "image", mode: ["text"], imageSizes: ["2K", "4K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "bytedance/seedream-v4.5/edit", label: "Seedream 4.5 参考图编辑", type: "image", mode: ["singleImage", "multiReference"], imageSizes: ["2K", "4K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "kwaivgi/kling-v2.6-pro/text-to-video", label: "Kling 2.6 Pro 文生视频", type: "video", mode: ["text"], audio: "optional", durationResolutionMap: [{ duration: [5, 10], resolution: [] }] },
    { id: "kwaivgi/kling-v2.6-pro/image-to-video", label: "Kling 2.6 Pro 首帧视频", type: "video", mode: ["singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10], resolution: [] }] },
  ] satisfies ProviderModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const baseUrl = String(this.config.baseUrl || "https://api.atlascloud.ai").trim().replace(/\/+$/, "");
    const signal = this.signal ?? AbortSignal.timeout(60000);
    const response = await this.tool.fetch(`${baseUrl}/api/v1/models`, { signal, redirect: "error" });
    if (!response.ok) throw new Error(`获取 Atlas Cloud 目录失败（HTTP ${response.status}）`);
    const result = await response.json() as { data?: Record<string, any>[] };
    if (!Array.isArray(result.data)) throw new Error("Atlas Cloud 目录格式错误");
    // ACT: 只导入已映射请求参数的家族，复杂任务和未知新协议需单独适配。
    const catalogue: AtlasModel[] = result.data.filter(item => item.display_console === true && typeof item.model === "string" && (
      item.type === "Image" && (/^bytedance\/seedream-v[\d.]+(?:-(?:lite|flash|pro))?(?:\/(?:edit|text-to-image))?$/.test(item.model) || /^openai\/gpt-image-2\/(text-to-image|image-to-image)$/.test(item.model))
      || item.type === "Video" && /^kwaivgi\/kling-v(?:2\.6|3\.0)-(pro|std)\/(text|image)-to-video$/.test(item.model)
    )).map(item => ({ id: item.model, label: item.displayName || item.model, type: item.type.toLowerCase(), schemaUrl: item.schema }));
    if (!modelIds) return catalogue;
    const models: AtlasModel[] = [];
    for (const model of catalogue.filter(item => modelIds.includes(item.id))) {
      if (typeof model.schemaUrl !== "string" || !/^https:\/\/static\.atlascloud\.ai\/model\/schema\//.test(model.schemaUrl)) throw new Error(`模型 ${model.id} 缺少可信参数定义`);
      const response = await this.tool.fetch(model.schemaUrl, { signal, redirect: "error" });
      if (!response.ok) throw new Error(`读取 ${model.id} 参数失败（HTTP ${response.status}）`);
      const result = await response.json() as Record<string, any>;
      const input = result?.components?.schemas?.Input;
      if (!input?.properties || !Array.isArray(input.required)) throw new Error(`模型 ${model.id} 参数格式错误`);
      const allowed = ["model", "prompt", "size", "quality", "output_format", "images", "image", "end_image", "duration", "resolution", "aspect_ratio", "sound", "multi_shot"];
      if (input.required.some((field: string) => !allowed.includes(field))) throw new Error(`模型 ${model.id} 包含未适配的必填参数`);
      const properties = Object.fromEntries(Object.entries(input.properties as Record<string, InputField>).filter(([field]) => allowed.includes(field)).map(([field, value]) => [field,
        Object.fromEntries(Object.entries(value).filter(([key]) => ["type", "enum", "default", "minItems", "maxItems"].includes(key))),
      ])) as Record<string, InputField>;
      model.inputSchema = { properties, required: input.required };
      if (model.type === "image") {
        const editing = !!(properties.images || properties.image);
        model.mode = editing ? ["singleImage", ...(properties.images ? ["multiReference" as const] : [])] : ["text"];
        model.imageSizes = properties.size?.enum?.filter((size): size is string => typeof size === "string" && /^\d+[x*]\d+$/.test(size));
        if (!model.imageSizes?.length) throw new Error(`模型 ${model.id} 缺少已适配的尺寸参数`);
      } else {
        model.mode = model.id.endsWith("/image-to-video") ? ["singleImage", ...(properties.end_image ? ["endFrameOptional" as const] : [])] : ["text"];
        model.audio = properties.sound ? "optional" : false;
        const duration = properties.duration?.enum?.filter((value): value is number => typeof value === "number" && value > 0);
        if (!duration?.length) throw new Error(`模型 ${model.id} 缺少已适配的时长参数`);
        model.durationResolutionMap = [{ duration, resolution: properties.resolution?.enum?.filter((value): value is string => typeof value === "string") ?? [] }];
      }
      models.push(model);
    }
    return models;
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
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    return generate(this, "video", {
      model: request.model, prompt: request.prompt, duration, sound: request.generateAudio ?? false,
      ...(imageMode ? { image: await uploadImage(this, request.firstFrame!, signal) } : { aspect_ratio: ratio }),
    }, signal);
  },
} satisfies ProviderDefinition<typeof rules>;
