/** One-minute model connection: presets so people paste only a Key. Everything here is static text — no external calls. */
export type TextPreset = {
  id: string; label: string; apiUrl: string; protocol: "openai-completions"; probeModel: string; defaultModel: string;
  keyHelp: string; custom?: boolean;
};
export const textPresets: TextPreset[] = [
  { id: "deepseek", label: "DeepSeek", apiUrl: "https://api.deepseek.com", protocol: "openai-completions", probeModel: "deepseek-chat", defaultModel: "deepseek-chat", keyHelp: "登录 DeepSeek 开放平台，在「API keys」里创建一个 Key。" },
  { id: "qwen", label: "通义千问", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai-completions", probeModel: "qwen-plus", defaultModel: "qwen-plus", keyHelp: "登录阿里云百炼控制台，在「API-KEY」里创建一个 Key。" },
  { id: "kimi", label: "Kimi", apiUrl: "https://api.moonshot.cn/v1", protocol: "openai-completions", probeModel: "moonshot-v1-8k", defaultModel: "kimi-k2-0905-preview", keyHelp: "登录 Moonshot 开放平台，在「API Key 管理」里创建一个 Key。" },
  { id: "openai", label: "OpenAI", apiUrl: "https://api.openai.com/v1", protocol: "openai-completions", probeModel: "gpt-4o-mini", defaultModel: "gpt-4o", keyHelp: "登录 OpenAI Platform，在「API keys」里创建一个 Key。" },
  { id: "glm", label: "智谱 GLM", apiUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai-completions", probeModel: "glm-4-flash", defaultModel: "glm-4-plus", keyHelp: "登录智谱开放平台，在「API Keys」里创建一个 Key。" },
  { id: "custom", label: "其他（OpenAI 兼容）", apiUrl: "", protocol: "openai-completions", probeModel: "", defaultModel: "", keyHelp: "填写服务商给你的 API 地址和 Key；只要它兼容 OpenAI 的接口就能用。", custom: true },
];

export type MediaPreset = { id: string; label: string; desc: string; regions?: boolean; keyHelp: string };
export const mediaPresets: MediaPreset[] = [
  { id: "apiMart", label: "APIMart", desc: "一个 Key 同时用 Seedance 视频，以及 Seedream、GPT-Image、Nano Banana 出图、Wan 视频", regions: true, keyHelp: "在 APIMart 控制台创建 API Key；国内用户选「国内」，海外用户选「海外」。" },
  { id: "meta", label: "秘塔 MiniMax", desc: "MiniMax 视频模型，通过秘塔接入", keyHelp: "在秘塔 MiniMax 页面创建 API Key。" },
];

// Models that are not for chatting/script-writing: hide them from the auto-fetched list so the picker stays short.
export const nonChatModel = /embed|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe|rerank|speech|video|sora/i;
