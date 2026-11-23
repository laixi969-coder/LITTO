const modelId = "@cf/black-forest-labs/flux-1-schnell";
const rules = [
  { type: "input", field: "accountId" as const, title: "Cloudflare Account ID", value: "" },
  { type: "input", field: "apiKey" as const, title: "Workers AI API Token", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

export default {
  id: "cloudflare",
  label: "Cloudflare Workers AI",
  version: "1.0.0",
  readme: "使用 Workers AI 账户和令牌生成 FLUX.1 Schnell 快速草图。每次生成一张方图，固定 4 步。",
  rules,
  models: [{ id: modelId, label: "FLUX.1 Schnell · 快速草图", type: "image", mode: ["text"], imageSizes: ["1K"], imageRatios: ["1:1"] }],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const accountId = this.config.accountId.trim();
    const token = this.config.apiKey.trim();
    if (!/^[0-9a-f]{32}$/i.test(accountId) || !token) throw new Error("请填写 Cloudflare Account ID 和 Workers AI API Token");
    if (request.model !== modelId) throw new Error("请选择 FLUX.1 Schnell");
    if (request.images?.length || request.mask || request.quality || request.negativePrompt || request.outputFormat || request.seed !== undefined) throw new Error("快速草图仅支持文字提示词和默认输出设置");
    if ((request.n ?? 1) !== 1 || (request.ratio ?? "1:1") !== "1:1" || !["1K", "1024x1024"].includes(request.size ?? "1K")) throw new Error("快速草图每次生成 1 张 1K 方图");
    const prompt = request.prompt.trim();
    if (!prompt || Array.from(prompt).length > 2048) throw new Error("快速草图提示词须在 1 至 2048 个字符之间");
    const response = await this.tool.fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, steps: 4 }),
      signal: this.signal,
    });
    if (!response.ok) throw new Error(`Cloudflare 快速草图请求失败（HTTP ${response.status}）`);
    const data = await response.json() as { success?: unknown; result?: { image?: unknown } } | null;
    const image = data?.result?.image;
    if (data?.success !== true || typeof image !== "string" || !image) throw new Error("Cloudflare 未返回生成的草图");
    return [{ mediaType: "image", type: "base64", data: image, mimeType: "image/jpeg" }];
  },
} satisfies ProviderDefinition<typeof rules>;
