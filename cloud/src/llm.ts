import { get, scoped, tx } from "./db.ts";
import { charge, creditsFor, hold, release } from "./credits.ts";
import { ADAPTERS, credentialFor, markCredential, secretOf } from "./providers/registry.ts";
import { mustRoute, resolvePolicy } from "./providers/router.ts";
import { storage } from "./storage.ts";
import { bad, now, ulid, redact, log } from "./util.ts";
import { requireModelAccess, assertWorkspaceEditor } from "./auth.ts";

/**
 * LLM layer (PRD §12–§13 "Skills output structured specs"): text/vision calls go through the same
 * Provider → Router → Credential → Ledger path as media, and are recorded as generation jobs for cost/history.
 * Returns null when no usable text model exists, so callers fall back to the deterministic skills.
 */
export async function runText(o: { workspaceId: string; projectId: string | null; actor: string; system: string; prompt: string; json?: boolean; imageMediaIds?: string[]; frames?: { data: Buffer; mime: string }[]; label: string; mockEcho?: string }) {
    requireModelAccess(o.actor);
    assertWorkspaceEditor(o.workspaceId, o.actor);
    const scope = scoped(o.workspaceId);
    if (o.projectId && !scope.get("projects", o.projectId)) throw bad("项目不存在或无权访问");
    const need = o.imageMediaIds?.length || o.frames?.length ? ["vision"] : [];
    let routed;
    try { routed = mustRoute({ kind: "text", need, workspaceId: o.workspaceId, projectId: o.projectId, roles: [], policy: resolvePolicy(o.workspaceId, o.projectId) }); } catch { return null; }
    const m = get("SELECT * FROM models WHERE id=?", routed.chosen!.modelId)!;
    const prov = get("SELECT * FROM providers WHERE id=?", m.provider_id)!;
    const ad = ADAPTERS[prov.adapter];
    const cred = credentialFor(prov.id, o.workspaceId, o.projectId);
    const platformFunded = ad.requiresKey && cred?.scope === "platform";
    if (ad.requiresKey && !cred) throw bad("模型凭据不可用");
    const inputs = [];
    for (const frame of o.frames ?? []) inputs.push({ role: "VISION", mime: frame.mime, data: frame.data, weight: 1 });
    for (const id of o.imageMediaIds ?? []) {
        const x = scope.get("media", id);
        if (!x || x.projectId !== o.projectId || !x.mime.startsWith("image/")) throw bad("参考图片不属于当前项目或已删除");
        inputs.push({ role: "VISION", mime: x.mime, data: await storage.get(x.storageKey), weight: 1 });
    }
    assertWorkspaceEditor(o.workspaceId, o.actor);
    requireModelAccess(o.actor);
    const est = creditsFor(JSON.parse(m.price).perCall ?? null);
    if (platformFunded && !(est > 0)) throw bad("平台文本模型须开启积分计费并配置有效的按次单价");
    const id = ulid();
    const s = scoped(o.workspaceId);
    const t0 = Date.now();
    tx(() => {
        hold(o.workspaceId, id, est);
        s.insert("generation_jobs", { id, project_id: o.projectId, kind: "text", provider_id: prov.id, model_id: m.id, model_version: m.external_model_id, compiled_prompt: o.prompt.slice(0, 4000), parameters: { label: o.label }, input_refs: [], status: "RUNNING", attempts: 1, max_attempts: 1, run_after: now(), estimated_cost: 0, held: est, created_by: o.actor, fallback_chain: [m.id], started_at: now() });
    });
    try {
        const sub = await ad.submit({ kind: "text", externalModelId: m.external_model_id, prompt: prov.adapter === "mock" && o.mockEcho ? `${o.prompt}\n<<ECHO_JSON>>${o.mockEcho}` : o.prompt, signal: AbortSignal.timeout(prov.timeout_ms), params: { system: o.system, json: !!o.json, maxOutputTokens: JSON.parse(m.limits ?? "{}").maxOutputTokens ?? 4096 }, inputs, apiKey: cred ? secretOf(cred) : undefined, baseUrl: prov.base_url, attempt: 1, label: o.label });
        if (!("done" in sub)) throw new Error("text provider returned an async task (unsupported)");
        const text = sub.done.outputs[0]?.data.toString("utf8") ?? "";
        const user = platformFunded && sub.done.costUsd === null ? est : creditsFor(sub.done.costUsd);
        tx(() => {
            s.update("generation_jobs", id, { status: "SUCCEEDED", actual_cost: sub.done.costUsd, user_charge: user, duration_ms: Date.now() - t0, finished_at: now(), held: 0 });
            charge(o.workspaceId, id, est, user, sub.done.costUsd);
        });
        if (cred) { try { markCredential(cred.id, null); } catch (error) { log.error("credential usage tracking failed", error); } }
        return { text, modelId: m.id, jobId: id };
    } catch (e) {
        const rejected = (e as { requestRejected?: boolean }).requestRejected === true;
        const message = redact((e as Error).message);
        tx(() => {
            s.update("generation_jobs", id, { status: "FAILED", error: (rejected ? message : "供应商结果待核查，未释放冻结额：" + message).slice(0, 300), finished_at: now(), held: rejected ? 0 : est });
            if (rejected) release(o.workspaceId, id, est, "provider rejected text call");
        });
        if (cred) { try { markCredential(cred.id, message); } catch (error) { log.error("credential usage tracking failed", error); } }
        throw bad(`LLM call failed: ${message}`);
    }
}

/** Extract a JSON object/array from a model reply that may be wrapped in prose or code fences. */
export function parseJson(text: string): unknown {
    const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { return JSON.parse(t); } catch { /* fall through */ }
    const i = Math.min(...["{", "["].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
    const j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (i === Infinity || j < i) throw new Error("no JSON in reply");
    return JSON.parse(t.slice(i, j + 1));
}
