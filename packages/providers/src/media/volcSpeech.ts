const rules = [
  { type: "input", field: "apiKey" as const, title: "豆包语音 API Key（非方舟 Key）", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "豆包语音地址", value: "https://openspeech.bytedance.com" },
] as const;

export default {
  id: "volcSpeech", label: "火山引擎 · 豆包语音", version: "1.0.0", rules,
  readme: "使用豆包语音控制台独立创建的 API Key，不使用方舟 Key。支持语音合成与已创建的复刻音色；模型 ID 为语音资源 ID，音色 ID 从语音控制台复制。语音资源与方舟模型目录独立，内置官方已适配资源，不伪装成方舟模型同步。\n\n[官方文档](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)",
  models: [
    { id: "seed-tts-2.0", label: "豆包语音合成 2.0", type: "audio", speechInstructions: true, voices: [{ title: "Vivi · 中文女声", voice: "zh_female_vv_uranus_bigtts" }] },
    { id: "seed-icl-2.0", label: "豆包声音复刻 2.0 · 已创建音色", type: "audio" },
  ] satisfies ProviderModel[],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    if (Object.keys(request.audioParameters ?? {}).length) throw new Error("豆包语音请通过专用字段设置参数");
    if (!["seed-tts-2.0", "seed-icl-2.0"].includes(request.model)) throw new Error("不支持此语音资源 ID");
    if (!request.text.trim()) throw new Error("请填写配音文本");
    if (request.audios?.length) throw new Error("请先在豆包语音控制台创建复刻音色，再填写音色 ID；此接口不直接上传克隆音频");
    if (request.instructions && request.model !== "seed-tts-2.0") throw new Error("声音复刻资源不支持此表演指令");
    if (request.volume !== undefined && request.volume !== 0) throw new Error("当前未映射音量增益，请使用后期音量调整");
    if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2)) throw new Error("语速须为 0.5–2");
    if (request.model === "seed-icl-2.0" && !request.voice?.trim()) throw new Error("请填写已创建的复刻音色 ID");
    const format = request.format ?? "mp3";
    const formats: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", pcm: "audio/pcm", ogg_opus: "audio/ogg" };
    if (!formats[format]) throw new Error("不支持此语音格式");
    const sampleRate = request.sampleRate ?? (format === "ogg_opus" ? 48000 : 24000);
    if (![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate) || format === "ogg_opus" && sampleRate !== 48000) throw new Error("不支持此语音采样率");
    const key = String(this.config.apiKey ?? "").trim();
    const baseUrl = String(this.config.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!key || !baseUrl) throw new Error("请填写豆包语音 API Key 和地址");
    const signal = AbortSignal.any([AbortSignal.timeout(180000), ...(this.signal ? [this.signal] : [])]);
    const response = await this.tool.fetch(`${baseUrl}/api/v3/tts/unidirectional`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "X-Api-Key": key, "X-Api-Resource-Id": request.model, "X-Api-Request-Id": crypto.randomUUID() },
      body: JSON.stringify({ req_params: { text: request.text, speaker: request.voice || "zh_female_vv_uranus_bigtts", audio_params: { format, sample_rate: sampleRate, speech_rate: Math.round(((request.speed ?? 1) - 1) * 100) }, ...(request.instructions ? { additions: JSON.stringify({ context_texts: [request.instructions] }) } : {}) } }),
    });
    if (!response.ok || !response.body) throw new Error(`豆包语音请求失败（HTTP ${response.status}）`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let pending = "";
    let size = 0;
    let received = 0;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const item = JSON.parse(line) as { code?: number; message?: string; data?: string };
      if (item.code !== 0) throw new Error(this.tool.errorMessage(item) || "豆包语音合成失败");
      if (typeof item.data === "string" && item.data) {
        const bytes = Buffer.from(item.data, "base64");
        size += bytes.length;
        if (size > 100 * 1024 * 1024) throw new Error("语音结果超过 100 MB");
        chunks.push(bytes);
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > 150 * 1024 * 1024) throw new Error("语音响应超过大小限制");
        pending += decoder.decode(value, { stream: true });
        let index;
        while ((index = pending.indexOf("\n")) !== -1) { consume(pending.slice(0, index)); pending = pending.slice(index + 1); }
      }
      consume(pending + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); }
    if (!size) throw new Error("豆包语音未返回有效音频");
    return [{ mediaType: "audio", type: "binary", data: new Uint8Array(Buffer.concat(chunks)), mimeType: formats[format]! }];
  },
} satisfies ProviderDefinition<typeof rules>;
