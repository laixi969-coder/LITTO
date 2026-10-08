import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertConfiguredUpstream, getConfiguredModel } from "@/utils/ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import modelFetch from "@/utils/ai/modelFetch";

export const agentContextWindow = 262144;

export async function createAgentModel(providerId: string, modelId: string, thinkingLevel = "off") {
  const configured = getConfiguredModel(providerId, modelId);
  await assertConfiguredUpstream(configured);
  const { provider, model, baseUrl } = configured;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(providerId, {
    api: provider.protocol,
    baseUrl,
    streamSimple: provider.protocol === "openai-completions" && new URL(baseUrl).origin === "https://api.deepseek.com"
      ? (model, context, options) => openAICompletionsApi().streamSimple({ ...model, api: "openai-completions" }, context, { ...options, fetch: modelFetch })
      : undefined,
    models: [{
      id: model.id, name: model.label, reasoning: thinkingLevel !== "off",
      // ACT: 保留图片输入，由实际供应方判断该模型是否支持。
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // ACT: Agent 提前摘要，避免大窗口模型先撞到网关的字节上限；原始历史仍在磁盘。
      // 上限须与 requestBudget 的 1.76MB 自洽：256k token 历史约 1MB，压缩在 ~245k 触发，摘要请求仍在预算内；
      // 再调大前先同步核对 requestBudget，否则摘要请求会改报「超过请求预算」并同样循环失败。
      contextWindow: Math.min(model.contextWindow, agentContextWindow), maxTokens: Math.min(model.maxOutputTokens, 32768),
    }],
  });
  await runtime.setRuntimeApiKey(providerId, provider.apiKey);
  return { ...configured, runtime };
}
