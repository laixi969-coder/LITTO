const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

export default {
  id: "easyRouter", label: "EasyRouter", version: "1.0.0",
  apiUrl: "https://easyrouter.io/v1", protocol: "openai-completions",
  readme: "使用 EasyRouter API Key，按 OpenAI Chat Completions 协议调用文字模型，模型可用范围以 Key 权限为准。\n\n[官方文档](https://docs.easyrouter.io/zh/docs/api/ai-model/chat/openai/createchatcompletion)",
  rules, models: [],
} satisfies ProviderDefinition<typeof rules>;
