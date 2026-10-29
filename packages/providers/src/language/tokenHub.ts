const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

export default {
  id: "tokenHub", label: "腾讯云 TokenHub", version: "1.0.0",
  apiUrl: "https://tokenhub.tencentmaas.com/v1", protocol: "openai-completions",
  readme: "使用腾讯云 TokenHub 广州地域的 API Key，模型可用范围以账户权限为准。其他地域或 Token Plan 请使用自定义供应商并填写对应地址。\n\n[官方文档](https://cloud.tencent.com/document/product/1823/130078)",
  rules, models: [],
} satisfies ProviderDefinition<typeof rules>;
