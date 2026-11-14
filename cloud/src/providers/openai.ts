import { guardedFetch } from "@toonflow/providers/http";
import { readUpload, uploadMaxBytes } from "../upload.ts";
import { ProviderError, type GenRequest, type PollResult, type ProviderAdapter } from "./adapter.ts";

const hdr = (key?: string) => ({ ...(key ? { authorization: `Bearer ${key}` } : {}) });
const fail = async (r: Response) => {
    await r.body?.cancel();
    // Never echo request headers; provider bodies are truncated and redacted by the logger.
    throw Object.assign(new ProviderError(`provider HTTP ${r.status}`, r.status >= 500 || r.status === 429), { requestRejected: [400, 401, 403, 404, 422, 429].includes(r.status) });
};
const reportedCost = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const url = (base: string | undefined, p: string) => `${(base ?? "https://api.openai.com/v1").replace(/\/$/, "")}${p}`;

export async function readProviderResponse(response: Response, maxBytes = uploadMaxBytes) {
    return readUpload(new Request("https://upstream.invalid", { method: "POST", headers: response.headers, body: response.body, ...(response.body ? { duplex: "half" } : {}) }), maxBytes);
}

export async function fetchMediaOutput(u: string, key?: string, signal?: AbortSignal, maxBytes = uploadMaxBytes) {
    const r = await guardedFetch(u, { headers: hdr(key), signal: signal ?? AbortSignal.timeout(120000) });
    if (!r.ok) await fail(r);
    return { data: await readProviderResponse(r, maxBytes), mime: r.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
}

/** OpenAI-compatible adapter: /images/generations|edits (sync) and /videos (async create → poll → content). Works with most API relays. */
export const openaiAdapter: ProviderAdapter = {
    requiresKey: true,
    async submit(req: GenRequest) {
        if (req.kind === "text") {
            const imgs = req.inputs.filter((i) => i.data && i.mime.startsWith("image/"));
            const user: any = imgs.length ? [{ type: "text", text: req.prompt }, ...imgs.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data!.toString("base64")}` } }))] : req.prompt;
            const r = await guardedFetch(url(req.baseUrl, "/chat/completions"), { method: "POST", signal: req.signal, headers: { ...hdr(req.apiKey), "content-type": "application/json" }, body: JSON.stringify({ model: req.externalModelId, messages: [...(req.params.system ? [{ role: "system", content: String(req.params.system) }] : []), { role: "user", content: user }], max_tokens: req.params.maxOutputTokens ?? 4096, response_format: req.params.json ? { type: "json_object" } : undefined }) });
            if (!r.ok) await fail(r);
            const j: any = JSON.parse((await readProviderResponse(r)).toString("utf8"));
            const u = j.usage ?? {};
            const cost = reportedCost(u.cost);
            return { done: { outputs: [{ data: Buffer.from(j.choices?.[0]?.message?.content ?? ""), mime: "text/plain" }], costUsd: cost } };
        }
        if (req.kind === "image") {
            const size = req.params.width && req.params.height ? `${req.params.width}x${req.params.height}` : "auto";
            const imgs = req.inputs.filter((i) => i.data && i.mime.startsWith("image/"));
            let r: Response;
            if (imgs.length) {
                const f = new FormData();
                f.set("model", req.externalModelId);
                f.set("prompt", req.prompt);
                f.set("size", size);
                for (const i of imgs) f.append("image[]", new Blob([new Uint8Array(i.data!)], { type: i.mime }), `${i.role}.png`);
                r = await guardedFetch(url(req.baseUrl, "/images/edits"), { method: "POST", signal: req.signal, headers: hdr(req.apiKey), body: f });
            } else {
                r = await guardedFetch(url(req.baseUrl, "/images/generations"), { method: "POST", signal: req.signal, headers: { ...hdr(req.apiKey), "content-type": "application/json" }, body: JSON.stringify({ model: req.externalModelId, prompt: req.prompt, size, n: req.params.count ?? 1 }) });
            }
            if (!r.ok) await fail(r);
            const body: any = await r.json();
            if (!Array.isArray(body.data) || body.data.length > 20) throw new ProviderError("供应商输出数量无效", false);
            const outputs = [];
            let totalBytes = 0;
            for (const d of body.data) {
                if (typeof d.b64_json === "string" && d.b64_json.length > Math.ceil(uploadMaxBytes / 3) * 4) throw new ProviderError("生成素材过大", false);
                const output = d.b64_json ? { data: Buffer.from(d.b64_json, "base64"), mime: "image/png" } : await fetchMediaOutput(d.url, undefined, req.signal, uploadMaxBytes - totalBytes);
                totalBytes += output.data.length;
                if (totalBytes > uploadMaxBytes) throw new ProviderError("生成素材总大小超限", false);
                outputs.push(output);
            }
            return { done: { outputs, costUsd: reportedCost(body.usage?.cost) } };
        }
        const start = req.inputs.find((i) => i.role === "START_FRAME" && i.data);
        const f = new FormData();
        f.set("model", req.externalModelId);
        f.set("prompt", req.prompt);
        f.set("seconds", String(req.params.duration ?? 4));
        if (req.params.width && req.params.height) f.set("size", `${req.params.width}x${req.params.height}`);
        if (start) f.set("input_reference", new Blob([new Uint8Array(start.data!)], { type: start.mime }), "start.png");
        const r = await guardedFetch(url(req.baseUrl, "/videos"), { method: "POST", signal: req.signal, headers: hdr(req.apiKey), body: f });
        if (!r.ok) await fail(r);
        const body: any = await r.json();
        return { taskId: String(body.id) };
    },
    async poll(taskId, ctx): Promise<PollResult> {
        const r = await guardedFetch(url(ctx.baseUrl, `/videos/${taskId}`), { headers: hdr(ctx.apiKey), signal: ctx.signal });
        if (!r.ok) throw new ProviderError(`poll HTTP ${r.status}`, r.status >= 500 || r.status === 429);
        const b: any = await r.json();
        if (["queued", "in_progress", "processing", "running"].includes(b.status)) return { status: "running" };
        if (["failed", "cancelled", "canceled"].includes(b.status)) return { status: "failed", error: String(b.error?.message ?? b.status), retryable: false };
        if (b.status !== "completed" && b.status !== "succeeded") throw new ProviderError("无法确认远端任务状态", false);
        const out = await fetchMediaOutput(url(ctx.baseUrl, `/videos/${taskId}/content`), ctx.apiKey, ctx.signal);
        return { status: "done", result: { outputs: [{ ...out, duration: Number(b.seconds ?? 4) }], costUsd: reportedCost(b.usage?.cost) } };
    },
    async testConnection(ctx) {
        const t = Date.now();
        try {
            const r = await guardedFetch(url(ctx.baseUrl, "/models"), { headers: hdr(ctx.apiKey), signal: AbortSignal.timeout(10_000) });
            return { ok: r.ok, message: r.ok ? "connected" : `HTTP ${r.status}`, latencyMs: Date.now() - t };
        } catch (e) {
            return { ok: false, message: (e as Error).message, latencyMs: Date.now() - t };
        }
    },
};
