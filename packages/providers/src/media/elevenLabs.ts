const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
] as const;

export default {
  id: "elevenLabs", label: "ElevenLabs · 配乐与音效", version: "1.0.0", rules,
  readme: "独立生成纯音乐或音效，使用 ElevenLabs API Key。音乐模型和音效模型需分别设置；音乐 API、输出格式及额度取决于账号。配音和视频对口型继续使用各自模型。\n\n[音乐接口](https://elevenlabs.io/docs/api-reference/music/compose) · [音效接口](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)",
  models: [
    { id: "music_v2_5", label: "Eleven Music 2.5 · 配乐", type: "audio", audioTask: "music", inputSchema: { properties: { music_length_ms: { type: "integer", minimum: 3000, maximum: 600000 }, force_instrumental: { type: "boolean" } } } },
    { id: "eleven_text_to_sound_v3", label: "ElevenLabs SFX v3 · 音效", type: "audio", audioTask: "soundEffect", inputSchema: { properties: { duration_seconds: { type: "number", minimum: 0.5, maximum: 30 }, prompt_influence: { type: "number", minimum: 0, maximum: 1 } } } },
    { id: "eleven_text_to_sound_v2", label: "ElevenLabs SFX v2 · 循环音效", type: "audio", audioTask: "soundEffect", inputSchema: { properties: { duration_seconds: { type: "number", minimum: 0.5, maximum: 30 }, prompt_influence: { type: "number", minimum: 0, maximum: 1 }, loop: { type: "boolean" } } } },
  ] as (ProviderModel & Record<string, unknown> & { inputSchema: Record<string, unknown> })[],

  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const key = String(this.config.apiKey ?? "").trim();
    if (!key) throw new Error("请填写 ElevenLabs API Key");
    if (!request.text.trim()) throw new Error("请填写配乐或音效描述");
    if (request.audios?.length || request.voice || request.instructions || request.speed !== undefined || request.volume !== undefined || request.sampleRate !== undefined || request.format && request.format !== "mp3") throw new Error("当前接口只支持文字生成 MP3 配乐或音效，不支持参考音频、音色、语速或采样率参数");
    const music = request.model === "music_v2_5";
    if (!music && !["eleven_text_to_sound_v2", "eleven_text_to_sound_v3"].includes(request.model)) throw new Error("不支持此 ElevenLabs 音频模型");
    const parameters = request.audioParameters ?? {};
    const allowed = music ? ["music_length_ms", "force_instrumental"] : ["duration_seconds", "prompt_influence", ...(request.model.endsWith("v2") ? ["loop"] : [])];
    if (Object.keys(parameters).some(name => !allowed.includes(name))) throw new Error("包含此模型不支持的音频参数");
    const length = parameters.music_length_ms, duration = parameters.duration_seconds, influence = parameters.prompt_influence;
    if (length !== undefined && (typeof length !== "number" || !Number.isInteger(length) || length < 3000 || length > 600000)) throw new Error("音乐时长须为 3000 至 600000 毫秒");
    if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0.5 || duration > 30)) throw new Error("音效时长须为 0.5 至 30 秒");
    if (influence !== undefined && (typeof influence !== "number" || !Number.isFinite(influence) || influence < 0 || influence > 1)) throw new Error("提示词影响程度须为 0 至 1");
    if (parameters.force_instrumental !== undefined && typeof parameters.force_instrumental !== "boolean" || parameters.loop !== undefined && typeof parameters.loop !== "boolean") throw new Error("纯音乐与循环参数须为布尔值");
    const response = await this.tool.fetch(`https://api.elevenlabs.io/v1/${music ? "music" : "sound-generation"}?output_format=mp3_44100_128`, {
      method: "POST", signal: AbortSignal.any([AbortSignal.timeout(600000), ...(this.signal ? [this.signal] : [])]),
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(music ? { model_id: request.model, prompt: request.text, force_instrumental: true, ...parameters } : { model_id: request.model, text: request.text, ...parameters }),
    });
    if (!response.ok) throw Object.assign(new Error(`ElevenLabs 请求失败（HTTP ${response.status}）：${this.tool.errorMessage(await response.text())}`), { status: response.status });
    if (/json|text|html/i.test(response.headers.get("content-type") ?? "")) throw new Error("ElevenLabs 未返回音频");
    if (Number(response.headers.get("content-length")) > 100 * 1024 * 1024) { await response.body?.cancel(); throw new Error("音频超过 100 MB"); }
    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length || data.length > 100 * 1024 * 1024) throw new Error("音频为空或超过 100 MB");
    return [{ type: "binary", data, mimeType: "audio/mpeg", mediaType: "audio" }];
  },
} satisfies ProviderDefinition<typeof rules>;
