import { z } from "zod";
import conf from "@/utils/conf";
import { providerSchema } from "@/utils/ai";
import { assertPublicHttpUrl } from "@/utils/ssrf";

const timeRange = { start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative() };
const transcriptSchema = z.object({
  text: z.string().max(100000),
  segments: z.array(z.object({ ...timeRange, text: z.string().max(10000), no_speech_prob: z.number().optional() })).max(5000).optional(),
  words: z.array(z.object({ ...timeRange, word: z.string().max(1000) })).max(20000).optional(),
});

const serverSpeechSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).refine(value => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash; }),
  model: z.string().min(1).max(200).regex(/^[\w./:-]+$/),
  apiKey: z.string(),
  timeoutMs: z.coerce.number().int().min(30000).max(3600000),
  concurrency: z.coerce.number().int().min(1).max(16),
});
let activeTranscriptions = 0;

function serverSpeechConfig() {
  if (!process.env.LITTO_SPEECH_URL?.trim()) return undefined;
  const parsed = serverSpeechSchema.safeParse({
    url: process.env.LITTO_SPEECH_URL.trim(),
    model: process.env.LITTO_SPEECH_MODEL?.trim() || "Systran/faster-whisper-small",
    apiKey: process.env.LITTO_SPEECH_API_KEY?.trim() || "",
    timeoutMs: process.env.LITTO_SPEECH_TIMEOUT_MS || "900000",
    concurrency: process.env.LITTO_SPEECH_CONCURRENCY || "1",
  });
  if (!parsed.success) throw Object.assign(new Error("服务器转写配置无效，请管理员检查 LITTO_SPEECH 环境变量"), { status: 503 });
  return parsed.data;
}

export function transcriptionStatus() {
  const config = serverSpeechConfig();
  // 配置状态不等同于服务健康；不向客户端公开内网地址和密钥。
  return { configured: !!config, model: config?.model ?? "" };
}

export async function transcribeMusic(audio: Buffer, providerId: string, model: string, signal: AbortSignal, source = "custom") {
  // ACT: 只接受客户端重采样生成的标准 PCM WAV，限制 10 分钟；不在服务端再次解码不可信压缩媒体。
  if (audio.length < 46 || audio.length > 19200044 || audio.toString("ascii", 0, 4) !== "RIFF"
    || audio.toString("ascii", 8, 16) !== "WAVEfmt " || audio.readUInt32LE(16) !== 16
    || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000
    || audio.readUInt32LE(28) !== 32000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
    || audio.toString("ascii", 36, 40) !== "data" || audio.readUInt32LE(40) !== audio.length - 44
    || audio.readUInt32LE(4) !== audio.length - 8 || (audio.length - 44) % 2) {
    throw Object.assign(new Error("音频须为不超过 10 分钟的 16 kHz 单声道 PCM WAV"), { status: 400 });
  }
  const managed = source === "server";
  const server = managed ? serverSpeechConfig() : undefined;
  let apiUrl: string, apiKey: string;
  if (managed) {
    if (!server) throw Object.assign(new Error("服务器尚未配置听歌识词服务"), { status: 503 });
    if (activeTranscriptions >= server.concurrency) throw Object.assign(new Error("听歌识词服务繁忙，请稍后重试"), { status: 429 });
    apiUrl = server.url; apiKey = server.apiKey; model = server.model; providerId = "littoSpeech";
  } else {
    const providers = conf.get("settings", {}).customProviders;
    const parsed = providerSchema.safeParse(Array.isArray(providers) ? providers.find(item => item?.id === providerId) : undefined);
    if (!parsed.success || !parsed.data.apiKey.trim() || !parsed.data.protocol.startsWith("openai-")) {
      throw Object.assign(new Error("请选择已配置 Key、支持 OpenAI 兼容音频转写接口的供应商；平台文本试用不支持听歌识词"), { status: 400 });
    }
    apiUrl = parsed.data.apiUrl; apiKey = parsed.data.apiKey;
  }
  const baseUrl = new URL(apiUrl);
  if (baseUrl.pathname === "/") baseUrl.pathname = "/v1";
  const endpoint = `${baseUrl.href.replace(/\/+$/, "")}/audio/transcriptions`;
  // ACT: 仅管理员环境变量固定的目标允许内网；用户供应商仍走 SSRF 校验，拒绝所有重定向。
  const url = managed ? new URL(endpoint) : await assertPublicHttpUrl(endpoint);
  signal = AbortSignal.any([signal, AbortSignal.timeout(server?.timeoutMs ?? 300000)]);
  // ACT: 单进程忙时拒绝，不排队持有歌曲；扩容到多副本时应在推理服务统一限流。
  if (managed) activeTranscriptions++;
  try {
    signal.throwIfAborted();
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(audio)], { type: "audio/wav" }), "song.wav");
    form.set("model", model);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    // 不带歌词提示，避免把用户歌词当成实际识别结果；拒绝重定向，防止 Key 被转发到其他主机。
    const response = await fetch(url, { method: "POST", body: form, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(managed ? `服务器转写服务返回 ${response.status}，请管理员检查模型与服务配置` : `听歌识词服务返回 ${response.status}，请确认 Key、余额及模型支持 verbose_json 和逐词时间戳`), { status: 502 });
    }
    const reader = response.body?.getReader();
    if (!reader) throw Object.assign(new Error("转写服务返回空响应"), { status: 502 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw Object.assign(new Error("转写结果超过大小限制"), { status: 502 });
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    let result: z.infer<typeof transcriptSchema>;
    try { result = transcriptSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw Object.assign(new Error("转写服务返回格式无效，未取得可用的歌词时间戳"), { status: 502 }); }
    const duration = (audio.length - 44) / 32000;
    for (const ranges of [result.segments ?? [], result.words ?? []]) {
      if (ranges.some((item, index) => item.end <= item.start || item.end > duration + 0.1 || (index > 0 && item.start < ranges[index - 1]!.start))) {
        throw Object.assign(new Error("转写服务返回的时间戳无效或超出歌曲时长"), { status: 502 });
      }
    }
    return { ...result, providerId, model, duration, source: "automaticTranscription" as const };
  } catch (cause) {
    if (signal.aborted) throw Object.assign(new Error("听歌识词已取消或超时，请缩短歌曲或由管理员调整超时"), { status: 504 });
    if (cause instanceof Error && "status" in cause) throw cause;
    throw Object.assign(new Error("无法连接听歌识词服务，请检查服务是否启动及网络连接"), { status: 502 });
  } finally { if (managed) activeTranscriptions--; }
}
