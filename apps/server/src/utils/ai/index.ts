import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Context, Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import conf from "@/utils/conf";
import { assertPublicHttpUrl, assertPublicUrlLiteral } from "@/utils/ssrf";
import { readReference } from "@/utils/media/generation";
import modelContextLimits from "@/utils/ai/modelContextLimits";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { modelAccess } from "@/utils/modelAvailability";
import { assertModelSelection, isSelectedModel } from "@/utils/modelSelection";

export { fetchProviderModels } from "@/utils/ai/models";

export const providerSchema = z.object({
  apiUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.string(),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  models: z.array(z.object({
    id: z.string(), label: z.string(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })),
});

const builtinModels = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider));

export function getModelLimits(providerId: string, model: z.infer<typeof providerSchema>["models"][number]) {
  const limits = modelContextLimits.find(item => item.id === model.id)
    ?? modelContextLimits.find(item => item.id instanceof RegExp && model.id.search(item.id) !== -1);
  if (limits) return { contextWindow: limits.contextWindow, maxTokens: limits.maxTokens };
  if (model.contextWindow != null && model.maxOutputTokens != null) {
    return { contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens };
  }
  const matches = builtinModels.filter(item => item.id === model.id);
  const exact = matches.find(item => item.provider === providerId);
  const candidates = exact ? [exact] : matches;
  // ACT: 只精确匹配 ID；跨供应商同名参数逐项一致才采用，不猜别名。
  const contextWindow = candidates.every(item => item.contextWindow === candidates[0]?.contextWindow) ? candidates[0]?.contextWindow : undefined;
  const maxTokens = candidates.every(item => item.maxTokens === candidates[0]?.maxTokens) ? candidates[0]?.maxTokens : undefined;
  return {
    contextWindow: model.contextWindow ?? contextWindow ?? 262144,
    maxTokens: model.maxOutputTokens ?? maxTokens ?? 32768,
  };
}

// 平台试用：账号模式下由 cloud 提供平台凭据的文本模型，按 token 扣注册赠送的积分（见 cloud/src/trial.ts）。
function trialModels() {
  const embed = cloud();
  const tenant = currentTenant();
  return embed && tenant ? embed.trialStatus(tenant.workspaceId) : { credits: 0, models: [] };
}
export const trialStatus = trialModels;

function trialConfiguredModel(modelId: string) {
  const embed = cloud();
  const tenant = currentTenant();
  if (!embed || !tenant) throw Object.assign(new Error("平台试用仅在账号模式下可用"), { status: 400 });
  const access = embed.trialModelAccess(tenant.workspaceId, modelId);
  const model = { id: modelId, label: access.label, contextWindow: access.contextWindow, maxOutputTokens: access.maxOutputTokens };
  const limits = getModelLimits(embed.trialProviderId, model);
  const baseUrl = new URL(access.baseUrl);
  if (baseUrl.pathname === "/") baseUrl.pathname = "/v1";
  return {
    providerId: embed.trialProviderId,
    provider: { apiUrl: access.baseUrl, apiKey: access.apiKey, protocol: "openai-completions" as const, models: [model] },
    model: { ...model, contextWindow: limits.contextWindow, maxOutputTokens: limits.maxTokens },
    baseUrl: baseUrl.href.replace(/\/+$/, ""),
  };
}

// 上游 SDK 的错误是英文且不说明原因，转成用户能据此行动的说明，并附上原文便于管理员排查；无法识别的保持原文。
// Bun 的 fetch 连不上目标时报 "Unable to connect..."，与 ECONNREFUSED 等同属连接类错误；
// 配置了本机代理而代理未启动时，给出与 providers/test.ts 一致的精确提示。
function connectionHint(message: string) {
  const proxy = /unable to connect|econnrefused/i.test(message)
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
    : undefined;
  return proxy ? `本机代理 ${proxy} 连不上，请先启动代理软件，或清空 HTTP_PROXY/HTTPS_PROXY 等代理环境变量后重启服务再试`
    : "无法连接模型服务，请检查网络或代理设置后重试";
}

export function describeModelError(message: string | undefined) {
  if (!message) return "模型请求失败";
  if (/\b413\b|length limit exceeded|request body too large/i.test(message))
    return "模型接口拒绝了过大的请求。请整理文字上下文或减少本次附件，避免原样重试；原始素材与记录已保留。";
  const hint = /^Connection error|unable to connect|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|socket hang up/i.test(message) ? connectionHint(message)
    : /timed? ?out|ETIMEDOUT/i.test(message) ? "模型服务响应超时，请稍后重试"
      : /\b401\b|invalid api key|incorrect api key|unauthorized/i.test(message) ? "模型 Key 无效或已过期，请检查后重新填写"
        : /\b402\b|insufficient[ _](user[ _])?(balance|quota)|pre-consume quota|余额不足/i.test(message) ? "模型服务账户余额不足，请充值后重试"
          : /\b429\b|rate limit/i.test(message) ? "模型服务请求过于频繁，请稍后重试"
            : undefined;
  return hint ? `${hint}（${message.slice(0, 200)}）` : message;
}

export function getConfiguredModel(providerId: string, modelId: string) {
  assertModelSelection("text", providerId, modelId);
  if (providerId === cloud()?.trialProviderId) return trialConfiguredModel(modelId);
  const providers = conf.get("settings", {}).customProviders;
  const parsed = providerSchema.safeParse(Array.isArray(providers) ? providers.find(item => item?.id === providerId) : undefined);
  if (!parsed.success) throw Object.assign(new Error("请先在设置中配置模型供应商"), { status: 400 });
  const provider = parsed.data;
  modelAccess("text", providerId, modelId).assert();
  const model = provider.models.find(item => item.id === modelId);
  if (!model) throw Object.assign(new Error("所选模型不存在，请重新选择"), { status: 400 });
  assertPublicUrlLiteral(provider.apiUrl); // literal private/loopback addresses never reach the model client
  const baseUrl = new URL(provider.apiUrl);
  if (baseUrl.pathname === "/") baseUrl.pathname = "/v1";
  const limits = getModelLimits(providerId, model);
  return { providerId, provider, model: { ...model, contextWindow: limits.contextWindow, maxOutputTokens: limits.maxTokens }, baseUrl: baseUrl.href.replace(/\/+$/, "") };
}

/** Full check including DNS resolution, for the async call sites right before a request is made. */
export async function assertConfiguredUpstream(configured: ReturnType<typeof getConfiguredModel>) {
  await assertPublicHttpUrl(configured.baseUrl, { strictDns: false });
}

export function listAiModels(all = false) {
  const providers = conf.get("settings", {}).customProviders;
  const trialState = trialModels();
  const trial = (trialState.credits > 0 ? trialState.models : []).filter(model => all || isSelectedModel("text", cloud()!.trialProviderId, model.id)).map(model => {
    const limits = getModelLimits(cloud()!.trialProviderId, model);
    return { providerId: cloud()!.trialProviderId, providerLabel: "平台试用", protocol: "openai-completions" as const, modelId: model.id, label: model.label,
      contextWindow: limits.contextWindow, maxOutputTokens: limits.maxTokens };
  });
  if (!Array.isArray(providers)) return trial;
  return [...providers.flatMap(item => {
    const parsed = providerSchema.extend({ id: z.string().min(1), label: z.string() }).safeParse(item);
    if (!parsed.success) return [];
    const provider = parsed.data;
    return provider.models.filter(model => model.id.trim() && !modelAccess("text", provider.id, model.id).reason() && (all || isSelectedModel("text", provider.id, model.id))).map(model => {
      const limits = getModelLimits(provider.id, model);
      return {
        providerId: provider.id, providerLabel: provider.label, protocol: provider.protocol, modelId: model.id, label: model.label,
        contextWindow: limits.contextWindow, maxOutputTokens: limits.maxTokens,
      };
    });
  }), ...trial];
}

const aiApis = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
};

export const aiReferenceSchema = z.discriminatedUnion("dataType", [
  z.object({ dataType: z.literal("STRING"), value: z.string().max(1000000) }),
  z.object({ dataType: z.literal("IMAGE"), value: z.object({ url: z.string().min(1).max(4096), mimeType: z.string().startsWith("image/") }) }),
  z.object({ dataType: z.literal("VIDEO"), value: z.object({ url: z.string().min(1).max(4096), mimeType: z.string().startsWith("video/") }) }),
]);

export async function readAiReferences(directory: string | undefined, references: z.infer<typeof aiReferenceSchema>[], signal?: AbortSignal) {
  return Promise.all(references.map(async (item) => {
    if (item.dataType === "STRING") return { dataType: item.dataType, value: item.value };
    if (!directory) throw Object.assign(new Error("媒体参考需要工作目录"), { status: 400 });
    const media = await readReference(directory, { path: item.value.url, mimeType: item.value.mimeType }, item.dataType.toLowerCase(), signal);
    return { dataType: item.dataType, value: `data:${media.mimeType};base64,${media.data}` };
  }));
}

export function referenceContent(protocol: string, prompt: string, references: Awaited<ReturnType<typeof readAiReferences>>) {
  const textPart = (text: string) => ({ type: protocol === "openai-responses" ? "input_text" : "text", text });
  const content: object[] = [textPart(prompt)];
  references.forEach((item, index) => {
    content.push(textPart(`{{ref ${index + 1}}}${item.dataType === "STRING" ? `\n${item.value}` : ""}`));
    if (item.dataType === "STRING") return;
    if (protocol === "openai-completions") {
      content.push(item.dataType === "IMAGE"
        ? { type: "image_url", image_url: { url: item.value } }
        : { type: "video_url", video_url: { url: item.value } });
    } else if (protocol === "openai-responses") {
      const extension = item.value.slice(11, item.value.indexOf(";")).replace("quicktime", "mov");
      content.push(item.dataType === "IMAGE"
        ? { type: "input_image", image_url: item.value, detail: "auto" }
        : { type: "input_file", filename: `reference${index + 1}.${extension}`, file_data: item.value });
    } else {
      const separator = item.value.indexOf(",");
      content.push({
        type: item.dataType === "IMAGE" ? "image" : "document",
        source: { type: "base64", media_type: item.value.slice(5, item.value.indexOf(";")), data: item.value.slice(separator + 1) },
      });
    }
  });
  return content;
}

export function streamAi(
  configured: ReturnType<typeof getConfiguredModel>,
  context: Context,
  signal: AbortSignal,
  references: Awaited<ReturnType<typeof readAiReferences>> = [],
) {
  const { provider, model: configuredModel, baseUrl } = configured;
  assertModelSelection("text", configured.providerId, configuredModel.id);
  const model: Model<typeof provider.protocol> = {
    // 回复里的 provider 恒为 "toonflow"；记录用量和平台试用扣费须用 configured.providerId。
    id: configuredModel.id, name: configuredModel.label, provider: "toonflow", api: provider.protocol, baseUrl,
    reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: configuredModel.contextWindow,
    maxTokens: configuredModel.maxOutputTokens,
  };
  // ACT: 不按模型名预判附件能力；按供应商协议传递，是否支持由上游接口决定。
  const access = configured.providerId === cloud()?.trialProviderId ? undefined : modelAccess("text", configured.providerId, configuredModel.id);
  access?.assert();
  const stream = aiApis[provider.protocol].streamSimple(model, context, {
    apiKey: provider.apiKey,
    signal,
    onPayload: references.length ? (payload) => {
      const body = payload as Record<string, unknown>;
      const field = provider.protocol === "openai-responses" ? "input" : "messages";
      const messages = body[field] as { role: string; content: unknown }[];
      // ACT: 后续 Anthropic 工具结果也使用 user 角色，附件只补充到最初的输入。
      const firstUser = messages.findIndex(message => message.role === "user");
      const attachmentContent = referenceContent(provider.protocol, "", references).slice(1);
      return { ...body, [field]: messages.map((message, index) => index === firstUser
        ? { ...message, content: [
          ...(Array.isArray(message.content) ? message.content : referenceContent(provider.protocol, String(message.content ?? ""), [])),
          ...attachmentContent,
        ] }
        : message) };
    } : undefined,
  });
  void stream.result().then(result => { if (result.stopReason === "error") access?.failed(result.errorMessage); }).catch(() => {});
  return stream;
}
