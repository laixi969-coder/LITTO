const rules = [
  { type: "input", field: "baseUrl" as const, title: "vLLM-Omni 地址", value: "http://127.0.0.1:8091", props: { placeholder: "http://127.0.0.1:8091" } },
  { type: "input", field: "authToken" as const, title: "服务令牌（选填）", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
] as const;

export default {
  id: "qwenSpeech",
  label: "Qwen3-TTS · 开源配音",
  version: "1.0.0",
  readme: "连接自行部署的 vLLM-Omni Qwen3-TTS-12Hz-1.7B-CustomVoice 服务。支持固定音色、中文对白、旁白和自然语言情绪指令。地址可带 /v1；不需要商业 API Key。模型需另行部署，安装此适配器不会下载模型。部署说明见仓库 docs/voiceProduction.md。",
  rules,
  models: [{
    id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", label: "Qwen3-TTS 1.7B · 多音色与情绪", type: "audio", speechInstructions: true,
    voices: [
      { title: "Vivian · 明亮女声", voice: "vivian" }, { title: "Serena · 温柔女声", voice: "serena" },
      { title: "Uncle Fu · 低沉男声", voice: "uncle_fu" }, { title: "Dylan · 北京男声", voice: "dylan" },
      { title: "Eric · 四川男声", voice: "eric" }, { title: "Ryan · 英语男声", voice: "ryan" },
      { title: "Aiden · 英语男声", voice: "aiden" }, { title: "Ono Anna · 日语女声", voice: "ono_anna" },
      { title: "Sohee · 韩语女声", voice: "sohee" },
    ],
  }] satisfies ProviderModel[],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    if (request.model !== "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice") throw new Error("此适配器需要 Qwen3-TTS 1.7B CustomVoice 模型");
    if (request.audios?.length) throw new Error("此模型使用预设音色，不支持参考音频克隆");
    if (request.volume !== undefined && request.volume !== 0) throw new Error("此服务不支持音量参数");
    if (request.sampleRate !== undefined && ![8000, 24000].includes(request.sampleRate)) throw new Error("采样率仅支持 8000 或 24000 Hz");
    if (request.speed !== undefined && (request.speed < 0.25 || request.speed > 4)) throw new Error("语速必须在 0.25 到 4 之间");
    const format = request.format ?? "wav";
    const formats: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", opus: "audio/opus" };
    if (!formats[format]) throw new Error("配音格式仅支持 WAV、MP3、FLAC 或 OPUS");
    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error("请配置完整的 vLLM-Omni HTTP 地址");
    const response = await this.tool.fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST", signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000),
      headers: { "Content-Type": "application/json", ...(this.config.authToken.trim() ? { Authorization: `Bearer ${this.config.authToken.trim()}` } : {}) },
      body: JSON.stringify({ model: request.model, input: request.text, voice: request.voice ?? "vivian", task_type: "CustomVoice", language: "Auto", instructions: request.instructions ?? "", speed: request.speed ?? 1, response_format: format, stream: false, ...(request.sampleRate ? { sample_rate: request.sampleRate } : {}) }),
    });
    if (!response.ok) throw new Error(`配音服务请求失败（HTTP ${response.status}）：${this.tool.errorMessage(await response.text())}`);
    if (/json|text|html/i.test(response.headers.get("content-type") ?? "")) throw new Error("配音服务没有返回音频，请核对服务地址与模型");
    if (Number(response.headers.get("content-length")) > 100 * 1024 * 1024) { await response.body?.cancel(); throw new Error("配音结果超过 100 MB，请缩短台词"); }
    return [{ type: "binary", data: new Uint8Array(await response.arrayBuffer()), mimeType: formats[format]!, mediaType: "audio" }];
  },
} satisfies ProviderDefinition<typeof rules>;
