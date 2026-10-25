/** One-minute model connection: presets so people paste only a Key. Everything here is static text — no external calls. */
export type TextPreset = {
  id: string; label: string; apiUrl: string; protocol: "openai-completions"; probeModel: string; defaultModel: string;
  keyHelp: string; custom?: boolean;
};
export const textPresets: TextPreset[] = [
  { id: "deepseek", label: "DeepSeek", apiUrl: "https://api.deepseek.com", protocol: "openai-completions", probeModel: "deepseek-flash", defaultModel: "deepseek-flash", keyHelp: "登录 DeepSeek 开放平台，在「API keys」里创建一个 Key。" },
  { id: "qwen", label: "通义千问", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai-completions", probeModel: "qwen-plus", defaultModel: "qwen-plus", keyHelp: "登录阿里云百炼控制台，在「API-KEY」里创建一个 Key。" },
  { id: "kimi", label: "Kimi", apiUrl: "https://api.moonshot.cn/v1", protocol: "openai-completions", probeModel: "moonshot-v1-8k", defaultModel: "kimi-k2-0905-preview", keyHelp: "登录 Moonshot 开放平台，在「API Key 管理」里创建一个 Key。" },
  { id: "openai", label: "OpenAI", apiUrl: "https://api.openai.com/v1", protocol: "openai-completions", probeModel: "gpt-4o-mini", defaultModel: "gpt-4o", keyHelp: "登录 OpenAI Platform，在「API keys」里创建一个 Key。" },
  { id: "glm", label: "智谱 GLM", apiUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai-completions", probeModel: "glm-4-flash", defaultModel: "glm-4-plus", keyHelp: "登录智谱开放平台，在「API Keys」里创建一个 Key。" },
  { id: "atlasCloud", label: "Atlas Cloud", apiUrl: "https://api.atlascloud.ai/v1", protocol: "openai-completions", probeModel: "deepseek-ai/deepseek-v3.2", defaultModel: "deepseek-ai/deepseek-v3.2", keyHelp: "在 Atlas Cloud 控制台创建 API Key。模型目录为公开列表，密钥和模型调用权限在首次生成时确认。" },
  { id: "easyRouter", label: "EasyRouter", apiUrl: "https://easyrouter.io/v1", protocol: "openai-completions", probeModel: "gpt-5.4-nano", defaultModel: "gpt-5.4-nano", keyHelp: "在 EasyRouter 控制台创建 API Key，文字模型按 Key 可用列表获取。" },
  { id: "openRouter", label: "OpenRouter", apiUrl: "https://openrouter.ai/api/v1", protocol: "openai-completions", probeModel: "", defaultModel: "openai/gpt-4o-mini", keyHelp: "在 openrouter.ai/settings/keys 创建 API Key；验证密钥后自动获取文字模型，调用费用由 OpenRouter 账户结算。" },
  { id: "custom", label: "其他（OpenAI 兼容）", apiUrl: "", protocol: "openai-completions", probeModel: "", defaultModel: "", keyHelp: "填写服务商给你的 API 地址和 Key；只要它兼容 OpenAI 的接口就能用。", custom: true },
];

export type MediaPreset = { id: string; label: string; desc: string; regions?: boolean; keyHelp: string; baseUrl?: string; urlRequired?: boolean; secret?: boolean };
export const mediaPresets: MediaPreset[] = [
  { id: "vidu", label: "Vidu", desc: "Q4 Preview 图生视频与参考生视频：支持单首帧，或 1–15 张参考图及最多 3 段 MP3 参考音频（每段 3–12 秒）。3–16 秒，540P 至 4K，可选音画同出。", baseUrl: "https://api.vidu.cn", keyHelp: "在 Vidu 开放平台创建 API Key，地址默认已填好。" },
  { id: "apiMart", label: "APIMart / 中转", desc: "一个 Key 同时用 Seedance 视频，以及 Seedream、GPT-Image、Nano Banana 出图、Wan 视频", regions: true, keyHelp: "在 APIMart 控制台创建 API Key；国内用户选「国内」，海外用户选「海外」。" },
  { id: "meta", label: "秘塔 MiniMax", desc: "MiniMax 视频模型，通过秘塔接入", keyHelp: "在秘塔 MiniMax 页面创建 API Key。" },
  { id: "agnes", label: "Agnes AI", desc: "同一个 Key 使用 Agnes Image 2.5 Flash 出图和参考图编辑（1K–4K），以及 Video 2.5 Flash 文生视频（720P、4–12 秒）。视频本地参考素材上传尚未接通。", keyHelp: "在 Agnes AI 开放平台创建 API Key，图片与视频共用。" },
  { id: "volcengine", label: "火山方舟", desc: "支持同步方舟模型目录，使用已适配的 Seedream 图片和 Seedance 视频。独立配音请选择「火山引擎 · 豆包语音」。", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", keyHelp: "在火山方舟控制台创建 API Key，并开通对应模型；接入点 ID 可在高级模型配置中修改。" },
  { id: "volcSpeech", label: "火山引擎 · 豆包语音", desc: "独立语音合成与已创建复刻音色，支持语速、格式和采样率；凭证与方舟独立。", baseUrl: "https://openspeech.bytedance.com", keyHelp: "在豆包语音控制台创建语音 API Key，并开通相应语音资源；不能使用方舟 Key。" },
  { id: "bailian", label: "阿里百炼", desc: "同步工作空间模型目录，支持图片、视频及 Qwen-Audio-TTS、CosyVoice、Qwen-TTS 配音。", baseUrl: "", urlRequired: true, keyHelp: "创建同地域 API Key，填写以 /api/v1 结尾的工作空间地址；Qwen-TTS 的独立 DashScope 地址在供应商配置中设置。" },
  { id: "kling", label: "可灵", desc: "Kling Image 2.1 和 Video 2.6，支持本地图片参考及视频首帧。API Key 或旧 AK/SK 认证均可使用，也支持可灵协议中转。", baseUrl: "https://api-singapore.klingai.com/v1", secret: true, keyHelp: "在可灵开放平台创建 API Key；使用旧认证时在 Key 中填 Access Key，并填写 Secret Key。" },
  { id: "atlasCloud", label: "Atlas Cloud", desc: "同步图片、视频和音频目录，按官方参数定义接入语音、音乐与音效生成；异步任务自动轮询。", baseUrl: "https://api.atlascloud.ai/api/v1", keyHelp: "在 Atlas Cloud 控制台创建 API Key；图片、视频、音频共用。支持根地址、/v1 或 /api/v1，系统自动识别。" },
  { id: "easyRouter", label: "EasyRouter", desc: "同步图片、视频和语音模型，支持 GPT 与 Gemini TTS 配音，以及已适配的图片和视频生成。", baseUrl: "https://easyrouter.io/v1", keyHelp: "在 EasyRouter 控制台创建 API Key，并开通对应模型权限。地址以 /v1 结尾。" },
];

// Models that are not for chatting/script-writing: hide them from the auto-fetched list so the picker stays short.
export const nonChatModel = /embed|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe|rerank|speech|video|sora/i;
