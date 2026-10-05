const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key（旧认证填 Access Key）", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "secret" as const, title: "Secret Key（仅旧 AK/SK 认证需要）", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址（可灵或兼容中转）", value: "https://api-singapore.klingai.com/v1" },
] as const;

function imageValue(input: MediaInput) {
  if (input.type === "url") return input.url;
  if (!["image/png", "image/jpeg"].includes(input.mimeType)) throw new Error("可灵参考图片须为 PNG 或 JPEG");
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.replace(/^data:[^,]+,/, "");
}

async function authorization(context: ProviderContext) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请填写可灵 API Key 或 Access Key");
  const secret = String(context.config.secret ?? "").trim();
  if (!secret) return `Bearer ${key}`;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: key, exp: now + 1800, nbf: now - 5 })}`;
  const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(payload));
  return `Bearer ${payload}.${Buffer.from(signature).toString("base64url")}`;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: unknown) {
  const baseUrl = String(context.config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("请填写可灵 API 地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { Authorization: await authorization(context), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`可灵请求失败（HTTP ${response.status}）`);
  const result = await response.json() as Record<string, any>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("可灵响应格式错误");
  if (result.code !== 0) throw new Error(context.tool.errorMessage(result) || "可灵请求失败");
  return result.data as Record<string, any>;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function generateTask(context: ProviderContext, path: string, body: unknown, mediaType: "image" | "video"): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const task = await fetchJson(context, path, signal, body);
  if (typeof task?.task_id !== "string" || !task.task_id) throw new Error("可灵未返回任务 ID");
  while (true) {
    const result = await fetchJson(context, `${path}/${encodeURIComponent(task.task_id)}`, signal);
    if (result?.task_status === "succeed") {
      const outputs = result.task_result?.[mediaType === "image" ? "images" : "videos"];
      if (!Array.isArray(outputs) || !outputs.length) throw new Error("可灵未返回生成结果");
      return outputs.map((item: any): MediaAsset => {
        if (typeof item?.url !== "string" || !/^https?:\/\//i.test(item.url)) throw new Error("可灵未返回有效结果地址");
        return { mediaType, type: "url", url: item.url };
      });
    }
    if (!["submitted", "processing"].includes(result?.task_status)) throw new Error(context.tool.errorMessage(result?.task_status_msg) || "可灵任务失败或状态无效");
    await wait(signal);
  }
}

export default {
  id: "kling", label: "可灵", version: "1.0.0", rules,
  readme: "内置可灵 Image 2.1 和 Video 2.6。新认证只需 API Key，Secret Key 留空；旧 AK/SK 认证在 API Key 中填 Access Key，再填 Secret Key。接口地址以 /v1 结尾，可改成可灵协议中转地址。图片支持文字和最多 4 张主体参考；视频支持文字或首帧，5/10 秒。\n\n[认证文档](https://kling.ai/document-api/api/get-started/authentication) · [视频文档](https://kling.ai/document-api/api/video/2-6/text-to-video/legacy)",
  models: [
    { id: "kling-v2-1", label: "Kling Image 2.1", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K"], imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] },
    { id: "kling-v2-6", label: "Kling Video 2.6", type: "video", mode: ["text", "singleImage"], audio: "optional", durationResolutionMap: [{ duration: [5, 10], resolution: ["1080P"] }] },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim() || request.prompt.length > 2500) throw new Error("请填写模型 ID 和 2500 字以内的提示词");
    if (request.mask) throw new Error("当前未接入蒙版编辑");
    if (request.size && request.size !== "1K") throw new Error("当前可灵图片使用 1K");
    const n = request.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("图片数量须为 1–9");
    const ratio = request.ratio ?? "1:1";
    if (!["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"].includes(ratio)) throw new Error("不支持此图片画幅");
    const images = (request.images ?? []).map(imageValue);
    if (images.length > 4) throw new Error("最多使用 4 张主体参考图");
    return generateTask(this, images.length ? "/images/multi-image2image" : "/images/generations", {
      model_name: request.model, prompt: request.prompt, n, aspect_ratio: ratio,
      ...(images.length ? { subject_image_list: images.map(subjectImage => ({ subject_image: subjectImage })) } : { resolution: "1k" }),
    }, "image");
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (!request.model.trim() || !request.prompt.trim() || request.prompt.length > 2500) throw new Error("请填写模型 ID 和 2500 字以内的提示词");
    if (request.mode !== undefined && !["text", "singleImage"].includes(String(request.mode))) throw new Error("不支持此视频模式");
    if (request.mode === "text" && request.firstFrame) throw new Error("文生视频模式不能附带首帧");
    if (request.lastFrame || request.images?.length || request.audios?.length || request.videos?.length) throw new Error("当前可灵视频仅接通文字或首帧");
    if (request.mode === "singleImage" && !request.firstFrame) throw new Error("请选择视频首帧");
    const duration = request.duration ?? 5;
    if (![5, 10].includes(duration)) throw new Error("可灵视频时长须为 5 或 10 秒");
    const resolution = (request.resolution ?? "720P").toUpperCase();
    if (!["720P", "1080P"].includes(resolution)) throw new Error("不支持此视频分辨率");
    if (resolution === "720P" && request.generateAudio) throw new Error("可灵 2.6 有声视频需要 1080P 专业模式");
    const ratio = request.ratio ?? "16:9";
    if (!["16:9", "9:16", "1:1"].includes(ratio)) throw new Error("不支持此视频画幅");
    return generateTask(this, request.firstFrame ? "/videos/image2video" : "/videos/text2video", {
      model_name: request.model, prompt: request.prompt, duration: String(duration), mode: resolution === "1080P" ? "pro" : "std",
      sound: request.generateAudio ? "on" : "off", watermark_info: { enabled: request.watermark ?? false },
      ...(request.firstFrame ? { image: imageValue(request.firstFrame) } : { aspect_ratio: ratio }),
    }, "video");
  },
} satisfies ProviderDefinition<typeof rules>;
