const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "请求地址",
    value: "https://metaso.cn/api/minimax",
    props: { placeholder: "https://metaso.cn/api/minimax" },
  },
] as const;

const version = "2.0.0";

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function pollVideo(context: ProviderContext, baseUrl: string, apiKey: string, taskId: string, signal: AbortSignal): Promise<string> {
  while (true) {
    const response = await context.tool.fetch(`${baseUrl}/v2/query/video_generation/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!response.ok) throw new Error(`查询任务失败：HTTP ${response.status}`);
    const data = await response.json() as { task?: { status?: string; content?: { url?: string } } };
    const status = data?.task?.status;
    if (status === "succeeded") {
      const url = data.task?.content?.url;
      if (!url) throw new Error("视频生成成功但未返回视频地址");
      return url;
    }
    if (status === "failed") throw new Error(context.tool.errorMessage?.(data) || "视频生成失败");
    await wait(signal, 5000);
  }
}

export function compactVideoPrompt(input: string) {
  let prompt = input;
  if (prompt.length > 10000) {
    // ACT: 只压缩编译器的两段通用说明，保留镜头动作、节拍、资产与锁定约束；仍超限则本地报错，不截断剧情。
    prompt = prompt
      .replace(/^VISUALDEFAULTS: Default to clean, intact, clearly readable imagery[^\n]*$/m,
        "VISUALDEFAULTS: 默认整洁、完好、主体清楚，服装、妆发、道具与环境符合时代和用途。不得以真实感或情绪为由增添污渍、锈蚀、破损、伤病、疲态、压暗、死黑、噪点、颗粒或模糊。例外仅按明确要求或已采用剧情限定对象、属性与时段，不扩散到其他元素；风格参考不授权复制脏损暗噪。保持接戏和明确变化。夜景保留夜色及合理光源，关键人物动作可读。清楚不等于平光、全景同锐、磨皮或消除年龄；保留媒介、自然纹理、妆容与景深。")
      .replace(/^REFERENCEUSE: Use every reference only for its declared role[^\n]*$/m,
        "REFERENCEUSE: 参考只执行声明角色与允许变化。IDENTITY保持脸型、年龄、肤色；只有全身参考才约束身体比例，脸部裁剪不确定身高或躯干腿长。未指定体态的新成年人物默认高挑匀称、自然长腿，头躯干髋膝踝连贯可信，不夸张拉伸，不为构图放大头、拉长躯干或缩腿；明确身高、体型、年龄、已采用全身参考或非人解剖优先，不强制固定头身比。WARDROBE约束衣服；角色LOOK可改变妆发但不改脸。摄影、光线、构图参考只约束相关摄影关系，不复制模特身份或未要求造型。表情与反应由当前动作决定；同一人物跨服装镜头绑定自身采用身份，不合并候选或服装。文字描述不是传入图像，不能保证身份。 ");
  }
  if (prompt.length > 10000) throw new Error(`视频提示词仍超过 10000 字符（${prompt.length}），请精简镜头规格后提交`);
  return prompt;
}

export default {
  id: "meta",
  label: "秘塔版MiniMax H3",
  version,
  readme: `秘塔科技提供高性价比的 MiniMax H3 视频生成服务：768P 仅 0.09 元/秒，2K 仅 0.15 元/秒。支持原生 2K、音画同步，API 兼容 OpenAI 协议，同时支持 ComfyUI、无限画布，无需自行部署 GPU。
 \n 👉 点击 [前往平台](https://metaso.cn/minimax-h3/?s=toon) 获取密钥`,
  rules,
  models: [
    {
      id: "MiniMax-H3",
      label: "MiniMax-H3",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "2K"] }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const baseUrl = (this.config.baseUrl?.trim() || "https://metaso.cn/api/minimax").replace(/\/$/, "");

    const images = (request.images ?? []).map(mediaUrl);
    const videos = (request.videos ?? []).map(mediaUrl);
    const audios = (request.audios ?? []).map(mediaUrl);
    const frames = [
      ...(request.firstFrame ? [{ url: mediaUrl(request.firstFrame), role: "first_frame" }] : []),
      ...(request.lastFrame ? [{ url: mediaUrl(request.lastFrame), role: "last_frame" }] : []),
    ];
    const mode =
      request.mode ?? (frames.length ? "startFrameOptional" : videos.length || audios.length ? [] : images.length ? "singleImage" : "text");
    const isFrames = mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional";

    const prompt = compactVideoPrompt(request.prompt);
    const content: Record<string, unknown>[] = [{ type: "text", text: prompt }];
    if (Array.isArray(mode)) {
      images.forEach((url) => content.push({ role: "reference_image", type: "image_url", image_url: { url } }));
      videos.forEach((url) => content.push({ role: "reference_video", type: "video_url", video_url: { url } }));
      audios.forEach((url) => content.push({ role: "reference_audio", type: "audio_url", audio_url: { url } }));
    } else if (isFrames) {
      frames.forEach(({ url, role }) => content.push({ type: "image_url", image_url: { url }, role }));
    } else if (mode === "singleImage") {
      images.forEach((url) => content.push({ role: "reference_image", type: "image_url", image_url: { url } }));
    }

    // ACT: 单次生成最多等待 10 分钟。
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const submitResponse = await this.tool.fetch(`${baseUrl}/v2/video_generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: request.model, duration: request.duration, resolution: request.resolution, ratio: request.ratio, content }),
      signal,
    });
    if (!submitResponse.ok) throw new Error(`提交任务失败：HTTP ${submitResponse.status}`);
    const submitData = await submitResponse.json() as { task_id?: string };
    const taskId = submitData?.task_id;
    if (!taskId) throw new Error("提交任务未返回任务 ID");

    const videoUrl = await pollVideo(this, baseUrl, apiKey, taskId, signal);
    return [{ mediaType: "video", type: "url", url: videoUrl }];
  },
} satisfies ProviderDefinition<typeof rules>;
