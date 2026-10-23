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
  id: "volcengine", label: "火山方舟", version: "1.2.0", rules,
  readme: "使用火山方舟 API Key。内置 Seedream 4.5 / 5 Pro 与 Seedance 1.5 Pro / 2.5，支持本地图片参考、首帧和首尾帧；Seedance 2.5 支持最多 30 张图片的身份/场景参考，尚未接入音视频参考与编辑。API 地址可改为兼容方舟协议的中转；模型 ID 可在模型配置中替换为控制台接入点 ID。\n\n[官方文档](https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh)",
  models: [
    { id: "doubao-seedream-4-5-251128", label: "Seedream 4.5", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["2K", "4K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "doubao-seedream-5-0-pro-260628", label: "Seedream 5 Pro", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["2K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "doubao-seedance-1-5-pro-251215", label: "Seedance 1.5 Pro", type: "video", mode: ["text", "singleImage", "endFrameOptional"], audio: "optional", durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480P", "720P", "1080P"] }] },
    { id: "doubao-seedance-2-5-260628", label: "Seedance 2.5", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:30"]], audio: "optional", durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480P", "720P", "1080P"] }] },
  ] satisfies ProviderModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const result = await fetchJson(this, "/models", this.signal ?? AbortSignal.timeout(30000));
    if (!Array.isArray(result.data)) throw new Error("方舟模型目录格式错误");
    const models = new Map<string, ProviderModel>();
    for (const item of result.data) {
      const id = item.id ?? item.model_id;
      if (typeof id !== "string" || modelIds && !modelIds.includes(id)) continue;
      const known = this.models?.find(model => model.id === id);
      // ACT: 2.5 仅接已实现的图片参考与首尾帧，不宣称已支持视频编辑或全部音视频参考能力。
      // 仅对已适配的版本匹配能力，不把未知新版本猜成旧版。
      const template = known ?? this.models?.find(model => {
        if (/^doubao-seedream-5-0-pro-/.test(id)) return model.type === "image" && /5-0-pro/.test(model.id);
        if (/^doubao-seedream-4-5-/.test(id)) return model.type === "image" && /4-5/.test(model.id);
        if (/^doubao-seedance-2-5-/.test(id)) return model.type === "video" && /2-5/.test(model.id);
        if (/^doubao-seedance-1-5-/.test(id)) return model.type === "video" && /1-5/.test(model.id);
        return false;
      });
      if (template) models.set(id, { ...template, id, label: item.name || item.display_name || id });
    }
    return [...models.values()];
  },
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和提示词");
    if (request.mask) throw new Error("方舟当前未接入蒙版编辑");
    if (request.n !== undefined && request.n !== 1) throw new Error("当前每次生成一张图片");
    const model = this.models?.find(model => model.id === request.model);
    const seedream5Pro = /seedream-5-0-pro/.test(request.model) || /Seedream 5(?:\.0)? Pro/i.test(model?.label ?? "");
    const size = request.size ?? "2K";
    if (!(model?.imageSizes ?? []).includes(size) || !["2K", "4K"].includes(size) || seedream5Pro && size !== "2K") throw new Error("此适配器仅支持模型声明的 2K / 4K；Seedream 5 Pro 当前接入 2K");
    const ratio = request.ratio ?? "1:1";
    const dimensions: Record<string, [number, number]> = { "1:1": [2048, 2048], "16:9": [2560, 1440], "9:16": [1440, 2560], "4:3": [2304, 1728], "3:4": [1728, 2304], "3:2": [2496, 1664], "2:3": [1664, 2496], "21:9": [3024, 1296] };
    const dimensionsValue = dimensions[ratio];
    if (!dimensionsValue) throw new Error("不支持此图片画幅");
    const images = (request.images ?? []).map(imageUrl);
    const referenceLimit = seedream5Pro ? 10 : 14;
    if (images.length > referenceLimit) throw new Error(`最多使用 ${referenceLimit} 张参考图`);
    const signal = AbortSignal.any([AbortSignal.timeout(6 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const result = await fetchJson(this, "/images/generations", signal, {
      model: request.model, prompt: request.prompt, size: dimensionsValue.map(value => value * (size === "4K" ? 2 : 1)).join("x"),
      response_format: "url", ...(!seedream5Pro ? { sequential_image_generation: "disabled" } : {}), ...(images.length ? { image: images } : {}),
    });
    if (!Array.isArray(result.data) || !result.data.length) throw new Error("方舟未返回图片");
    return result.data.map((item: any): MediaAsset => {
      if (typeof item?.url !== "string" || !/^https?:\/\//i.test(item.url)) throw new Error(this.tool.errorMessage(item?.error) || "方舟未返回有效图片地址");
      return { mediaType: "image", type: "url", url: item.url };
    });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和提示词");
    // 画布 singleImage 用 images 传一张图；方舟协议将此图作为首帧。
    if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
    const model = this.models?.find(model => model.id === request.model);
    const referenceMode = Array.isArray(request.mode);
    if (referenceMode && !model?.mode?.some(mode => Array.isArray(mode) && JSON.stringify(mode) === JSON.stringify(request.mode))) throw new Error("当前模型未配置此多参考模式");
    if (!referenceMode && request.mode !== undefined && !["text", "singleImage", "endFrameOptional"].includes(String(request.mode))) throw new Error("不支持此视频模式");
    if (referenceMode && (request.firstFrame || request.lastFrame)) throw new Error("身份多参考模式不能同时指定首尾帧");
    if (request.mode === "text" && (request.firstFrame || request.lastFrame)) throw new Error("文生视频模式不能附带首尾帧");
    if ((request.mode === "singleImage" || request.mode === "endFrameOptional") && !request.firstFrame) throw new Error("请选择视频首帧");
    if (request.mode === "singleImage" && request.lastFrame) throw new Error("使用尾帧时请选择尾帧可选模式");
    if (request.videos?.length || request.audios?.length) throw new Error("当前方舟适配器尚未接入视频与音频参考");
    if (request.images?.length && !referenceMode) throw new Error("使用身份图片时请选择模型声明的多参考模式");
    const referenceLimit = Array.isArray(request.mode) ? Number(request.mode.find(value => value.startsWith("imageReference:"))?.split(":")[1] ?? 0) : 0;
    if (referenceMode && (!request.images?.length || request.images.length > Math.min(referenceLimit, 30))) throw new Error(`此模式须提供 1–${Math.min(referenceLimit, 30)} 张图片参考`);
    if (request.lastFrame && !request.firstFrame) throw new Error("尾帧须搭配首帧");
    const duration = request.duration ?? 5;
    // ACT: 时长与分辨率按所选模型的 durationResolutionMap 动态校验；
    // 未配置接入点能力时不猜成 30 秒；时长与分辨率必须来自同一条能力记录。
    const capability = model?.durationResolutionMap ?? [];
    if (!capability.length) throw new Error("当前模型未配置 durationResolutionMap，请先同步模型或配置接入点能力");
    const resolution = (request.resolution ?? "720P").toLowerCase();
    if (!Number.isInteger(duration) || !capability.some(row => row.duration.includes(duration) && row.resolution.some(value => value.toLowerCase() === resolution))) throw new Error("当前模型不支持此时长与分辨率组合，请按 durationResolutionMap 配置");
    // Seedance 2.5 首帧模式由输入图决定画幅，官方仅接受 adaptive。
    const seedance25 = /seedance-2-5/.test(request.model) || /Seedance 2\.5/i.test(model?.label ?? "");
    const ratio = seedance25 && request.firstFrame ? "adaptive" : request.ratio ?? "16:9";
    if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "adaptive"].includes(ratio)) throw new Error("不支持此视频画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const task = await fetchJson(this, "/contents/generations/tasks", signal, {
      model: request.model, content: [
        { type: "text", text: request.prompt },
        ...(referenceMode ? (request.images ?? []).map(input => ({ type: "image_url", image_url: { url: imageUrl(input) }, role: "reference_image" })) : []),
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
