const rules = [
  { type: "input", field: "baseUrl" as const, title: "MuseTalk Gradio 地址", value: "http://127.0.0.1:7860", props: { placeholder: "http://127.0.0.1:7860" } },
] as const;

// ACT: 对接官方 MuseTalk 1.5 Gradio app 的命名 API；不在供应商脚本里安装或启动 Python 模型。
async function callApi(context: ProviderContext, baseUrl: string, name: string, data: unknown[], signal: AbortSignal): Promise<unknown[]> {
  const response = await context.tool.fetch(`${baseUrl}/call/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }), signal,
  });
  if (!response.ok) throw new Error(`MuseTalk ${name} 请求失败（HTTP ${response.status}）`);
  const result = await response.json() as { event_id?: string };
  if (!result.event_id || !/^[\w-]+$/.test(result.event_id)) throw new Error("MuseTalk 没有返回任务编号");
  const stream = await context.tool.fetch(`${baseUrl}/call/${name}/${result.event_id}`, { signal });
  if (!stream.ok || !stream.body) throw new Error("无法读取 MuseTalk 任务结果");
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.length > 1024 * 1024) throw new Error("MuseTalk 返回了过大的事件");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const type = event.match(/^event:\s*(.*)$/m)?.[1]?.trim();
        const payload = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (type === "error") throw new Error(`MuseTalk 生成失败：${context.tool.errorMessage(payload) || "请检查推理服务日志"}`);
        if (type === "complete") {
          const output: unknown = JSON.parse(payload);
          if (!Array.isArray(output)) throw new Error("MuseTalk 返回格式无效");
          return output;
        }
      }
      if (done) throw new Error("MuseTalk 连接已结束，但任务没有返回成功结果");
    }
  } finally { await reader.cancel(); }
}

export default {
  id: "museTalk", label: "MuseTalk · 开源对口型", version: "1.0.0",
  readme: "连接官方 MuseTalk 1.5 的 Gradio app.py 服务（Gradio 4.44 或 5）。输入一个人物视频和一段已确定的配音，返回带声音的口型视频。适合单人清晰面部镜头；多角色请按镜头分别处理。推理模型与 GPU 环境需单独部署，参见 docs/voiceProduction.md。",
  rules,
  models: [{ id: "museTalkV15", label: "MuseTalk 1.5 · 音频驱动口型", type: "video", lipSync: true, audio: true, mode: [["videoReference:1", "audioReference:1"]] }] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (request.model !== "museTalkV15") throw new Error("MuseTalk 模型无效");
    if (request.videos?.length !== 1 || request.audios?.length !== 1) throw new Error("对口型需要一个人物视频和一段配音");
    if (request.images?.length || request.firstFrame || request.lastFrame || request.duration || request.ratio || request.resolution || request.watermark || request.generateAudio === false) throw new Error("MuseTalk 按输入视频与音频处理，不接受图片、时长、画幅、分辨率、水印或静音参数");
    const origin = this.config.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(origin)) throw new Error("请配置完整的 MuseTalk HTTP 地址");
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(1800000)]) : AbortSignal.timeout(1800000);
    const configResponse = await this.tool.fetch(`${origin}/config`, { signal });
    if (!configResponse.ok) throw new Error(`无法连接 MuseTalk（HTTP ${configResponse.status}）`);
    const config = await configResponse.json() as { version?: string; api_prefix?: string; dependencies?: { api_name?: string }[] };
    if (!config.dependencies?.some(item => item.api_name === "inference") || !config.dependencies.some(item => item.api_name === "check_video")) throw new Error("请使用官方 MuseTalk 1.5 app.py，当前服务缺少 inference 或 check_video API");
    const prefix = config.api_prefix ?? (Number(config.version?.split(".")[0]) >= 5 ? "/gradio_api" : "");
    if (prefix !== "" && prefix !== "/gradio_api") throw new Error("不支持此 Gradio API 前缀");
    const baseUrl = `${origin}${prefix}`;
    const form = new FormData();
    for (const input of [request.audios[0]!, request.videos[0]!]) {
      if (input.type === "url") throw new Error("MuseTalk 参考素材必须先保存到工作区");
      const bytes = input.type === "binary" ? input.data : Buffer.from(input.data.replace(/^data:[^;,]+;base64,/, ""), "base64");
      if (!bytes.byteLength || bytes.byteLength > 100 * 1024 * 1024) throw new Error("输入文件为空或超过 100 MB");
      const extensions: Record<string, string> = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/ogg": "ogg", "audio/mp4": "m4a", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
      const extension = extensions[input.mimeType ?? ""];
      if (!extension) throw new Error("请使用 WAV / MP3 配音与 MP4 / MOV / WebM 视频");
      form.append("files", new Blob([new Uint8Array(bytes)], { type: input.mimeType }), `${crypto.randomUUID()}.${extension}`);
    }
    const upload = await this.tool.fetch(`${baseUrl}/upload`, { method: "POST", body: form, signal });
    if (!upload.ok) throw new Error(`MuseTalk 素材上传失败（HTTP ${upload.status}）`);
    const paths: unknown = await upload.json();
    if (!Array.isArray(paths) || paths.length !== 2 || paths.some(path => typeof path !== "string" || !path)) throw new Error("MuseTalk 素材上传结果无效");
    const audio = { path: paths[0], meta: { _type: "gradio.FileData" } };
    const video = { video: { path: paths[1], meta: { _type: "gradio.FileData" } } };
    const normalized = await callApi(this, baseUrl, "check_video", [video], signal);
    const result = await callApi(this, baseUrl, "inference", [audio, normalized[0], 0, 10, "jaw", 90, 90], signal);
    const output = result[0] as { video?: { url?: string; path?: string }; url?: string; path?: string } | undefined;
    const file = output?.video ?? output;
    if (!file || (!file.url && !file.path)) throw new Error("MuseTalk 未返回视频文件");
    const url = new URL(file.url || `${baseUrl}/file=${encodeURIComponent(file.path!)}`, `${origin}/`);
    if (url.origin !== new URL(origin).origin || !/^https?:$/.test(url.protocol)) throw new Error("MuseTalk 返回了其他服务的文件地址");
    const response = await this.tool.fetch(url, { signal });
    if (!response.ok) throw new Error(`下载口型视频失败（HTTP ${response.status}）`);
    if (/json|text|html/i.test(response.headers.get("content-type") ?? "")) throw new Error("MuseTalk 没有返回有效的视频");
    if (Number(response.headers.get("content-length")) > 100 * 1024 * 1024) { await response.body?.cancel(); throw new Error("口型视频超过 100 MB，请缩短镜头"); }
    return [{ type: "binary", data: new Uint8Array(await response.arrayBuffer()), mimeType: "video/mp4", mediaType: "video" }];
  },
} satisfies ProviderDefinition<typeof rules>;
