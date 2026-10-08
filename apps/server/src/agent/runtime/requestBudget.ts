import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { resizeImage, type AgentSession } from "@earendil-works/pi-coding-agent";
import { modelAccess } from "@/utils/modelAvailability";
import { cloud } from "@/lib/cloud";
import { assertModelSelection } from "@/utils/modelSelection";

const requestBytes = 1800 * 1024;
const historyImageNote = "[历史图片预览已省略；原始素材与会话记录保留，需要检查细节时请按原路径重新读取。]";

// ACT: 只转换出站副本，不修改会话或素材。预算独立于供应商的 token 窗口。
export function createRequestBudget() {
  const previews = new Map<string, { data: string; mimeType: string }>();
  return async (payload: unknown, reduced = false) => {
    const body = structuredClone(payload) as Record<string, unknown>;
    const images: { part: Record<string, any>; kind: string; data: string; mime: string }[] = [];
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const part = value as Record<string, any>;
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
    if (bytes > requestBytes) throw new Error(`本次模型请求为 ${(bytes / 1024 / 1024).toFixed(2)} MB，超过 1.76 MB 请求预算。历史图片已减量，原始记录未改动；请压缩文字上下文或减少本次视频/附件，不能原样重试。`);
    return body;
  };
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
            onPayload: async (payload, requestModel) => prepare(await options?.onPayload?.(payload, requestModel) ?? payload, attempt > 0),
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
