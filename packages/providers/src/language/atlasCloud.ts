const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

export default {
  id: "atlasCloud", label: "Atlas Cloud", version: "1.0.0",
  apiUrl: "https://api.atlascloud.ai/v1", protocol: "openai-completions",
  readme: "使用 Atlas Cloud API Key，按 OpenAI Chat Completions 协议调用文字模型。\n\n[官方文档](https://www.atlascloud.ai/docs/zh/llm-protocols)",
  rules, models: [],
} satisfies ProviderDefinition<typeof rules>;
