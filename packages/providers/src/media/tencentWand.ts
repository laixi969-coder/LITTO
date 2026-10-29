const rules = [
  { type: "input", field: "apiKey" as const, title: "TokenHub API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://tokenhub.tencentmaas.com" },
] as const;

const sizes: Record<string, string[]> = {
  "1:1": ["1024x1024", "2048x2048", "4096x4096"], "2:3": ["1024x1536", "1440x2160", "3328x4992"],
  "3:2": ["1536x1024", "2160x1440", "4992x3328"], "3:4": ["1080x1440", "1440x1920", "3584x4800"],
  "4:3": ["1440x1080", "1920x1440", "4800x3584"], "9:16": ["720x1280", "1440x2560", "2160x3840"],
  "16:9": ["1280x720", "2560x1440", "3840x2160"], "21:9": ["1512x648", "2520x1080", "5040x2160"],
};
const klingModels = ["kling-video-v4", "kling-video-v3", "kling-video-v3-turbo", "kling-video-v2.6", "kling-video-v2.5-turbo", "kling-video-v3-omni", "kling-video-o1"];
const viduModels = ["vidu-video-q4-preview", "vidu-video-q3", "vidu-video-q3-pro", "vidu-video-q3-turbo", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"];
const minimaxV1Models = ["minimax-video-v2.3", "minimax-video-v2.3-fast"];

async function imageUrl(context: ProviderContext, input: MediaInput) {
  if (input.type === "url" && !/^https?:\/\//i.test(input.url)) throw new Error("腾讯 WAND 图片地址须为 HTTP 或 HTTPS");
  return context.tool.relayImage(input);
}

function mediaValue(input: MediaInput) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("腾讯 WAND 素材地址须为 HTTP 或 HTTPS");
    return input.url;
  }
  return `data:${input.mimeType};base64,${input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data.replace(/^data:[^,]+,/, "")}`;
}

async function fetchJson(context: ProviderContext, path: string, signal: AbortSignal, body?: object) {
  const key = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请填写腾讯 TokenHub API Key");
  const baseUrl = (String(context.config.baseUrl ?? "").trim() || "https://tokenhub.tencentmaas.com").replace(/\/+$/, "");
  const response = await context.tool.fetch(`${baseUrl}/v1/wand/${path}`, {
    method: body ? "POST" : "GET", signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw Object.assign(new Error(context.tool.errorMessage(result) || `腾讯 WAND 请求失败（HTTP ${response.status}）`), { status: response.status });
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
  if (task.mediaType !== "image" && task.mediaType !== "video") throw new Error("腾讯 WAND 任务类型无效");
  const kind = task.mediaType;
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  while (true) {
    if (task.mediaType === "video" && minimaxV1Models.includes(task.model ?? "")) {
      const result = await fetchJson(this, `minimax-video/tasks/${encodeURIComponent(task.id)}`, signal);
      const status = String(result.status ?? "").toLowerCase();
      await this.tool.reportTask?.({ id: task.id, status });
      if (status === "fail") throw Object.assign(new Error(this.tool.errorMessage(result.base_resp?.status_msg) || "MiniMax 视频任务失败"), { retryable: false, fallbackAllowed: false });
      if (status === "success") {
        const url = result.content?.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("MiniMax 未返回有效视频地址");
        return [{ mediaType: "video", type: "url", url }];
      }
      if (!["preparing", "queueing", "processing"].includes(status)) throw new Error("MiniMax 视频任务状态无效");
      await wait(signal);
      continue;
    }
    if (task.mediaType === "video" && task.model?.startsWith("pixverse-video-")) {
      const result = await fetchJson(this, `pixverse/tasks/${encodeURIComponent(task.id)}`, signal);
      if (result.ErrCode !== 0) throw new Error(this.tool.errorMessage(result.ErrMsg) || "TokenHub PixVerse 查询失败");
      const status = result.Resp?.status;
      await this.tool.reportTask?.({ id: task.id, status: String(status) });
      if ([6, 7, 8].includes(status)) throw Object.assign(new Error(this.tool.errorMessage(result.ErrMsg) || `PixVerse 视频任务失败（状态 ${status}）`), { retryable: false, fallbackAllowed: false });
      if (status === 1) {
        const url = result.Resp?.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("PixVerse 未返回有效视频地址");
        return [{ mediaType: "video", type: "url", url }];
      }
      if (status !== 5) throw new Error("PixVerse 视频任务状态无效");
      await wait(signal);
      continue;
    }
    if (task.mediaType === "video" && (klingModels.includes(task.model ?? "") || task.model === "minimax-video-h3-max" || task.model === "minimax-video-h3" || task.model === "hy-video-v1.5" || viduModels.includes(task.model ?? ""))) {
      const kling = klingModels.includes(task.model ?? "");
      const hy = task.model === "hy-video-v1.5";
      const vidu = viduModels.includes(task.model ?? "");
      const result = await fetchJson(this, `${kling ? "kling" : hy ? "hunyuan-video" : vidu ? "vidu" : "minimax-video-v2"}/tasks/${encodeURIComponent(task.id)}`, signal);
      if (kling && result.code !== 0) throw new Error(this.tool.errorMessage(result) || "TokenHub 可灵查询失败");
      const current = kling ? result.data?.find((item: any) => item.id === task.id) : hy || vidu ? result : result.task;
      const status = vidu ? current?.state : current?.status;
      if (!current || typeof status !== "string") throw new Error("TokenHub 视频任务状态无效");
      await this.tool.reportTask?.({ id: task.id, status });
      if (["failed", "cancelled"].includes(status)) throw Object.assign(new Error(this.tool.errorMessage(current) || "TokenHub 视频任务失败"), { retryable: false, fallbackAllowed: false });
      if (status === "succeeded" || vidu && status === "success") {
        const url = kling ? current.outputs?.find((item: any) => item.type === "video")?.url : hy ? current.videos?.[0]?.url : vidu ? current.creations?.[0]?.url : current.content?.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("TokenHub 未返回有效视频地址");
        return [{ mediaType: "video", type: "url", url }];
      }
      if (!["queued", "running", "processing", "submitted", "created", "queueing"].includes(status)) throw new Error("TokenHub 视频任务状态无效");
      await wait(signal);
      continue;
    }
    const result = await fetchJson(this, `vega-${kind === "image" ? "images" : "videos"}/tasks/${encodeURIComponent(task.id)}`, signal);
    const status = String(result.status ?? "");
    await this.tool.reportTask?.({ id: task.id, status });
    if (["failed", "cancelled", "incomplete"].includes(status)) throw Object.assign(new Error(this.tool.errorMessage(result.error ?? result) || "腾讯 WAND 任务失败"), { retryable: false, fallbackAllowed: false });
    if (status === (kind === "image" ? "completed" : "succeeded")) {
      const urls = kind === "image" ? result.data?.map((item: any) => item?.url) : [result.content?.video_url];
      if (!Array.isArray(urls) || !urls.length || urls.some((url: unknown) => typeof url !== "string" || !/^https?:\/\//i.test(url))) throw new Error("腾讯 WAND 未返回有效结果地址");
      return urls.map((url: string) => ({ mediaType: kind, type: "url", url }));
    }
    if (!(kind === "image" ? ["queued", "in_progress"] : ["queued", "running"]).includes(status)) throw new Error("腾讯 WAND 任务状态无效");
    await wait(signal);
  }
}

async function submit(context: ProviderContext, kind: "image" | "video", body: object) {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  await context.tool.reportTask?.({ status: "submitting" });
  let result;
  try {
    result = await fetchJson(context, kind === "image" ? "vega-images/generations" : "vega-videos/tasks", signal, body);
  } catch (error) {
    const rejected = [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(Number((error as { status?: number }).status));
    await context.tool.reportTask?.({ status: rejected ? "rejected" : "unknown" });
    throw error;
  }
  const id = kind === "image" ? result.task_id : result.id;
  if (typeof id !== "string" || !id.trim()) throw new Error("腾讯 WAND 未返回任务 ID，请先检查任务状态，避免重复提交");
  const task = { id, status: "submitted", mediaType: kind } as const;
  await context.tool.reportTask?.(task);
  return resumeMedia.call(context, task);
}

async function submitTokenHubVideo(context: ProviderContext, model: string, path: string, body: object) {
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  await context.tool.reportTask?.({ status: "submitting" });
  let result;
  try { result = await fetchJson(context, path, signal, body); }
  catch (error) {
    const rejected = [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(Number((error as { status?: number }).status));
    await context.tool.reportTask?.({ status: rejected ? "rejected" : "unknown" });
    throw error;
  }
  if (klingModels.includes(model) && result.code !== 0) {
    await context.tool.reportTask?.({ status: "rejected" });
    throw Object.assign(new Error(context.tool.errorMessage(result) || "TokenHub 可灵请求失败"), { retryable: false, fallbackAllowed: false });
  }
  if (model.startsWith("pixverse-video-") && result.ErrCode !== 0) {
    await context.tool.reportTask?.({ status: "rejected" });
    throw Object.assign(new Error(context.tool.errorMessage(result.ErrMsg) || "TokenHub PixVerse 请求失败"), { retryable: false, fallbackAllowed: false });
  }
  if (minimaxV1Models.includes(model) && result.base_resp?.status_code !== 0) {
    await context.tool.reportTask?.({ status: "rejected" });
    throw Object.assign(new Error(context.tool.errorMessage(result.base_resp?.status_msg) || "MiniMax 视频请求失败"), { retryable: false, fallbackAllowed: false });
  }
  if (result.status === "failed" || result.state === "failed") {
    await context.tool.reportTask?.({ status: "rejected" });
    throw Object.assign(new Error(context.tool.errorMessage(result) || "TokenHub 视频请求失败"), { retryable: false, fallbackAllowed: false });
  }
  const id = klingModels.includes(model) ? result.data?.id : model.startsWith("pixverse-video-") ? String(result.Resp?.video_id ?? "") : result.task_id;
  if (typeof id !== "string" || !id.trim()) throw new Error("TokenHub 未返回任务 ID，请先检查任务状态，避免重复提交");
  const task = { id, status: "submitted", mediaType: "video", model } as const;
  await context.tool.reportTask?.(task);
  return resumeMedia.call(context, task);
}

function videoModel(id: string): ProviderModel | undefined {
  const versions = ["1.0-lite","1.5-lite","1.0-pro","1.0-pro-fast","1.0-pro-mini","1.5-pro"];
  const version = id.replace(/^wand-vega-video-/, "");
  if (!id.startsWith("wand-vega-video-") || !versions.includes(version)) return undefined;
  const start = version === "1.5-lite" ? 2 : 4;
  const end = version.startsWith("1.5-") ? 30 : 15;
  return { id, label: `Vega Video ${version.replace("-", " ")}`, type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:9", "audioReference:3"]], audio: "optional", durationResolutionMap: [{ duration: Array.from({ length: end - start + 1 }, (_, i) => start + i), resolution: version === "1.0-lite" ? ["480P", "768P", "1080P", "2K", "4K"] : ["480P", "720P", "1080P", "2K", "4K"] }] };
}

export default {
  id: "tencentWand", label: "腾讯 WAND · TokenHub", version: "1.9.0", rules,
  readme: "使用腾讯云 TokenHub 国内站 API Key。支持 Vega、Kling、MiniMax、混元视频、Vidu 及 PixVerse 的已接入模式；视频本地图片随请求传输。Vega 支持音画同出及图片、音频参考；图生图的本地图片通过临时链接中转，服务管理员需将 MILIMILI_PUBLIC_URL 设置为公网 HTTPS 地址。参考音频不保证声音或口型完全一致。\n\n[图片接口文档](https://cloud.tencent.com/document/product/1823/137203) · [视频接口文档](https://cloud.tencent.com/document/product/1823/135738)",
  models: [
    { id: "minimax-speech-2.8-hd", label: "MiniMax Speech 2.8 HD · 配音", type: "audio", voices: [{ title: "青涩男声", voice: "male-qn-qingse" }] },
    { id: "minimax-video-v2.3", label: "MiniMax Video V2.3", type: "video", mode: ["text", "singleImage", "endFrameOptional"], durationResolutionMap: [{ duration: [6, 10], resolution: ["768P"] }, { duration: [6], resolution: ["1080P"] }] },
    { id: "minimax-video-v2.3-fast", label: "MiniMax Video V2.3 Fast", type: "video", mode: ["singleImage"], durationResolutionMap: [{ duration: [6, 10], resolution: ["768P"] }, { duration: [6], resolution: ["1080P"] }] },
    { id: "kling-video-v3-omni", label: "Kling Video V3 Omni", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:7"]], audio: "optional", durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720P", "1080P", "4K"] }] },
    { id: "kling-video-o1", label: "Kling Video O1", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:7"]], durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10], resolution: ["720P", "1080P"] }] },
    { id: "vidu-video-q3", label: "Vidu Q3", type: "video", mode: [["imageReference:3"]], audio: "optional", durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540P", "720P", "1080P"] }] },
    { id: "vidu-video-q3-pro", label: "Vidu Q3 Pro", type: "video", mode: ["text", "singleImage", "startEndRequired"], audio: "optional", durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540P", "720P", "1080P"] }] },
    { id: "vidu-video-q3-turbo", label: "Vidu Q3 Turbo", type: "video", mode: ["text", "singleImage", "startEndRequired", ["imageReference:3"]], audio: "optional", durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540P", "720P", "1080P"] }] },
    { id: "vidu-video-q2", label: "Vidu Q2", type: "video", mode: ["text", ["imageReference:3"]], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["540P", "720P", "1080P"] }] },
    { id: "vidu-video-q2-pro", label: "Vidu Q2 Pro", type: "video", mode: ["singleImage", "startEndRequired", ["imageReference:3"]], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["540P", "720P", "1080P"] }] },
    { id: "vidu-video-q2-turbo", label: "Vidu Q2 Turbo", type: "video", mode: ["singleImage", "startEndRequired"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["540P", "720P", "1080P"] }] },
    { id: "kling-video-v3", label: "Kling Video V3", type: "video", mode: ["text", "singleImage", "endFrameOptional"], audio: "optional", durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720P", "1080P", "4K"] }] },
    { id: "kling-video-v3-turbo", label: "Kling Video V3 Turbo", type: "video", mode: ["text", "singleImage"], durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720P", "1080P"] }] },
    { id: "kling-video-v2.6", label: "Kling Video V2.6", type: "video", mode: ["text", "singleImage", "endFrameOptional"], audio: "optional", durationResolutionMap: [{ duration: [5, 10], resolution: ["720P", "1080P"] }] },
    { id: "kling-video-v2.5-turbo", label: "Kling Video V2.5 Turbo", type: "video", mode: ["text", "singleImage", "endFrameOptional"], durationResolutionMap: [{ duration: [5, 10], resolution: ["720P", "1080P"] }] },
    { id: "minimax-video-h3", label: "MiniMax Video H3", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:9", "audioReference:3"]], audio: true, nativeDialogue: true, durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "2K"] }] },
    { id: "pixverse-video-v6.0", label: "PixVerse V6", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:7"]], audio: "optional", nativeDialogue: true, durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["360P", "540P", "720P", "1080P"] }] },
    { id: "pixverse-video-c1", label: "PixVerse C1", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:7"]], audio: "optional", durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["360P", "540P", "720P", "1080P"] }] },
    { id: "pixverse-video-v5.6", label: "PixVerse V5.6", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:7"]], audio: "optional", nativeDialogue: true, durationResolutionMap: [{ duration: [5, 8, 10], resolution: ["360P", "540P", "720P"] }, { duration: [5, 8], resolution: ["1080P"] }] },
    { id: "vidu-video-q4-preview", label: "Vidu Q4 Preview", type: "video", mode: ["singleImage", ["imageReference:15", "audioReference:3"]], audio: "optional", nativeDialogue: true, durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540P", "720P", "1080P", "2K", "4K"] }] },
    { id: "hy-video-v1.5", label: "混元视频 1.5", type: "video", mode: ["text", "singleImage"], durationResolutionMap: [{ duration: [5], resolution: ["720P"] }] },
    { id: "kling-video-v4", label: "Kling Video V4", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:10"]], durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["720P", "1080P"] }] },
    { id: "minimax-video-h3-max", label: "MiniMax Video H3 Max", type: "video", mode: ["text", "singleImage", "endFrameOptional", ["imageReference:9", "audioReference:3"]], audio: true, nativeDialogue: true, durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P"] }] },
    { id: "wand-vega-image-lite", label: "Vega Image Lite", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] },
    { id: "wand-vega-image-flash", label: "Vega Image Flash", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] },
    { id: "wand-vega-image-pro", label: "Vega Image Pro", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] },
    { id: "wand-vega-image-1.5-pro", label: "Vega Image 1.5 Pro", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] },
    {"id":"wand-vega-video-1.0-lite","label":"Vega Video 1.0 lite","type":"video","mode":["text","singleImage","endFrameOptional",["imageReference:9","audioReference:3"]],"audio":"optional","durationResolutionMap":[{"duration":[4,5,6,7,8,9,10,11,12,13,14,15],"resolution":["480P","768P","1080P","2K","4K"]}]},
    {"id":"wand-vega-video-1.5-lite","label":"Vega Video 1.5 lite","type":"video","mode":["text","singleImage","endFrameOptional",["imageReference:9","audioReference:3"]],"audio":"optional","durationResolutionMap":[{"duration":[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"resolution":["480P","720P","1080P","2K","4K"]}]},
    {"id":"wand-vega-video-1.0-pro","label":"Vega Video 1.0 pro","type":"video","mode":["text","singleImage","endFrameOptional",["imageReference:9","audioReference:3"]],"audio":"optional","durationResolutionMap":[{"duration":[4,5,6,7,8,9,10,11,12,13,14,15],"resolution":["480P","720P","1080P","2K","4K"]}]},
    {"id":"wand-vega-video-1.0-pro-fast","label":"Vega Video 1.0 pro-fast","type":"video","mode":["text","singleImage","endFrameOptional",["imageReference:9","audioReference:3"]],"audio":"optional","durationResolutionMap":[{"duration":[4,5,6,7,8,9,10,11,12,13,14,15],"resolution":["480P","720P","1080P","2K","4K"]}]},
    {"id":"wand-vega-video-1.0-pro-mini","label":"Vega Video 1.0 pro-mini","type":"video","mode":["text","singleImage","endFrameOptional",["imageReference:9","audioReference:3"]],"audio":"optional","durationResolutionMap":[{"duration":[4,5,6,7,8,9,10,11,12,13,14,15],"resolution":["480P","720P","1080P","2K","4K"]}]},
    {"id":"wand-vega-video-1.5-pro","label":"Vega Video 1.5 pro","type":"video","mode":["text","singleImage","endFrameOptional",["imageReference:9","audioReference:3"]],"audio":"optional","durationResolutionMap":[{"duration":[4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"resolution":["480P","720P","1080P","2K","4K"]}]},

  ] satisfies ProviderModel[],
  async fetchModels(modelIds?: string[]): Promise<ProviderModel[]> {
    const key = String(this.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
    if (!key) throw new Error("请填写腾讯 TokenHub API Key");
    const baseUrl = (String(this.config.baseUrl ?? "").trim() || "https://tokenhub.tencentmaas.com").replace(/\/+$/, "");
    const response = await this.tool.fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: this.signal ?? AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) throw new Error(`获取腾讯 TokenHub 模型目录失败（HTTP ${response.status}）`);
    const result = await response.json() as { data?: { id?: unknown; name?: unknown; status?: unknown }[] };
    if (!Array.isArray(result.data)) throw new Error("腾讯 TokenHub 模型目录格式错误");
    // ACT: 目录不提供生成协议和参数，只有已适配的模型可导入；新协议需先适配。
    const imageLabels: Record<string, string> = { "wand-vega-image-lite": "Vega Image Lite", "wand-vega-image-flash": "Vega Image Flash", "wand-vega-image-pro": "Vega Image Pro", "wand-vega-image-1.5-pro": "Vega Image 1.5 Pro" };
    return result.data.flatMap<ProviderModel>(item => {
      if (!item || typeof item.id !== "string" || (modelIds && !modelIds.includes(item.id)) || (typeof item.status === "string" && !["online", "pre-offline"].includes(item.status))) return [];
      const label = typeof item.name === "string" && item.name.trim() ? item.name : imageLabels[item.id];
      if (item.id === "minimax-speech-2.8-hd") return [{ id: item.id, label: label || "MiniMax Speech 2.8 HD · 配音", type: "audio", voices: [{ title: "青涩男声", voice: "male-qn-qingse" }] }];
      if (Object.hasOwn(imageLabels, item.id)) return [{ id: item.id, label, type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: Object.keys(sizes) } satisfies ProviderModel];
      const video = videoModel(item.id);
      if (video) return [{ ...video, label: typeof item.name === "string" && item.name.trim() ? item.name : video.label }];
      const supported = this.models?.find(model => model.type === "video" && [...klingModels, ...viduModels, ...minimaxV1Models, "minimax-video-h3", "minimax-video-h3-max", "hy-video-v1.5", "pixverse-video-v6.0", "pixverse-video-v5.6", "pixverse-video-c1"].includes(model.id) && model.id === item.id);
      if (supported) return [{ ...supported, label: typeof item.name === "string" && item.name.trim() ? item.name : supported.label }];
      return [];
    });
  },
  resumeMedia,
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    if (request.model !== "minimax-speech-2.8-hd") throw new Error("此腾讯 TokenHub 语音模型尚未适配");
    if (!request.text.trim() || request.text.length >= 10000) throw new Error("配音文本须为 1 至 9999 个字符");
    if (request.audios?.length || request.instructions || Object.keys(request.audioParameters ?? {}).length || request.volume !== undefined && request.volume !== 0) throw new Error("此语音接口暂不支持参考音频、表演指令或音量增益");
    if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2)) throw new Error("语速须在 0.5 至 2 之间");
    const format = request.format ?? "mp3";
    if (!["mp3", "wav", "flac"].includes(format)) throw new Error("腾讯 MiniMax 配音支持 MP3、WAV 或 FLAC 格式");
    if (request.sampleRate !== undefined && ![8000, 16000, 22050, 24000, 32000, 44100].includes(request.sampleRate)) throw new Error("腾讯 MiniMax 配音采样率无效");
    const signal = AbortSignal.any([AbortSignal.timeout(180000), ...(this.signal ? [this.signal] : [])]);
    const result = await fetchJson(this, "minimax-tts/sync_tts", signal, { model: request.model, text: request.text, voice_setting: { voice_id: request.voice?.trim() || "male-qn-qingse", speed: request.speed ?? 1 }, audio_setting: { format, sample_rate: request.sampleRate ?? 32000 }, output_format: "url", stream: false });
    if (result.error || result.base_resp?.status_code !== 0) throw new Error(this.tool.errorMessage(result.error ?? result.base_resp?.status_msg) || "腾讯 MiniMax 语音合成失败");
    const url = result.data?.audio;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("腾讯 MiniMax 未返回有效音频地址");
    return [{ mediaType: "audio", type: "url", url }];
  },
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (!["wand-vega-image-lite", "wand-vega-image-flash", "wand-vega-image-pro", "wand-vega-image-1.5-pro"].includes(request.model)) throw new Error("不支持此腾讯 WAND 图片模型");
    if (request.mask || (request.images?.length ?? 0) > 10) throw new Error("腾讯 WAND 最多支持 10 张参考图，不支持蒙版");
    if (request.seed !== undefined || request.quality || request.outputFormat || (request.n !== undefined && request.n !== 1)) throw new Error("腾讯 WAND 当前不支持指定种子、画质、格式或多张输出");
    const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
    if (!prompt.trim() || prompt.length > 2000) throw new Error("腾讯 WAND 图片提示词须为 1–2000 字符");
    const ratio = request.ratio ?? "1:1";
    const index = ["1K", "2K", "4K"].indexOf((request.size ?? "1K").toUpperCase());
    if (!sizes[ratio] || index < 0) throw new Error("不支持此腾讯 WAND 图片尺寸或画幅");
    const images = [];
    for (const input of request.images ?? []) images.push({ type: "input_image", image_url: await imageUrl(this, input) });
    return submit(this, "image", { model: request.model, prompt, size: sizes[ratio]![index], ...(images.length ? { input: [{ content: images }] } : {}) });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (minimaxV1Models.includes(request.model)) {
      if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
      if (request.mode === undefined) request = { ...request, mode: request.lastFrame ? "endFrameOptional" : request.firstFrame ? "singleImage" : "text" };
      const model = this.models?.find(item => item.id === request.model);
      if (!model?.mode?.some(mode => JSON.stringify(mode) === JSON.stringify(request.mode)) || request.images?.length || request.videos?.length || request.audios?.length || request.mode === "text" && (request.firstFrame || request.lastFrame) || request.mode === "singleImage" && (!request.firstFrame || request.lastFrame) || request.mode === "endFrameOptional" && !request.firstFrame) throw new Error("MiniMax 输入与所选模式不匹配");
      if (request.seed !== undefined || request.cameraTrajectory || request.generateAudio !== undefined) throw new Error("MiniMax V2.3 不支持指定种子、相机轨迹或音频开关");
      const duration = request.duration ?? 6, resolution = (request.resolution ?? "768P").toUpperCase();
      if (!model.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution))) throw new Error("MiniMax V2.3 时长或分辨率无效");
      const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
      if (!prompt.trim() || prompt.length > 2000) throw new Error("MiniMax V2.3 提示词须为 1–2000 字符");
      return submitTokenHubVideo(this, request.model, "minimax-video/generation", { model: request.model, prompt, duration, resolution, ...(request.firstFrame ? { first_frame_image: mediaValue(request.firstFrame) } : {}), ...(request.lastFrame ? { last_frame_image: mediaValue(request.lastFrame) } : {}), ...(request.watermark === undefined ? {} : { aigc_watermark: request.watermark }) });
    }
    if (["kling-video-v3-omni", "kling-video-o1"].includes(request.model) || request.model === "kling-video-v4" && Array.isArray(request.mode)) {
      if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
      if (request.mode === undefined) request = { ...request, mode: request.lastFrame ? "endFrameOptional" : request.firstFrame ? "singleImage" : "text" };
      const model = this.models?.find(item => item.id === request.model);
      if (!model?.mode?.some(mode => JSON.stringify(mode) === JSON.stringify(request.mode))) throw new Error("可灵模型不支持所选模式");
      const referenceMode = Array.isArray(request.mode);
      if (request.videos?.length || request.audios?.length || referenceMode && (!request.images?.length || request.images.length > (request.model === "kling-video-v4" ? 10 : 7) || request.firstFrame || request.lastFrame) || !referenceMode && (request.images?.length || request.mode === "text" && (request.firstFrame || request.lastFrame) || request.mode === "singleImage" && (!request.firstFrame || request.lastFrame) || request.mode === "endFrameOptional" && !request.firstFrame)) throw new Error("可灵参考素材与所选模式不匹配");
      if (request.seed !== undefined || request.cameraTrajectory || request.generateAudio !== undefined && request.model !== "kling-video-v3-omni") throw new Error("此可灵模式不支持种子、相机轨迹或音频开关");
      const duration = request.duration ?? 5, resolution = (request.resolution ?? "720P").toUpperCase();
      if (!model.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution)) || request.model === "kling-video-o1" && request.firstFrame && !request.lastFrame && ![5, 10].includes(duration)) throw new Error("可灵此模式的时长或分辨率无效");
      const ratio = request.ratio ?? "16:9";
      if (!["16:9", "9:16", "1:1", ...(request.model === "kling-video-v4" ? ["21:9"] : [])].includes(ratio)) throw new Error("可灵不支持所选画幅");
      const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
      const contents = [{ type: "prompt", text: prompt }, ...(request.firstFrame ? [{ type: "first_frame", url: mediaValue(request.firstFrame) }] : []), ...(request.lastFrame ? [{ type: "last_frame", url: mediaValue(request.lastFrame) }] : []), ...(request.images ?? []).map(input => ({ type: "refer_image", url: mediaValue(input) }))];
      const settings = { duration, resolution: resolution.toLowerCase(), ...(!request.firstFrame ? { aspect_ratio: ratio } : {}), ...(request.model === "kling-video-v3-omni" && request.generateAudio !== undefined ? { audio: request.generateAudio ? "native" : "off" } : {}) };
      return submitTokenHubVideo(this, request.model, "kling/omni-video", { model: request.model, contents, settings });
    }
    if (["pixverse-video-v6.0", "pixverse-video-v5.6", "pixverse-video-c1"].includes(request.model)) {
      if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
      const referenceMode = Array.isArray(request.mode);
      if (referenceMode && (JSON.stringify(request.mode) !== JSON.stringify(["imageReference:7"]) || !request.images?.length || request.images.length > 7 || request.firstFrame || request.lastFrame)) throw new Error("PixVerse 参考模式需要 1–7 张图片");
      if (!referenceMode && (request.mode !== undefined && !["text", "singleImage", "endFrameOptional"].includes(String(request.mode)) || request.mode === "text" && request.firstFrame || ["singleImage", "endFrameOptional"].includes(String(request.mode)) && !request.firstFrame || request.lastFrame && !request.firstFrame || request.mode === "singleImage" && request.lastFrame || request.images?.length) || request.videos?.length || request.audios?.length) throw new Error("PixVerse 输入与所选模式不匹配");
      if (request.cameraTrajectory || request.watermark) throw new Error("PixVerse 当前不支持数值相机轨迹或水印设置");
      if (request.seed !== undefined && (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 2147483647)) throw new Error("PixVerse 种子须为 0 至 2147483647 的整数");
      const model = this.models?.find(item => item.id === request.model);
      const duration = request.duration ?? 5, resolution = (request.resolution ?? "720P").toUpperCase();
      if (!model?.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution))) throw new Error("PixVerse 时长或分辨率无效");
      const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
      if (!prompt.trim() || prompt.length > 5000) throw new Error("PixVerse 提示词须为 1–5000 字符");
      const ratio = request.ratio ?? "16:9";
      if (!request.firstFrame && !["16:9", "4:3", "1:1", "3:4", "9:16", ...(request.model === "pixverse-video-v5.6" ? [] : ["2:3", "3:2", "21:9"])].includes(ratio)) throw new Error("PixVerse 不支持所选画幅");
      const path = referenceMode ? "reference-to-video" : request.lastFrame ? "start-end-to-video" : request.firstFrame ? "image-to-video" : "text-to-video";
      const inputs = referenceMode ? { image_references: request.images!.map(input => ({ img_id: mediaValue(input), type: "subject" })), aspect_ratio: ratio } : request.lastFrame ? { first_frame_img: mediaValue(request.firstFrame!), last_frame_img: mediaValue(request.lastFrame) } : request.firstFrame ? { img_id: mediaValue(request.firstFrame) } : { aspect_ratio: ratio };
      return submitTokenHubVideo(this, request.model, `pixverse/${path}`, { model: request.model, prompt, duration, quality: resolution.toLowerCase(), ...inputs, ...(request.generateAudio === undefined ? {} : { generate_audio_switch: request.generateAudio }), ...(request.seed === undefined ? {} : { seed: request.seed }) });
    }
    if (viduModels.includes(request.model)) {
      if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
      if (request.mode === undefined) request = { ...request, mode: request.lastFrame ? "startEndRequired" : request.firstFrame ? "singleImage" : "text" };
      const model = this.models?.find(item => item.id === request.model);
      const referenceMode = Array.isArray(request.mode);
      if (!model?.mode?.some(mode => JSON.stringify(mode) === JSON.stringify(request.mode))) throw new Error("Vidu 模型不支持所选模式");
      if (request.videos?.length || request.audios?.length && request.model !== "vidu-video-q4-preview") throw new Error("此 Vidu 模式不支持该音视频参考");
      if (referenceMode && (!request.images?.length || request.images.length > (request.model === "vidu-video-q4-preview" ? 15 : 3) || request.firstFrame || request.lastFrame || (request.audios?.length ?? 0) > 3)) throw new Error("Vidu 参考素材数量无效");
      if (!referenceMode && (request.images?.length || request.audios?.length || request.mode === "text" && (request.firstFrame || request.lastFrame) || request.mode === "singleImage" && (!request.firstFrame || request.lastFrame) || request.mode === "startEndRequired" && (!request.firstFrame || !request.lastFrame))) throw new Error("Vidu 首尾帧与所选模式不匹配");
      if (request.cameraTrajectory) throw new Error("TokenHub Vidu 不支持数值相机轨迹");
      const duration = request.duration ?? 5;
      const resolution = (request.resolution ?? "720P").toUpperCase();
      if (!model.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution)) || referenceMode && request.model.startsWith("vidu-video-q3") && duration < 3 || request.model.startsWith("vidu-video-q2") && request.lastFrame && duration > 8) throw new Error("Vidu 此模式的时长或分辨率无效");
      const prompt = [request.negativePrompt ? `画面中不得出现：${request.negativePrompt}。` : "", request.prompt].filter(Boolean).join("\n");
      const audio = request.generateAudio ?? (request.model.startsWith("vidu-video-q3") || request.model === "vidu-video-q4-preview");
      if (request.generateAudio !== undefined && !model.audio) throw new Error("此 Vidu 模型未接入音画同出");
      const ratio = request.ratio ?? "16:9";
      if ((referenceMode || request.mode === "text") && !["16:9", "9:16", "3:4", "4:3", "1:1"].includes(ratio)) throw new Error("Vidu 不支持所选画幅");
      const images = referenceMode ? request.images! : [request.firstFrame, request.lastFrame].filter((item): item is MediaInput => !!item);
      const subjectMode = referenceMode && (request.model === "vidu-video-q4-preview" || request.model === "vidu-video-q3-turbo" && audio);
      const sounds = (request.audios ?? []).map(input => {
        if (input.type !== "url" && !["audio/mpeg", "audio/mp3"].includes(input.mimeType)) throw new Error("Vidu 参考音频须为 MP3");
        return mediaValue(input).replace(/^data:audio\/(?:mpeg|mp3);/, "data:video/mp3;");
      });
      const body = { model: request.model, ...(subjectMode ? { subjects: images.map((input, index) => ({ name: `reference${index + 1}`, images: [mediaValue(input)] })), ...(sounds.length ? { sounds } : {}) } : images.length ? { images: images.map(mediaValue) } : {}), prompt, duration, resolution: resolution.endsWith("P") ? resolution.toLowerCase() : resolution, ...(model.audio ? { audio, ...(audio ? { audio_type: "all" } : {}) } : {}), ...((referenceMode || request.mode === "text") ? { aspect_ratio: ratio } : {}), ...(request.seed === undefined ? {} : { seed: request.seed }), ...(request.watermark === undefined ? {} : { watermark: request.watermark }) };
      if (Buffer.byteLength(JSON.stringify(body)) >= 20 * 1024 * 1024) throw new Error("Vidu 请求体须小于 20 MB");
      return submitTokenHubVideo(this, request.model, `vidu/${referenceMode ? "reference-to-video" : request.mode === "text" ? "text-to-video" : request.lastFrame ? "start-end-to-video" : "image-to-video"}`, body);
    }
    if (request.model === "hy-video-v1.5") {
      if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
      if (request.mode !== undefined && !["text", "singleImage"].includes(String(request.mode)) || request.mode === "text" && request.firstFrame || request.mode === "singleImage" && !request.firstFrame || request.lastFrame || request.images?.length || request.videos?.length || request.audios?.length) throw new Error("混元视频仅支持文生视频或单张首帧图生视频");
      if (request.cameraTrajectory || request.generateAudio !== undefined || request.watermark) throw new Error("混元视频当前不支持相机轨迹、音频开关或水印设置");
      if ((request.duration ?? 5) !== 5 || (request.resolution ?? "720P").toUpperCase() !== "720P") throw new Error("混元视频仅支持 5 秒、720P");
      const ratio = request.ratio ?? "16:9";
      if (!request.firstFrame && !["16:9", "9:16", "1:1", "4:3", "3:4"].includes(ratio)) throw new Error("混元视频不支持所选画幅");
      if (!request.prompt.trim()) throw new Error("请输入视频提示词");
      if (request.firstFrame && request.firstFrame.type !== "url" && !["image/png", "image/jpeg", "image/jpg"].includes(request.firstFrame.mimeType)) throw new Error("混元视频首帧须为 PNG 或 JPEG");
      const image = request.firstFrame ? mediaValue(request.firstFrame) : undefined;
      return submitTokenHubVideo(this, request.model, "hunyuan-video/generation", { model: request.model, prompt: request.prompt, ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}), ...(image ? { [request.firstFrame?.type === "url" ? "image_url" : "image"]: image } : { aspect_ratio: ratio }), duration: 5, resolution: "720p", ...(request.seed === undefined ? {} : { seed: request.seed }) });
    }
    if (["minimax-video-h3", "minimax-video-h3-max"].includes(request.model) && Array.isArray(request.mode)) {
      if (JSON.stringify(request.mode) !== JSON.stringify(["imageReference:9", "audioReference:3"]) || !request.images?.length || request.images.length > 9 || (request.audios?.length ?? 0) > 3 || request.videos?.length || request.firstFrame || request.lastFrame) throw new Error("MiniMax 参考模式需要 1–9 张图片和最多 3 段音频");
      if (request.seed !== undefined || request.cameraTrajectory || request.generateAudio === false) throw new Error("MiniMax 参考模式不支持指定种子、相机轨迹或关闭原生音频");
      const model = this.models?.find(item => item.id === request.model);
      const duration = request.duration ?? 5, resolution = (request.resolution ?? "768P").toUpperCase();
      if (!model?.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution))) throw new Error("MiniMax 参考模式的时长或分辨率无效");
      const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
      const ratio = request.ratio ?? "16:9";
      if (!prompt.trim() || prompt.length > 7000 || !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error("MiniMax 提示词或画幅无效");
      let totalDuration = 0;
      for (const input of request.audios ?? []) {
        if (input.type === "url" || !["audio/mpeg", "audio/wav"].includes(input.mimeType)) throw new Error("MiniMax 参考音频须为工作区中的 MP3 或 WAV");
        const bytes = input.type === "binary" ? input.data.byteLength : Buffer.from(input.data.replace(/^data:[^,]+,/, ""), "base64").byteLength;
        if (!bytes || bytes > 15 * 1024 * 1024) throw new Error("MiniMax 参考音频不能超过 15 MB");
        const seconds = await this.tool.audioDuration(input);
        if (seconds < 1.9 || seconds > 15.1) throw new Error("MiniMax 参考音频须为 2–15 秒");
        totalDuration += seconds;
      }
      if (totalDuration > 15 + (request.audios?.length ?? 0) * 0.1) throw new Error("MiniMax 参考音频总时长不能超过 15 秒");
      const content = [{ type: "text", text: prompt }, ...request.images.map(input => ({ type: "image_url", image_url: { url: mediaValue(input) }, role: "reference_image" })), ...(request.audios ?? []).map(input => ({ type: "audio_url", audio_url: { url: mediaValue(input) }, role: "reference_audio" }))];
      const body = { model: request.model, content, duration, resolution, ratio };
      if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024) throw new Error("MiniMax 请求体不能超过 64 MB");
      return submitTokenHubVideo(this, request.model, "minimax-video-v2/generation", body);
    }
    if ([...klingModels, "minimax-video-h3", "minimax-video-h3-max"].includes(request.model)) {
      if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
      if (request.mode !== undefined && !["text", "singleImage", "endFrameOptional"].includes(String(request.mode))) throw new Error("当前 TokenHub 模型支持文生视频或首尾帧图生视频");
      if (request.images?.length || request.videos?.length || request.audios?.length) throw new Error("此模式不支持其他参考素材");
      if (request.mode === "text" && (request.firstFrame || request.lastFrame) || request.lastFrame && !request.firstFrame || ["singleImage", "endFrameOptional"].includes(String(request.mode)) && !request.firstFrame || request.mode === "singleImage" && request.lastFrame) throw new Error("请按所选模式提供首帧和尾帧");
      const kling = klingModels.includes(request.model);
      const supportsAudio = ["kling-video-v3", "kling-video-v2.6"].includes(request.model);
      if (request.seed !== undefined || request.cameraTrajectory || (kling ? request.generateAudio !== undefined && !supportsAudio : request.generateAudio === false)) throw new Error("此 TokenHub 模式不支持指定种子、相机轨迹或所选音频设置");
      if (request.model === "kling-video-v3-turbo" && request.lastFrame) throw new Error("Kling V3 Turbo 不支持尾帧");
      const model = this.models?.find(item => item.id === request.model);
      const duration = request.duration ?? 5;
      const resolution = (request.resolution ?? (kling ? "1080P" : "768P")).toUpperCase();
      if (!model?.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution))) throw new Error("此模型不支持所选时长或分辨率");
      if (request.model === "kling-video-v2.6" && (request.generateAudio === true && resolution !== "1080P" || request.lastFrame && resolution !== "720P")) throw new Error("Kling V2.6 有声音频须使用 1080P，首尾帧须使用 720P");
      if (request.model === "kling-video-v2.5-turbo" && request.lastFrame && resolution !== "1080P") throw new Error("Kling V2.5 Turbo 首尾帧须使用 1080P");
      const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
      if (!prompt.trim()) throw new Error("请输入视频提示词");
      const ratio = request.ratio ?? "16:9";
      if (kling) {
        if (!request.firstFrame && !["16:9", "9:16", "1:1", ...(request.model === "kling-video-v4" ? ["21:9"] : [])].includes(ratio)) throw new Error("此可灵模型不支持所选画幅");
        const settings = { duration, resolution: resolution.toLowerCase(), ...(!request.firstFrame ? { aspect_ratio: ratio } : {}), ...(supportsAudio && request.generateAudio !== undefined ? { audio: request.generateAudio ? "native" : "off" } : {}) };
        const options = request.watermark === undefined ? {} : { options: { watermark_info: { enabled: request.watermark } } };
        const body = request.firstFrame ? { model: request.model, contents: [{ type: "prompt", text: prompt }, { type: "first_frame", url: mediaValue(request.firstFrame) }, ...(request.lastFrame ? [{ type: "last_frame", url: mediaValue(request.lastFrame) }] : [])], settings, ...options } : { model: request.model, prompt, settings, ...options };
        return submitTokenHubVideo(this, request.model, `kling/${request.firstFrame ? "image-to-video" : "text-to-video"}`, body);
      }
      if (!request.firstFrame && !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error("此 MiniMax 模型不支持所选画幅");
      const content: object[] = [{ type: "text", text: prompt }];
      if (request.firstFrame) content.push({ type: "image_url", image_url: { url: mediaValue(request.firstFrame) }, role: "first_frame" });
      if (request.lastFrame) content.push({ type: "image_url", image_url: { url: mediaValue(request.lastFrame) }, role: "last_frame" });
      return submitTokenHubVideo(this, request.model, "minimax-video-v2/generation", { model: request.model, content, duration, resolution, ...(!request.firstFrame ? { ratio } : {}), ...(request.watermark !== undefined ? { aigc_watermark: request.watermark } : {}) });
    }
    const model = videoModel(request.model);
    if (!model) throw new Error("不支持此腾讯 WAND 视频模型");
    if (request.mode === "singleImage" && request.images?.length === 1 && !request.firstFrame) request = { ...request, firstFrame: request.images[0], images: [] };
    const referenceMode = Array.isArray(request.mode);
    if (referenceMode && JSON.stringify(request.mode) !== JSON.stringify(["imageReference:9", "audioReference:3"])) throw new Error("不支持此腾讯 WAND 参考模式");
    if (!referenceMode && request.mode !== undefined && !["text", "singleImage", "endFrameOptional"].includes(String(request.mode))) throw new Error("不支持此腾讯 WAND 视频模式");
    if (request.videos?.length) throw new Error("腾讯 WAND 暂不支持工作区视频参考");
    if (referenceMode && (!request.images?.length || request.images.length > 9 || (request.audios?.length ?? 0) > 3 || request.firstFrame || request.lastFrame)) throw new Error("腾讯 WAND 参考模式需要 1–9 张图片、最多 3 段音频，不能同时传首尾帧");
    if (!referenceMode && (request.images?.length || request.audios?.length)) throw new Error("图片和音频参考请使用参考模式");
    if (request.mode === "text" && (request.firstFrame || request.lastFrame)) throw new Error("文生视频模式不能附带首尾帧");
    if (((request.mode === "singleImage" || request.mode === "endFrameOptional") && !request.firstFrame) || (request.lastFrame && !request.firstFrame)) throw new Error("请选择视频首帧");
    if (request.mode === "singleImage" && request.lastFrame) throw new Error("单图模式不支持尾帧");
    if (request.seed !== undefined) throw new Error("腾讯 WAND 视频接口不支持指定种子，请移除 seed 后重试");
    if (request.cameraTrajectory) throw new Error("腾讯 WAND 视频接口不支持数值相机轨迹");
    if (request.watermark) throw new Error("腾讯 WAND 视频接口不支持设置水印");
    const prompt = [request.prompt, request.negativePrompt ? `画面中不得出现：${request.negativePrompt}` : ""].filter(Boolean).join("\n");
    if (!prompt.trim()) throw new Error("请输入视频提示词");
    const duration = request.duration ?? 5;
    const resolution = (request.resolution ?? (request.model === "wand-vega-video-1.0-lite" ? "768P" : "720P")).toUpperCase();
    if (!model.durationResolutionMap?.some(item => item.duration.includes(duration) && item.resolution.includes(resolution))) throw new Error("腾讯 WAND 视频时长或分辨率无效");
    if (request.ratio && !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(request.ratio)) throw new Error("腾讯 WAND 视频画幅无效");
    const content: object[] = [{ type: "text", text: prompt }];
    if (request.firstFrame) content.push({ type: "image_url", image_url: { url: mediaValue(request.firstFrame) }, role: "first_frame" });
    if (request.lastFrame) content.push({ type: "image_url", image_url: { url: mediaValue(request.lastFrame) }, role: "last_frame" });
    for (const input of request.images ?? []) content.push({ type: "image_url", image_url: { url: mediaValue(input) }, role: "reference_image" });
    for (const input of request.audios ?? []) {
      content.push({ type: "audio_url", audio_url: { url: mediaValue(input) }, role: "reference_audio" });
    }
    return submit(this, "video", { model: request.model, content, duration, resolution, options: { audio_mode: request.generateAudio === undefined ? "auto" : request.generateAudio ? "enable" : "disable" }, ...(!request.firstFrame && request.ratio ? { ratio: request.ratio } : {}) });
  },
} satisfies ProviderDefinition<typeof rules>;
