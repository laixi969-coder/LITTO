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
  // Vidu 的 sounds 协议要求 video/mp3，宿主仍使用标准的 audio/mpeg。
  return `data:${kind === "audio" ? "video/mp3" : input.mimeType};base64,${data}`;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, authorization: "Token" | "Bearer", body?: string) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^(?:Token|Bearer)\s+/i, "");
  if (!key) throw new Error("请填写 Vidu API Key");
  const baseUrl = (String(context.config.baseUrl ?? "").trim() || "https://api.vidu.cn").replace(/\/+$/, "");
  const response = await context.tool.fetch(`${baseUrl}/ent/v2${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { Authorization: `${authorization} ${key}`, "Content-Type": "application/json" }, body,
  });
  if (!response.ok) throw Object.assign(new Error(`Vidu 请求失败（HTTP ${response.status}）`), { status: response.status });
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

async function resumeMedia(this: ProviderContext, task: MediaTask & { id: string }): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  const taskId = task.id;
  const authorization = task.operation === "reference2video" || Array.isArray(task.mode) ? "Bearer" : "Token";
  while (true) {
    const result = await fetchJson(this, `/tasks/${encodeURIComponent(taskId)}/creations`, signal, authorization);
    await this.tool.reportTask?.({ id: taskId, status: String(result.state ?? "unknown") });
    if (["failed", "failure", "cancelled", "canceled", "rejected", "error"].includes(String(result.state).toLowerCase())) {
      await this.tool.reportTask?.({ id: task.id, status: "failed" });
      throw Object.assign(new Error(this.tool.errorMessage(result) || "供应商原任务失败"), { retryable: false, fallbackAllowed: false });
    }
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
}

export default {
  resumeMedia,
  id: "vidu", label: "Vidu", version: "1.1.5", rules,
  readme: "Vidu Q4 Preview 支持图生视频和参考生视频。图生视频使用一张首帧，画幅跟随首帧；参考生视频使用 1–15 张图片，可附加 0–3 段 MP3 参考音频（每段 3–12 秒），画幅可选 16:9、9:16、1:1、4:3、3:4。两种模式均支持 3–16 秒、540P / 720P / 1080P / 2K / 4K，可选音画同出。提示词可按输入顺序使用“参考图1”“参考音频1”指定素材。只需填写 API Key，API 地址默认使用官方地址；中转须兼容 Vidu 协议。\n\n[图生视频文档](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q4-preview/image-to-video) · [参考生视频文档](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q4-preview/reference-to-video)",
  models: [
    { id: "viduq4-preview", label: "Vidu Q4 Preview", type: "video", mode: ["singleImage", ["imageReference:15", "audioReference:3"]], audio: "optional", durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540P", "720P", "1080P", "2K", "4K"] }] },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (request.model !== "viduq4-preview") throw new Error("当前 Vidu 接入支持 viduq4-preview");
    // 画布单图模式使用 images，接口工具也允许 firstFrame；统一成实际首帧，避免已连图仍报缺图。
    if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
    // Vidu 没有独立负面词字段。「Avoid the following: 中文」对中文模型约束很弱，
    // 改成中文否定清单并前置到正文之前，模型才会把它当画面要求而不是附注。
    const avoid = request.negativePrompt?.trim();
    const prompt = [avoid ? `画面中不得出现：${avoid}。` : "", request.prompt].filter(Boolean).join("\n\n");
    if (prompt.length > 20000) throw new Error("Vidu 提示词（含排除要求）不能超过 20000 字");
    const referenceMode = Array.isArray(request.mode) || (request.mode === undefined && !!request.images?.length);
    if (Array.isArray(request.mode)) {
      // mode 里的 imageReference:N 是模型声明的上限，不是本次实际张数；实际张数以 images 为准。
      // 旧实现要求必须等于 imageReference:15，等于让参考生视频除传满 15 张外全部不可用。
      const imageModes = request.mode.filter(mode => /^imageReference:/.test(mode));
      const others = request.mode.filter(mode => !/^(imageReference|audioReference):/.test(mode));
      if (imageModes.length !== 1 || others.length) throw new Error("不支持此 Vidu 参考模式");
      const declared = Number(imageModes[0].split(":")[1]);
      if (!Number.isInteger(declared) || declared < 1 || declared > 15) throw new Error("Vidu 参考图上限为 15 张");
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
    if (request.cameraTrajectory) throw new Error("Vidu 当前接口不支持数值相机轨迹");
    const duration = request.duration ?? 5;
    if (!Number.isInteger(duration) || duration < 3 || duration > 16) throw new Error("Vidu 视频时长须为 3–16 秒的整数");
    const resolution = (request.resolution ?? "720P").toUpperCase();
    if (!["540P", "720P", "1080P", "2K", "4K"].includes(resolution)) throw new Error("不支持此 Vidu 视频分辨率");
    if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || request.seed < 0)) throw new Error("Vidu 随机种子须为非负整数");
    const ratio = request.ratio ?? "16:9";
    if (referenceMode && !["16:9", "9:16", "1:1", "4:3", "3:4"].includes(ratio)) throw new Error("不支持此 Vidu 参考生视频画幅");
    if (!referenceMode && request.ratio) await this.tool.assertAspectRatio(request.firstFrame!, request.ratio);
    const body = JSON.stringify({
      model: request.model, prompt,
      images: (referenceMode ? request.images! : [request.firstFrame!]).map(input => mediaValue(input, "image")),
      duration, resolution: resolution.endsWith("P") ? resolution.toLowerCase() : resolution,
      audio: request.generateAudio ?? true, watermark: request.watermark ?? false,
      ...(referenceMode ? { aspect_ratio: ratio, ...(request.audios?.length ? { sounds: request.audios.map(input => mediaValue(input, "audio")) } : {}) } : { is_rec: false }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    });
    if (Buffer.byteLength(body) >= 20 * 1024 * 1024) throw new Error("Vidu 请求体须小于 20 MB，请压缩首帧或使用公开图片地址");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const authorization = referenceMode ? "Bearer" : "Token";
    await this.tool.reportTask?.({ status: "submitting" });
    let task;
    try {
      task = await fetchJson(this, referenceMode ? "/reference2video" : "/img2video", signal, authorization, body);
    } catch (error) {
      const rejected = [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(Number((error as { status?: number }).status));
      await this.tool.reportTask?.({ status: rejected ? "rejected" : "unknown" });
      throw error;
    }
    const taskId = task.task_id ?? task.id;
    if (typeof taskId !== "string" || !taskId.trim()) throw new Error(this.tool.errorMessage(task) || "Vidu 未返回任务 ID");
    await this.tool.reportTask?.({ id: taskId, status: "submitted", mediaType: "video", operation: referenceMode ? "reference2video" : "img2video", mode: request.mode });
    return resumeMedia.call(this, { id: taskId, status: "submitted", mediaType: "video", operation: referenceMode ? "reference2video" : "img2video", mode: request.mode });
  },
} satisfies ProviderDefinition<typeof rules>;
