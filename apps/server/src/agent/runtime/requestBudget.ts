import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { resizeImage, type AgentSession } from "@earendil-works/pi-coding-agent";
import { modelAccess } from "@/utils/modelAvailability";
import { cloud } from "@/lib/cloud";
import { assertModelSelection } from "@/utils/modelSelection";
import { compactProductionRead } from "@toonflow/tool-media-generation/runtime";

const requestBytes = 1800 * 1024;
const historyImageNote = "[历史图片预览已省略；原始素材与会话记录保留，需要检查细节时请按原路径重新读取。]";

// ACT: 只转换出站副本，不修改会话或素材。预算独立于供应商的 token 窗口。
export function createRequestBudget() {
  const previews = new Map<string, { data: string; mimeType: string }>();
  async function prepare(payload: unknown, reduced = false, tokenHubVideo = false): Promise<Record<string, unknown>> {
    const body = structuredClone(payload) as Record<string, unknown>;
    const compactText = (text: string) => {
      try {
        const parsed = JSON.parse(text);
        const compact = compactProductionRead(parsed);
        return compact === parsed ? text : JSON.stringify(compact);
      } catch { return text; }
    };
    // 旧会话也在出站副本中去除总览的重复提示词；不裁剪用户指令、工具调用或质检证据。
    const messages = body.messages ?? body.input;
    for (const message of (Array.isArray(messages) ? messages : []) as Record<string, any>[]) {
      if (!message || typeof message !== "object") continue;
      if (message.role === "tool" && typeof message.content === "string") message.content = compactText(message.content);
      if (message.type === "function_call_output" && typeof message.output === "string") message.output = compactText(message.output);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (message.role === "tool" && part.type === "text") part.text = compactText(part.text);
        if (part.type === "tool_result") {
          if (typeof part.content === "string") part.content = compactText(part.content);
          else for (const content of Array.isArray(part.content) ? part.content : []) if (content.type === "text") content.text = compactText(content.text);
        }
      }
    }
    const images: { part: Record<string, any>; kind: string; data: string; mime: string }[] = [];
    let videoBytes = 0;
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const part = value as Record<string, any>;
      if (tokenHubVideo && part.type === "video_url" && typeof part.video_url?.url === "string" && part.video_url.url.startsWith("data:video/")) videoBytes += Buffer.byteLength(part.video_url.url);
      const url = part.type === "image_url" ? part.image_url?.url : part.type === "input_image" ? part.image_url : undefined;
      const data = typeof url === "string" ? /^data:(image\/[^;,]+);base64,([\s\S]+)$/.exec(url) : null;
      if (data) images.push({ part, kind: part.type, mime: data[1]!, data: data[2]! });
      else if (part.type === "image" && part.source?.type === "base64")
        images.push({ part, kind: part.type, mime: part.source.media_type, data: part.source.data });
      else Object.values(part).forEach(visit);
    }
    // 不遍历工具 schema 或元数据，仅处理模型消息中的媒体块。
    visit(body.messages ?? body.input ?? body.contents);
    const keep = reduced ? 2 : 4;
    for (let index = 0; index < images.length; index++) {
      const { part, kind, data, mime } = images[index]!;
      if (index < images.length - keep) {
        for (const key of Object.keys(part)) delete part[key];
        Object.assign(part, { type: kind === "input_image" ? "input_text" : "text", text: historyImageNote });
        continue;
      }
      const maxBytes = (reduced ? 64 : 192) * 1024;
      const key = createHash("sha256").update(data).update(String(maxBytes)).digest("hex");
      let preview = previews.get(key);
      if (!preview) {
        preview = data.length <= Math.floor(maxBytes / 3) * 4 ? { data, mimeType: mime }
          : await resizeImage(Buffer.from(data, "base64"), mime, { maxWidth: 1280, maxHeight: 1280, maxBytes }) ?? undefined;
        if (!preview || preview.data.length > Math.ceil(maxBytes / 3) * 4)
          throw new Error("图片预览压缩失败，原图已保留。请缩小本次参考图片后重试。");
        if (previews.size >= 16) previews.delete(previews.keys().next().value!);
        previews.set(key, preview);
      }
      if (kind === "image") part.source = { type: "base64", media_type: preview.mimeType, data: preview.data };
      else if (kind === "input_image") part.image_url = `data:${preview.mimeType};base64,${preview.data}`;
      else part.image_url = { ...part.image_url, url: `data:${preview.mimeType};base64,${preview.data}` };
    }
    const bytes = Buffer.byteLength(JSON.stringify(body));
    // ACT: 本地超限先使用现有减量档；不发送注定失败的请求，也不等待模型或 413 才减量。
    if (bytes - videoBytes > requestBytes && !reduced && images.length) return prepare(payload, true, tokenHubVideo);
    if (bytes - videoBytes > requestBytes || videoBytes && bytes > 100 * 1024 * 1024) throw new Error(`本次模型请求为 ${(bytes / 1024 / 1024).toFixed(2)} MB，超过请求预算。请减少文字上下文或视频/附件后重试，原始记录未改动。`);
    return body;
  }
  return prepare;
}

export function installRequestBudget(session: AgentSession) {
  const prepare = createRequestBudget();
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    const access = model.provider === cloud()?.trialProviderId ? undefined : modelAccess("text", model.provider, model.id);
    const output = createAssistantMessageEventStream();
    void (async () => {
      let last: AssistantMessage | undefined;
      try {
        assertModelSelection("text", model.provider, model.id);
        access?.assert();
        for (let attempt = 0; attempt < 2; attempt++) {
          const stream = await streamFunction(model, context, { ...options,
            onPayload: async (payload, requestModel) => prepare(await options?.onPayload?.(payload, requestModel) ?? payload, attempt > 0,
              /^(?:tokenhub|tokenhub-intl)\.tencentmaas\.(?:com|cn)$/.test(new URL(model.baseUrl).hostname)),
          });
          const pending: AssistantMessageEvent[] = [];
          let emitted = false;
          let retry = false;
          for await (const event of stream) {
            if (event.type === "start") { pending.push(event); continue; }
            if (event.type === "error" && !emitted && attempt === 0 && !options?.signal?.aborted
              && /\b413\b|length limit exceeded|request body too large/i.test(event.error.errorMessage ?? "")) {
              retry = true;
              break;
            }
            for (const start of pending.splice(0)) output.push(start);
            emitted = true;
            output.push(event);
          }
          last = await stream.result();
          if (!retry && last.stopReason === "error") access?.failed(last.errorMessage);
          if (!retry) { output.end(last); return; }
        }
      } catch (error) {
        const failure: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: options?.signal?.aborted ? "aborted" : "error", timestamp: Date.now(), errorMessage: error instanceof Error ? error.message : String(error) };
        output.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
        output.end(failure);
        return;
      }
      output.end(last);
    })();
    return output;
  };
}
