import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { assertPublicHttpUrl, guardedFetch, UnsafeUpstreamError } from "@/utils/ssrf";

/**
 * Connection test for the "connect your models" wizard. Makes the cheapest real, non-generating call it can and answers in plain Chinese.
 * The key is only ever used for that one request: it is never logged, stored or echoed back.
 */
const mediaProviders: Record<string, { label: string; verifyUrl?: (region: string) => string }> = {
  // APIMart is OpenAI-compatible; listing models is an authenticated, free request.
  apiMart: { label: "APIMart", verifyUrl: region => `${region === "2" ? "https://api.apimart.ai/v1" : "https://api.apib.ai/v1"}/models` },
  meta: { label: "秘塔 MiniMax" },
};

function explain(status: number) {
  if (status === 401 || status === 403) return "Key 不对或已失效，请回到服务商控制台重新复制";
  if (status === 404) return "这个地址下没有找到接口，请确认地址是否完整";
  if (status === 429) return "请求太频繁，或这个 Key 的余额/额度用完了";
  if (status >= 500) return `服务商那边暂时出了问题（${status}），稍后再试`;
  return `服务商返回了错误（${status}）`;
}
const failure = (message: string, extra: Record<string, unknown> = {}) => ({ ok: false, verified: false, message, ...extra });

function describeError(error: unknown) {
  if (error instanceof UnsafeUpstreamError) return error.message;
  const text = error instanceof Error ? error.message : String(error);
  const status = /HTTP (\d{3})/.exec(text)?.[1];
  if (status) return explain(Number(status));
  if (/timed? ?out|TimeoutError|aborted/i.test(text)) return "连接超时，请检查地址是否正确、网络是否通畅";
  return "连不上这个地址，请检查网址和网络";
}

async function textTest({ apiUrl, apiKey, protocol, probeModel }: { apiUrl: string; apiKey: string; protocol: string; probeModel?: string }) {
  try {
    const models = await u.ai.fetchProviderModels({ apiUrl, protocol, apiKey });
    if (models.length) return { ok: true, verified: true, message: `连接成功，找到 ${models.length} 个模型`, models };
    if (!probeModel) return failure("连上了，但服务商没有返回任何模型。");
  } catch (error) {
    const status = /HTTP (\d{3})/.exec(error instanceof Error ? error.message : "")?.[1];
    // Some providers do not expose a model list: fall back to a 1-token chat request with the preset's default model.
    if (!(status === "404" || status === "405") || !probeModel || protocol === "anthropic-messages") return failure(describeError(error));
  }
  try {
    const base = new URL(await assertPublicHttpUrl(apiUrl));
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/chat/completions`;
    const response = await guardedFetch(base, {
      method: "POST", signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: probeModel, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    await response.body?.cancel();
    if (response.ok) return { ok: true, verified: true, message: "连接成功", models: [{ id: probeModel, label: probeModel }] };
    if (response.status === 400 || response.status === 404) return failure(`Key 可以连上，但模型「${probeModel}」不可用，请到「高级」里改模型名`);
    return failure(explain(response.status));
  } catch (error) {
    return failure(describeError(error));
  }
}

async function mediaTest({ providerId, apiKey, region }: { providerId: string; apiKey: string; region: string }) {
  const provider = mediaProviders[providerId];
  if (!provider) return failure("不支持这个图片/视频服务商");
  if (apiKey.trim().length < 8) return failure("Key 看起来太短了，请确认复制完整");
  if (!provider.verifyUrl) return { ok: true, verified: false, message: `格式检查通过。${provider.label} 无法在不产生费用的情况下验证 Key，生成第一张图时才会真正确认。` };
  try {
    const response = await guardedFetch(provider.verifyUrl(region), { headers: { Accept: "application/json", Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}` }, signal: AbortSignal.timeout(20000) });
    await response.body?.cancel();
    if (response.ok) return { ok: true, verified: true, message: `${provider.label} 连接成功` };
    if (response.status === 401 || response.status === 403) return failure(explain(response.status));
    // Any other answer means the key was not rejected, but we cannot prove it works either.
    return { ok: true, verified: false, message: `${provider.label} 没有拒绝这个 Key，但无法提前验证；生成第一张图时会确认。` };
  } catch (error) {
    return failure(describeError(error));
  }
}

export default Router().post("/", validateFields({
  kind: z.enum(["text", "media"]),
  apiUrl: z.string().max(2048).optional(),
  apiKey: z.string().max(8192),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional(),
  providerId: z.string().max(64).optional(),
  region: z.enum(["1", "2"]).optional(),
  probeModel: z.string().max(200).optional(),
}), async (req, res) => {
  const body = req.body as { kind: "text" | "media"; apiUrl?: string; apiKey: string; protocol?: string; providerId?: string; region?: "1" | "2"; probeModel?: string };
  if (body.kind === "media") return void res.json(success(await mediaTest({ providerId: body.providerId ?? "", apiKey: body.apiKey, region: body.region ?? "1" })));
  if (!body.apiUrl) return void res.json(success(failure("请先选择服务商或填写 API 地址")));
  res.json(success(await textTest({ apiUrl: body.apiUrl, apiKey: body.apiKey, protocol: body.protocol ?? "openai-completions", probeModel: body.probeModel })));
});
