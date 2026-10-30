const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://www.token01.net/v1" },
] as const;

async function request(context: ProviderContext, path: string, signal: AbortSignal, body?: object) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  const baseUrl = String(context.config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!key || !baseUrl) throw new Error("请填写 Token01 API Key 和地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET", signal, redirect: "error",
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Token01 请求失败（HTTP ${response.status}）`);
  return response;
}

async function json(context: ProviderContext, path: string, signal: AbortSignal, body?: object) {
  const result = await (await request(context, path, signal, body)).json() as Record<string, any>;
  if (!result || typeof result !== "object" || result.error || (result.code !== undefined && result.code !== "success" && result.code !== 200)) throw new Error(context.tool.errorMessage(result) || "Token01 响应错误");
  return result;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 10000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function resumeMedia(this: ProviderContext, task: MediaTask & { id: string }): Promise<MediaAsset[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  while (true) {
    const result = await json(this, `/video/generations/${encodeURIComponent(task.id)}`, signal);
    const data = result.data;
    const status = String(data?.status ?? "").toUpperCase();
    await this.tool.reportTask?.({ id: task.id, status });
    if (status === "FAILURE") throw Object.assign(new Error(this.tool.errorMessage(data) || "Token01 视频生成失败"), { retryable: false, fallbackAllowed: false });
    if (status === "SUCCESS") {
      const baseUrl = String(this.config.baseUrl ?? "").trim().replace(/\/+$/, "");
      const expected = new URL(`${baseUrl}/videos/${encodeURIComponent(task.id)}/content`);
      let resultUrl: URL;
      try { resultUrl = new URL(data.result_url); } catch { throw new Error("Token01 未返回有效的视频地址"); }
      if (resultUrl.origin !== expected.origin || resultUrl.pathname !== expected.pathname) throw new Error("Token01 返回的视频地址与任务不匹配");
      const response = await request(this, `/videos/${encodeURIComponent(task.id)}/content`, signal);
      const limit = 100 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) throw new Error("视频文件超过大小限制");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Token01 未返回视频内容");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new Error("视频文件超过大小限制");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      if (!size) throw new Error("Token01 返回空视频");
      return [{ mediaType: "video", type: "binary", data: Buffer.concat(chunks, size), mimeType: "video/mp4" }];
    }
    if (!["NOT_START", "SUBMITTED", "QUEUED", "IN_PROGRESS"].includes(status)) throw new Error(this.tool.errorMessage(data) || "Token01 视频任务状态无效");
    await wait(signal);
  }
}

export default {
  id: "token01", label: "Token01", version: "1.1.1", rules, resumeMedia,
  readme: "使用 Token01 令牌生成图片和视频。模型可用性以令牌分组为准。支持文生图、单图编辑及各模型支持的视频生成模式；参考素材需要可访问的公网中转地址。\n\n[图片文档](https://token01.apifox.cn/api-530538219) · [视频文档](https://token01.apifox.cn/api-530551459)",
  models: [
    {"id": "vidu-q2", "label": "vidu-q2", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "wan2.7-image", "label": "wan2.7-image", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "qwen-image-2.0-pro", "label": "qwen-image-2.0-pro", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "z-image-turbo", "label": "z-image-turbo", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "qwen-image-3.0", "label": "qwen-image-3.0", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "qwen-image-3.0-pro", "label": "qwen-image-3.0-pro", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "Doubao-Seedream-4.5", "label": "Doubao-Seedream-4.5", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["2K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "Doubao-Seedream-5.0-pro", "label": "Doubao-Seedream-5.0-pro", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["2K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "Doubao-Seedream-5.0-lite", "label": "Doubao-Seedream-5.0-lite", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["2K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "qwen-image-2.0", "label": "qwen-image-2.0", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "Kling-3.0-image", "label": "Kling-3.0-image", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["1K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "Doubao-Seedream-4.0", "label": "Doubao-Seedream-4.0", "type": "image", "mode": ["text", "singleImage"], "imageSizes": ["2K"], "imageRatios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]},
    {"id": "MiniMax-H3-Lite", "label": "MiniMax-H3-Lite", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:9"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["480P", "768P"]}]},
    {"id": "MiniMax-H3-Max", "label": "MiniMax-H3-Max", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:9"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["480P", "768P"]}]},
    {"id": "MiniMax-H3", "label": "MiniMax-H3", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:9"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["768P", "2K"]}]},
    {"id": "MiniMax-H3-Highspeed", "label": "MiniMax-H3-Highspeed", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:9"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["768P"]}]},
    {"id": "MiniMax-H3-Fast", "label": "MiniMax-H3-Fast", "type": "video", "mode": ["text", "startEndRequired", ["imageReference:9"]], "durationResolutionMap": [{"duration": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["480P", "768P", "1088P", "1440P"]}]},
    {"id": "kling-3.0-video", "label": "kling-3.0-video", "type": "video", "mode": ["text", "singleImage", "endFrameOptional"], "durationResolutionMap": [{"duration": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["720P", "1080P", "4K"]}], "audio": "optional"},
    {"id": "kling-3.0-Omni", "label": "kling-3.0-Omni", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:7"]], "durationResolutionMap": [{"duration": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["720P", "1080P", "4K"]}], "audio": "optional"},
    {"id": "Doubao-Seedance-2.0", "label": "Doubao-Seedance-2.0", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:9"], ["imageReference:9", "videoReference:3", "audioReference:3"], ["videoReference:3"], ["audioReference:3"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["480P", "720P", "1080P", "4K"]}], "audio": "optional"},
    {"id": "Doubao-Seedance-2.0-fast", "label": "Doubao-Seedance-2.0-fast", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:9"], ["imageReference:9", "videoReference:3", "audioReference:3"], ["videoReference:3"], ["audioReference:3"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["480P", "720P"]}], "audio": "optional"},
    {"id": "Doubao-Seedance-2.0-mini", "label": "Doubao-Seedance-2.0-mini", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:9"], ["imageReference:9", "videoReference:3", "audioReference:3"], ["videoReference:3"], ["audioReference:3"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["480P", "720P"]}], "audio": "optional"},
    {"id": "Doubao-Seedance-2.5", "label": "Doubao-Seedance-2.5", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:30"], ["imageReference:30", "videoReference:10", "audioReference:10"], ["videoReference:10"], ["audioReference:10"]], "durationResolutionMap": [{"duration": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], "resolution": ["480P", "720P", "1080P"]}], "audio": "optional"},
    {"id": "wan3.0-video", "label": "wan3.0-video", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:10"], ["imageReference:10", "videoReference:5", "audioReference:5"], ["videoReference:5"], ["audioReference:5"]], "durationResolutionMap": [{"duration": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], "resolution": ["480P", "720P", "1080P"]}], "audio": "optional"},
    {"id": "wan3.0-video-prime", "label": "wan3.0-video-prime", "type": "video", "mode": ["text", "singleImage", "endFrameOptional", ["imageReference:10"], ["imageReference:10", "videoReference:5", "audioReference:5"], ["videoReference:5"], ["audioReference:5"]], "durationResolutionMap": [{"duration": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], "resolution": ["480P", "720P", "1080P"]}], "audio": "optional"},
    {"id": "happyhorse-1.1-t2v", "label": "happyhorse-1.1-t2v", "type": "video", "mode": ["text"], "durationResolutionMap": [{"duration": [5], "resolution": ["480P", "720P", "1080P"]}]},
    {"id": "happyhorse-1.1-i2v", "label": "happyhorse-1.1-i2v", "type": "video", "mode": ["singleImage"], "durationResolutionMap": [{"duration": [5], "resolution": ["480P", "720P", "1080P"]}]},
    {"id": "happyhorse-1.1-r2v", "label": "happyhorse-1.1-r2v", "type": "video", "mode": [["imageReference:9"]], "durationResolutionMap": [{"duration": [5], "resolution": ["480P", "720P", "1080P"]}]},
    {"id": "happyhorse-1.0-video-edit", "label": "happyhorse-1.0-video-edit", "type": "video", "mode": [["videoReference:1"]], "durationResolutionMap": [{"duration": [5], "resolution": ["720P", "1080P"]}]},
    {"id": "vidu-q3-ad", "label": "vidu-q3-ad", "type": "video", "mode": [["imageReference:7"]], "durationResolutionMap": [{"duration": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["720P", "1080P"]}]},
    {"id": "vidu-q3-drama", "label": "vidu-q3-drama", "type": "video", "mode": [["imageReference:7"]], "durationResolutionMap": [{"duration": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "resolution": ["720P", "1080P"]}]},
    {"id": "vidu-q3-pro", "label": "vidu-q3-pro", "type": "video", "mode": ["singleImage"], "durationResolutionMap": [{"duration": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], "resolution": ["540P", "720P", "1080P"]}], "audio": "optional"},
    {"id": "vidu-q3-turbo", "label": "vidu-q3-turbo", "type": "video", "mode": ["singleImage"], "durationResolutionMap": [{"duration": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], "resolution": ["540P", "720P", "1080P"]}], "audio": "optional"},
    {"id": "vidu-q3-pro-fast", "label": "vidu-q3-pro-fast", "type": "video", "mode": ["singleImage"], "durationResolutionMap": [{"duration": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], "resolution": ["720P", "1080P"]}], "audio": "optional"},
  ] satisfies ProviderModel[],
  async generateImage(input: ImageRequest): Promise<MediaAsset[]> {
    const model = this.models?.find(item => item.id === input.model && item.type === "image");
    if (!model) throw new Error("此 Token01 图片模型尚未适配");
    if (!input.prompt.trim()) throw new Error("请填写提示词");
    if ((input.images?.length ?? 0) > 1 || input.mask || input.negativePrompt || input.seed !== undefined || input.quality || input.outputFormat || input.other && Object.keys(input.other).length || input.n !== undefined && input.n !== 1) throw new Error("图片接口每次生成一张，最多支持一张参考图；不支持蒙版和其他参数");
    const sizes: Record<string, [string, string]> = {
      "1:1": ["1024x1024", "2048x2048"], "16:9": ["1360x768", "2848x1600"], "9:16": ["768x1360", "1600x2848"],
      "4:3": ["1184x896", "2304x1728"], "3:4": ["896x1184", "1728x2304"], "3:2": ["1248x832", "2496x1664"], "2:3": ["832x1248", "1664x2496"],
    };
    const tier = input.size || model.imageSizes?.[0] || "1K";
    const size = sizes[input.ratio || "1:1"]?.[tier === "2K" ? 1 : 0];
    if (!size || !model.imageSizes?.includes(tier) || !model.imageRatios?.includes(input.ratio || "1:1")) throw new Error("不支持此图片尺寸或画幅");
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const image = input.images?.[0] ? await this.tool.relayMedia(input.images[0]) : undefined;
    const result = await json(this, "/images/generations", signal, { model: input.model, prompt: input.prompt, size, n: 1, ...(image ? { image } : {}) });
    if (!Array.isArray(result.data) || !result.data.length) throw new Error("Token01 未返回图片");
    return result.data.map((item: any): MediaAsset => {
      if (typeof item?.url === "string" && /^https?:\/\//i.test(item.url)) return { mediaType: "image", type: "url", url: item.url };
      if (typeof item?.b64_json === "string" && item.b64_json) return { mediaType: "image", type: "base64", data: item.b64_json, mimeType: "image/png" };
      throw new Error("Token01 未返回有效图片");
    });
  },
  async generateVideo(input: VideoRequest): Promise<MediaAsset[]> {
    const model = this.models?.find(item => item.id === input.model && item.type === "video");
    if (!model) throw new Error("此 Token01 视频模型尚未适配");
    if (!input.prompt.trim()) throw new Error("请填写提示词");
    if (input.seed !== undefined || input.cameraTrajectory || input.imageAndCameraOnly || input.other && Object.keys(input.other).length) throw new Error("此视频适配不支持种子、相机轨迹或其他额外参数");
    let firstFrame = input.firstFrame;
    let images = input.images ?? [];
    const videos = input.videos ?? [];
    const audios = input.audios ?? [];
    if (input.mode === "singleImage" && !firstFrame && images.length === 1) { firstFrame = images[0]; images = []; }
    const reference = images.length > 0 || videos.length > 0 || audios.length > 0;
    if (reference && (firstFrame || input.lastFrame) || input.lastFrame && !firstFrame) throw new Error("首尾帧不能与参考素材混用，尾帧须搭配首帧");
    const mode = reference ? (images.length ? "imageReference" : videos.length ? "videoReference" : "audioReference") : input.lastFrame ? "endFrameOptional" : firstFrame ? "singleImage" : "text";
    const supported = model.mode?.some(item => Array.isArray(item) ? item.some(value => value.startsWith(mode + ":")) : item === mode || mode === "endFrameOptional" && item === "startEndRequired");
    if (!supported || input.mode === "text" && mode !== "text" || input.mode === "singleImage" && mode !== "singleImage" || input.mode === "startEndRequired" && mode !== "endFrameOptional" || Array.isArray(input.mode) && !reference) throw new Error("所选模型不支持此素材组合");
    if (reference) {
      const allowed = model.mode?.filter(Array.isArray).flat() ?? [];
      const maxImages = Number(allowed.find(item => item.startsWith("imageReference:"))?.split(":")[1] ?? 0);
      const maxVideos = Number(allowed.find(item => item.startsWith("videoReference:"))?.split(":")[1] ?? 0);
      const maxAudios = Number(allowed.find(item => item.startsWith("audioReference:"))?.split(":")[1] ?? 0);
      if (images.length > maxImages || videos.length > maxVideos || audios.length > maxAudios) throw new Error("参考素材数量或类型超出此模型当前支持范围");
      if (input.model === "happyhorse-1.0-video-edit" && videos.length !== 1) throw new Error("视频编辑需要一段参考视频");
    }
    const duration = input.duration ?? 5;
    const resolution = (input.resolution || model.durationResolutionMap?.[0]?.resolution[0] || "720P").toUpperCase();
    if (!model.durationResolutionMap?.some(row => row.duration.includes(duration) && row.resolution.includes(resolution))) throw new Error("不支持此视频时长与分辨率组合");
    const seedance = input.model.startsWith("Doubao-Seedance-");
    const minimax = input.model.startsWith("MiniMax-H3");
    const workflow = input.model === "MiniMax-H3-Fast";
    const kling = input.model.startsWith("kling-");
    const wan = input.model.startsWith("wan3.");
    const vidu = input.model.startsWith("vidu-");
    const edit = input.model === "happyhorse-1.0-video-edit";
    const ratio = input.ratio || "16:9";
    if ((kling || workflow) && !["16:9", "9:16", "1:1"].includes(ratio) || wan && !["16:9", "9:16", "1:1", "4:3", "3:4"].includes(ratio) || (seedance || minimax) && !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(ratio)) throw new Error("不支持此视频画幅");
    if (input.generateAudio && !model.audio) throw new Error("此模型未声明支持生成音频");
    if (input.watermark !== undefined && (workflow || !seedance && !minimax && !kling && !wan)) throw new Error("此模型不支持水印设置");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const urls = await Promise.all([firstFrame, input.lastFrame, ...images, ...videos, ...audios].map(item => item ? this.tool.relayMedia(item) : undefined));
    const [first, last, ...refs] = urls;
    const imageUrls = refs.slice(0, images.length);
    const videoUrls = refs.slice(images.length, images.length + videos.length);
    const audioUrls = refs.slice(images.length + videos.length);
    const parameters = kling ? { aspect_ratio: ratio, audio: input.generateAudio ?? false, ...(input.watermark !== undefined ? { watermark: input.watermark } : {}) }
      : wan ? { ratio, audio: input.generateAudio ?? true, ...(input.watermark !== undefined ? { watermark: input.watermark } : {}) }
      : minimax ? { ratio, ...(input.watermark !== undefined ? { watermark: input.watermark } : {}) }
      : vidu ? { ...(model.audio ? { audio: input.generateAudio ?? false } : {}) }
      : edit ? {} : { ratio };
    const body = {
      model: input.model, prompt: [input.prompt, input.negativePrompt ? `画面中不得出现：${input.negativePrompt}` : ""].filter(Boolean).join("\n"), ...(!edit ? { duration } : {}),
      ...(workflow ? { resolution: resolution.toLowerCase(), ratio } : { size: kling ? ({ "720P": "std", "1080P": "pro", "4K": "4k" } as Record<string, string>)[resolution] : resolution.toLowerCase() }),
      ...(first ? { first_frame_url: first } : {}), ...(last ? { last_frame_url: last } : {}),
      ...(imageUrls.length ? { reference_images: imageUrls } : {}), ...(videoUrls.length ? { video_urls: videoUrls } : {}), ...(audioUrls.length ? { audio_urls: audioUrls } : {}),
      ...(!workflow ? { metadata: seedance ? { ratio, generate_audio: input.generateAudio ?? false, ...(input.watermark !== undefined ? { watermark: input.watermark } : {}) } : { parameters } } : {}),
    };
    const result = await json(this, "/video/generations", signal, body);
    const id = result.task_id ?? result.id;
    if (typeof id !== "string" || !id) throw new Error("Token01 未返回视频任务 ID");
    await this.tool.reportTask?.({ id, status: "submitted", mediaType: "video" });
    return resumeMedia.call(this, { id, status: "submitted", mediaType: "video" });
  },
} satisfies ProviderDefinition<typeof rules>;
