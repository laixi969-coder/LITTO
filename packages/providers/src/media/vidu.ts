const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://api.vidu.cn" },
] as const;

function mediaValue(input: MediaInput, kind: "image" | "audio") {
  const label = kind === "image" ? "图片" : "参考音频";
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error(`Vidu ${label}地址须为 HTTP 或 HTTPS`);
    return input.url;
  }
  const formats = kind === "image" ? ["image/png", "image/jpeg", "image/jpg", "image/webp"] : ["audio/mpeg", "audio/mp3"];
  if (!formats.includes(input.mimeType)) throw new Error(kind === "image" ? "Vidu 图片须为 PNG、JPEG 或 WebP" : "Vidu 参考音频须为 MP3，时长为 3–12 秒");
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data.replace(/^data:[^,]+,/, "");
  if (!data) throw new Error(`Vidu ${label}不能为空`);
  return `data:${input.mimeType};base64,${data}`;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, authorization: "Token" | "Bearer", body?: string) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^(?:Token|Bearer)\s+/i, "");
  if (!key) throw new Error("请填写 Vidu API Key");
  const baseUrl = (String(context.config.baseUrl ?? "").trim() || "https://api.vidu.cn").replace(/\/+$/, "");
  const response = await context.tool.fetch(`${baseUrl}/ent/v2${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { Authorization: `${authorization} ${key}`, "Content-Type": "application/json" }, body,
  });
  if (!response.ok) throw new Error(`Vidu 请求失败（HTTP ${response.status}）`);
  const result = await response.json() as Record<string, any>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Vidu 响应格式错误");
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
  id: "vidu", label: "Vidu", version: "1.1.0", rules,
  readme: "Vidu Q4 Preview 支持图生视频和参考生视频。图生视频使用一张首帧，画幅跟随首帧；参考生视频使用 1–15 张图片，可附加 0–3 段 MP3 参考音频（每段 3–12 秒），画幅可选 16:9、9:16、1:1、4:3、3:4。两种模式均支持 3–16 秒、540P / 720P / 1080P / 2K / 4K，可选音画同出。提示词可按输入顺序使用“参考图1”“参考音频1”指定素材。只需填写 API Key，API 地址默认使用官方地址；中转须兼容 Vidu 协议。\n\n[图生视频文档](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q4-preview/image-to-video) · [参考生视频文档](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q4-preview/reference-to-video)",
  models: [
    { id: "viduq4-preview", label: "Vidu Q4 Preview", type: "video", mode: ["singleImage", ["imageReference:15", "audioReference:3"]], audio: "optional", durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540P", "720P", "1080P", "2K", "4K"] }] },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (request.model !== "viduq4-preview") throw new Error("当前 Vidu 接入支持 viduq4-preview");
    if (request.prompt.length > 20000) throw new Error("Vidu 提示词不能超过 20000 字");
    const referenceMode = Array.isArray(request.mode) || (request.mode === undefined && !!request.images?.length);
    if (Array.isArray(request.mode)) {
      if (!request.mode.includes("imageReference:15") || request.mode.some(mode => !["imageReference:15", "audioReference:3"].includes(mode))) throw new Error("不支持此 Vidu 参考模式");
    } else if (request.mode !== undefined && request.mode !== "singleImage") throw new Error("Vidu Q4 Preview 支持图生视频和参考生视频");
    if (request.lastFrame || request.videos?.length) throw new Error("Vidu Q4 Preview 不支持尾帧或视频参考");
    if (referenceMode) {
      if (request.firstFrame) throw new Error("参考生视频请将图片放入参考图，不同时指定首帧");
      if (!request.images?.length || request.images.length > 15) throw new Error("Vidu 参考生视频须使用 1–15 张图片");
      if ((request.audios?.length ?? 0) > 3) throw new Error("Vidu 最多使用 3 段参考音频");
    } else {
      if (!request.firstFrame) throw new Error("请选择视频首帧");
      if (request.images?.length || request.audios?.length) throw new Error("图生视频只接受一张首帧，多图或音频请使用参考生视频模式");
    }
    if (request.negativePrompt || request.cameraTrajectory) throw new Error("Vidu 当前接口不支持负面提示词或相机轨迹");
    const duration = request.duration ?? 5;
    if (!Number.isInteger(duration) || duration < 3 || duration > 16) throw new Error("Vidu 视频时长须为 3–16 秒的整数");
    const resolution = (request.resolution ?? "720P").toUpperCase();
    if (!["540P", "720P", "1080P", "2K", "4K"].includes(resolution)) throw new Error("不支持此 Vidu 视频分辨率");
    if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || request.seed < 0)) throw new Error("Vidu 随机种子须为非负整数");
    const ratio = request.ratio ?? "16:9";
    if (referenceMode && !["16:9", "9:16", "1:1", "4:3", "3:4"].includes(ratio)) throw new Error("不支持此 Vidu 参考生视频画幅");
    const body = JSON.stringify({
      model: request.model, prompt: request.prompt,
      images: (referenceMode ? request.images! : [request.firstFrame!]).map(input => mediaValue(input, "image")),
      duration, resolution: resolution.endsWith("P") ? resolution.toLowerCase() : resolution,
      audio: request.generateAudio ?? true, watermark: request.watermark ?? false,
      ...(referenceMode ? { aspect_ratio: ratio, ...(request.audios?.length ? { sounds: request.audios.map(input => mediaValue(input, "audio")) } : {}) } : { is_rec: false }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    });
    if (Buffer.byteLength(body) >= 20 * 1024 * 1024) throw new Error("Vidu 请求体须小于 20 MB，请压缩首帧或使用公开图片地址");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const authorization = referenceMode ? "Bearer" : "Token";
    const task = await fetchJson(this, referenceMode ? "/reference2video" : "/img2video", signal, authorization, body);
    const taskId = task.task_id ?? task.id;
    if (typeof taskId !== "string" || !taskId.trim()) throw new Error(this.tool.errorMessage(task) || "Vidu 未返回任务 ID");
    while (true) {
      const result = await fetchJson(this, `/tasks/${encodeURIComponent(taskId)}/creations`, signal, authorization);
      if (result.state === "success") {
        if (!Array.isArray(result.creations) || !result.creations.length) throw new Error("Vidu 未返回生成结果");
        return result.creations.map((item: any): MediaAsset => {
          if (typeof item?.url !== "string" || !/^https?:\/\//i.test(item.url)) throw new Error("Vidu 未返回有效视频地址");
          return { mediaType: "video", type: "url", url: item.url };
        });
      }
      if (!["created", "queueing", "processing"].includes(result.state)) throw new Error(this.tool.errorMessage(result.err_code || result) || "Vidu 任务失败或状态无效");
      await wait(signal);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
