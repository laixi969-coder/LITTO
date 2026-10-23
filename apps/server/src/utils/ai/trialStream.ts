import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Api, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import modelFetch from "@/utils/ai/modelFetch";

/** 平台文本的统一出站入口：覆盖聊天、工具循环、子任务、摘要和直接文本/视觉调用。 */
export function streamTrial(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const output = createAssistantMessageEventStream();
  const embed = cloud();
  const tenant = currentTenant();
  void (async () => {
    let reservation: { id: string; maxOutputTokens: number } | undefined;
    let sent = false;
    let rejected = false;
    let finalized = false;
    let message: AssistantMessage | undefined;
    try {
      if (!embed || !tenant || model.provider !== embed.trialProviderId || model.api !== "openai-completions") throw new Error("平台试用缺少有效账号或模型配置");
      options?.signal?.throwIfAborted();
      const access = embed.trialModelAccess(tenant.workspaceId, model.id);
      const baseUrl = new URL(access.baseUrl);
      if (baseUrl.pathname === "/") baseUrl.pathname = "/v1";
      if (baseUrl.href.replace(/\/+$/, "") !== model.baseUrl.replace(/\/+$/, "")) throw new Error("平台模型配置已变更，请重新选择模型");
      const guardedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        request.signal.throwIfAborted();
        if (!reservation || sent) throw new Error("平台调用必须独立预占额度，不能自动重发");
        sent = true;
        const response = await modelFetch(request, { redirect: "error" });
        rejected = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
        return response;
      }, { preconnect: modelFetch.preconnect });
      const stream = openAICompletionsApi().streamSimple({ ...model, api: "openai-completions" }, context, {
        ...options, apiKey: access.apiKey, fetch: guardedFetch, maxRetries: 0,
        onPayload: async (payload, requestModel) => {
          const prepared = await options?.onPayload?.(payload, requestModel) ?? payload;
          options?.signal?.throwIfAborted();
          if (reservation) throw new Error("同一次平台调用不能重复预占额度");
          const body = { ...prepared as Record<string, any> };
          if (!Array.isArray(body.messages)) throw new Error("平台模型请求格式无效");
          const hasMedia = body.messages.some((item: any) => Array.isArray(item.content) && item.content.some((part: any) => part.type !== "text"));
          // ACT: 文本用 UTF-8 字节数加协议余量作保守上界，不采信客户端历史 usage。
          // 媒体无法据 URL/字节数推算视觉 token，必须按模型整个上下文窗口预占。
          const inputTokens = Buffer.byteLength(JSON.stringify(body)) + 1024 + body.messages.length * 64 + (body.tools?.length ?? 0) * 128;
          const requested = body.max_completion_tokens ?? body.max_tokens ?? model.maxTokens;
          const maxOutput = Math.min(requested, model.maxTokens, access.maxOutputTokens ?? model.maxTokens);
          const contextWindow = hasMedia ? access.contextWindow ?? model.contextWindow : Math.min(model.contextWindow, access.contextWindow ?? model.contextWindow);
          reservation = embed.reserveTrialTokens(tenant.workspaceId, model.id, inputTokens, maxOutput, contextWindow, hasMedia);
          const tokenField = "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
          delete body.max_tokens;
          delete body.max_completion_tokens;
          return { ...body, [tokenField]: reservation.maxOutputTokens, n: 1, stream: true, stream_options: { ...body.stream_options, include_usage: true } };
        },
      });
      // 完成事件必须等结算成功后才交给 Agent，避免结算失败后继续执行工具或下一轮。
      for await (const event of stream) if (event.type !== "done" && event.type !== "error") output.push(event);
      message = await stream.result();
      if (reservation) {
        const values = [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite, message.usage.totalTokens];
        const tokens = values.every(value => Number.isSafeInteger(value) && value >= 0)
          ? Math.max(message.usage.totalTokens, values.slice(0, 4).reduce((sum, value) => sum + value, 0)) : 0;
        const completed = ["stop", "length", "toolUse"].includes(message.stopReason);
        finalized = true;
        embed.settleTrialTokens(tenant.workspaceId, reservation.id, !sent || rejected ? 0 : completed && tokens > 0 ? tokens : null);
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") output.push({ type: "error", reason: message.stopReason, error: message });
      else output.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
      output.end(message);
    } catch (error) {
      if (reservation && !finalized && embed && tenant) {
        try { embed.settleTrialTokens(tenant.workspaceId, reservation.id, !sent || rejected ? 0 : null); }
        catch (settlementError) { error = settlementError; }
      }
      const failure: AssistantMessage = { role: "assistant", content: message?.content ?? [], api: model.api, provider: model.provider, model: model.id,
        usage: message?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? "aborted" : "error", timestamp: Date.now(), errorMessage: error instanceof Error ? error.message : String(error) };
      output.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
      output.end(failure);
    }
  })();
  return output;
}
