import { assertPublicHttpUrl } from "@/utils/ssrf";
import { t } from "@/lib/i18n";
import { z } from "zod";
import modelFetch from "@/utils/ai/modelFetch";

const modelSchema = z.object({
  id: z.string().optional(), name: z.string().optional(),
  display_name: z.string().optional(), displayName: z.string().optional(),
  inputTokenLimit: z.number().int().positive().optional(),
  outputTokenLimit: z.number().int().positive().optional(),
  output_modalities: z.array(z.string()).optional(),
});

const openRouterModelSchema = modelSchema.extend({
  context_length: z.number().int().positive().nullish(),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }).optional(),
  top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullish() }).nullish(),
});

export async function fetchProviderModels({ apiUrl, protocol, apiKey }: { apiUrl: string; protocol: string; apiKey: string }) {
  const url = new URL(await assertPublicHttpUrl(apiUrl));
  const openRouter = url.origin === "https://openrouter.ai";
  if (openRouter) {
    // 公开模型目录不能证明密钥有效；快速连接和高级配置共用这一步，不产生生成费用。
    const response = await modelFetch(new URL("/api/v1/key", url), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`OpenRouter 密钥验证失败（HTTP ${response.status}）`);
  }
  if (url.hostname === "api.atlascloud.ai" && ["/", "/v1", "/v1/", "/api/v1", "/api/v1/"].includes(url.pathname)) {
    url.pathname = "/api/v1/models";
    const key = apiKey.trim().replace(/^Bearer\s+/i, "");
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error", headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!response.ok) throw new Error(`获取 Atlas Cloud 模型目录失败（HTTP ${response.status}）`);
    const result = z.object({ data: z.array(z.object({
      model: z.string().min(1), displayName: z.string().optional(), type: z.string(), display_console: z.boolean(),
      contextLength: z.number().int().positive().optional(), maxCompletionTokens: z.number().int().positive().optional(),
      supported_protocols: z.array(z.string()).optional(),
    })) }).parse(await response.json());
    return result.data.filter(item => item.display_console && item.type === "Text"
      && (!item.supported_protocols || item.supported_protocols.includes("openai.chat.completions")))
      .map(item => ({ id: item.model, label: item.displayName || item.model, contextWindow: item.contextLength, maxOutputTokens: item.maxCompletionTokens }));
  }
  if (url.pathname === "/") url.pathname = "/v1";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (protocol === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = apiKey;
    url.searchParams.set("limit", "1000");
  } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const models = new Map<string, { id: string; label: string; contextWindow?: number; maxOutputTokens?: number }>();
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(openRouter ? 20000 : 30000);
  while (true) {
    const response = await modelFetch(url, { headers, signal, redirect: "error" });
    if (!response.ok) throw new Error(t`获取模型列表失败（HTTP ${response.status}），请检查 API 地址、协议和密钥`);
    const result = z.object({
      data: z.array(openRouter ? openRouterModelSchema : modelSchema),
      has_more: z.boolean().optional(), last_id: z.string().nullable().optional(),
    }).parse(await response.json());
    const items = result.data;
    for (const item of items) {
      const id = item.id?.trim();
      if (!id) throw new Error("模型列表包含无效的模型 ID");
      const routerModel = openRouter ? openRouterModelSchema.parse(item) : undefined;
      if (routerModel && (!routerModel.architecture?.input_modalities.includes("text")
        || routerModel.architecture.output_modalities.length !== 1 || routerModel.architecture.output_modalities[0] !== "text")) continue;
      if (url.hostname === "api.atlascloud.ai" && item.output_modalities && !item.output_modalities.includes("text")) continue;
      if (["api.atlascloud.ai", "easyrouter.io"].includes(url.hostname) && /embed|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe|rerank|speech|video|sora|seedance|seedream|pixverse|veo|kling|wan\d|wan-|minimax-h3|happyhorse|nano.?banana/i.test(id)) continue;
      models.set(id, { id, label: item.display_name || item.displayName || (openRouter ? item.name : undefined) || id,
        contextWindow: openRouter ? routerModel?.context_length ?? undefined : item.inputTokenLimit,
        maxOutputTokens: openRouter ? routerModel?.top_provider?.max_completion_tokens ?? undefined : item.outputTokenLimit });
    }
    const cursor = protocol === "anthropic-messages" && result.has_more ? result.last_id : undefined;
    if (protocol === "anthropic-messages" && result.has_more && !cursor) throw new Error("模型列表缺少分页游标");
    if (!cursor) break;
    if (cursors.has(cursor)) throw new Error("模型列表分页游标重复");
    cursors.add(cursor);
    url.searchParams.set("after_id", cursor);
  }
  return [...models.values()];
}
