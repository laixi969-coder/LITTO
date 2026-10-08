import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertConfiguredUpstream, getConfiguredModel } from "@/utils/ai";

export const agentContextWindow = 65536;

export async function createAgentModel(providerId: string, modelId: string, thinkingLevel = "off") {
  const configured = getConfiguredModel(providerId, modelId);
  await assertConfiguredUpstream(configured);
  const { provider, model, baseUrl } = configured;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(providerId, {
    api: provider.protocol,
    baseUrl,
    models: [{
      id: model.id, name: model.label, reasoning: thinkingLevel !== "off",
      // ACT: 保留图片输入，由实际供应方判断该模型是否支持。
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // ACT: Agent 提前摘要，避免大窗口模型先撞到网关的字节上限；原始历史仍在磁盘。
      contextWindow: Math.min(model.contextWindow, agentContextWindow), maxTokens: Math.min(model.maxOutputTokens, 16384),
    }],
  });
  await runtime.setRuntimeApiKey(providerId, provider.apiKey);
  return { ...configured, runtime };
}
