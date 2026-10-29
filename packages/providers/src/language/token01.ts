const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

export default {
  id: "token01", label: "Token01", version: "1.0.0",
  apiUrl: "https://www.token01.net/v1", protocol: "openai-completions",
  readme: "使用 Token01 令牌接入 OpenAI 兼容语言模型，模型和可用范围以令牌分组为准。\n\n[官方文档](https://token01.apifox.cn/doc-9075891)",
  rules, models: [],
} satisfies ProviderDefinition<typeof rules>;
