const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

export default {
  id: "openRouter", label: "OpenRouter", version: "1.0.0",
  apiUrl: "https://openrouter.ai/api/v1", protocol: "openai-completions",
  readme: "使用 OpenRouter API Key 接入剧本、分镜与助手文字模型，支持模型本身提供的图片理解和工具调用。模型目录自动获取，具体可用性与费用以账户权限和余额为准。\n\n[创建 API Key](https://openrouter.ai/settings/keys) · [官方文档](https://openrouter.ai/docs/quickstart)",
  rules, models: [],
} satisfies ProviderDefinition<typeof rules>;
