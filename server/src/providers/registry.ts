import { all, audit, camel, get, run, setting, tx } from "../db.ts";
import { decrypt, encrypt, mask } from "../crypto.ts";
import { bad, j, notFound, now, ulid } from "../util.ts";
import type { ProviderAdapter } from "./adapter.ts";
import { mockAdapter } from "./mock.ts";
import { openaiAdapter } from "./openai.ts";

export const ADAPTERS: Record<string, ProviderAdapter> = { mock: mockAdapter, "openai-compatible": openaiAdapter };

export const CAPABILITIES = [
    "text2image", "imageEdit", "identityReference", "multiReference", "compositionReference",
    "text2video", "image2video", "startEndFrame", "motionReference", "cameraControl", "nativeAudio",
] as const;

export const providerView = (p: any) => ({
    id: p.id, name: p.name, adapter: p.adapter, baseUrl: p.base_url, authType: p.auth_type, status: p.status, priority: p.priority,
    concurrency: p.concurrency, timeoutMs: p.timeout_ms, retryPolicy: JSON.parse(p.retry_policy), hasPlatformCredential: !!credentialFor(p.id, null, null, true),
});

export function modelView(m: any) {
    const caps: Record<string, any> = {};
    for (const c of all("SELECT capability, value FROM model_capabilities WHERE model_id=?", m.id)) caps[c.capability] = JSON.parse(c.value);
    return {
        id: m.id, providerId: m.provider_id, externalModelId: m.external_model_id, name: m.name, type: m.type, capabilities: caps,
        limits: JSON.parse(m.limits), resolutions: JSON.parse(m.resolutions), aspectRatios: JSON.parse(m.aspect_ratios), durations: JSON.parse(m.durations),
        price: JSON.parse(m.price), status: m.status, priority: m.priority, fallbackModelId: m.fallback_model_id,
        costClass: caps.costClass ?? "mid", latencyClass: caps.latencyClass ?? "mid",
    };
}

export function upsertProvider(id: string | null, d: any) {
    const pid = id ?? d.id ?? ulid();
    const ex = get("SELECT * FROM providers WHERE id=?", pid);
    if (!ex && !d.adapter) throw bad("adapter required");
    if (d.adapter && !ADAPTERS[d.adapter]) throw bad(`unknown adapter ${d.adapter}`);
    const v = {
        name: d.name ?? ex?.name, adapter: d.adapter ?? ex?.adapter, base_url: d.baseUrl ?? ex?.base_url ?? null, auth_type: d.authType ?? ex?.auth_type ?? "bearer",
        status: d.status ?? ex?.status ?? "active", priority: d.priority ?? ex?.priority ?? 100, concurrency: d.concurrency ?? ex?.concurrency ?? 4,
        timeout_ms: d.timeoutMs ?? ex?.timeout_ms ?? 120000, retry_policy: j(d.retryPolicy ?? (ex ? JSON.parse(ex.retry_policy) : { maxAttempts: 2, backoffMs: 500 })),
    };
    if (ex) run("UPDATE providers SET name=?,adapter=?,base_url=?,auth_type=?,status=?,priority=?,concurrency=?,timeout_ms=?,retry_policy=?,updated_at=? WHERE id=?", ...Object.values(v), now(), pid);
    else run("INSERT INTO providers(id,name,adapter,base_url,auth_type,status,priority,concurrency,timeout_ms,retry_policy,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", pid, ...Object.values(v), now(), now());
    return providerView(get("SELECT * FROM providers WHERE id=?", pid));
}

export function upsertModel(id: string | null, d: any) {
    const mid = id ?? d.id ?? ulid();
    const ex = get("SELECT * FROM models WHERE id=?", mid);
    const pv = d.providerId ?? ex?.provider_id;
    if (!get("SELECT 1 FROM providers WHERE id=?", pv)) throw notFound("provider");
    const type = d.type ?? ex?.type;
    if (!["image", "video", "text", "audio"].includes(type)) throw bad("type must be image|video|text|audio");
    tx(() => {
        const vals = [pv, d.externalModelId ?? ex?.external_model_id, d.name ?? ex?.name, type, j(d.limits ?? (ex && JSON.parse(ex.limits)) ?? {}), j(d.resolutions ?? (ex && JSON.parse(ex.resolutions)) ?? []), j(d.aspectRatios ?? (ex && JSON.parse(ex.aspect_ratios)) ?? []), j(d.durations ?? (ex && JSON.parse(ex.durations)) ?? []), j(d.price ?? (ex && JSON.parse(ex.price)) ?? {}), d.status ?? ex?.status ?? "active", d.priority ?? ex?.priority ?? 100, d.fallbackModelId ?? ex?.fallback_model_id ?? null];
        if (ex) run("UPDATE models SET provider_id=?,external_model_id=?,name=?,type=?,limits=?,resolutions=?,aspect_ratios=?,durations=?,price=?,status=?,priority=?,fallback_model_id=?,updated_at=? WHERE id=?", ...vals, now(), mid);
        else run("INSERT INTO models(id,provider_id,external_model_id,name,type,limits,resolutions,aspect_ratios,durations,price,status,priority,fallback_model_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", mid, ...vals, now(), now());
        if (d.capabilities) {
            run("DELETE FROM model_capabilities WHERE model_id=?", mid);
            for (const [k, v] of Object.entries(d.capabilities)) run("INSERT INTO model_capabilities VALUES(?,?,?)", mid, k, j(v));
        }
    });
    return modelView(get("SELECT * FROM models WHERE id=?", mid));
}

export const listProviders = () => all("SELECT * FROM providers ORDER BY priority, name").map(providerView);
export const listModels = (onlyActive = false) => all(`SELECT m.* FROM models m JOIN providers p ON p.id=m.provider_id ${onlyActive ? "WHERE m.status='active' AND p.status='active'" : ""} ORDER BY m.priority`).map(modelView);

// ---- credentials ----
export const credentialView = (c: any) => ({ id: c.id, scope: c.scope, providerId: c.provider_id, projectId: c.project_id, label: c.label, masked: `••••${c.last4 ?? ""}`, enabled: !!c.enabled, lastUsedAt: c.last_used_at, lastError: c.last_error, createdAt: c.created_at });

export function addCredential(scope: "platform" | "workspace" | "project", workspaceId: string | null, d: { providerId: string; secret: string; label?: string; projectId?: string }) {
    if (!get("SELECT 1 FROM providers WHERE id=?", d.providerId)) throw notFound("provider");
    if (!d.secret || d.secret.length < 8) throw bad("secret too short");
    const e = encrypt(d.secret);
    const id = ulid();
    run("INSERT INTO api_credentials(id,workspace_id,scope,project_id,provider_id,label,cipher,iv,tag,last4,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, workspaceId, scope, d.projectId ?? null, d.providerId, d.label ?? null, e.cipher, e.iv, e.tag, d.secret.slice(-4), now(), now());
    return credentialView(get("SELECT * FROM api_credentials WHERE id=?", id));
}

/** Priority: Project Credential → Workspace BYOK → Platform Credential. Returns the row (not plaintext). */
export function credentialFor(providerId: string, workspaceId: string | null, projectId: string | null, platformOnly = false) {
    const q = (scope: string, extra: string, ...p: any[]) => get(`SELECT * FROM api_credentials WHERE provider_id=? AND scope=? AND enabled=1 AND deleted_at IS NULL ${extra} ORDER BY created_at DESC`, providerId, scope, ...p);
    if (!platformOnly && projectId && workspaceId) {
        const c = q("project", "AND workspace_id=? AND project_id=?", workspaceId, projectId);
        if (c) return c;
    }
    if (!platformOnly && workspaceId) {
        const c = q("workspace", "AND workspace_id=?", workspaceId);
        if (c) return c;
    }
    return q("platform", "");
}
export const secretOf = (cred: any) => decrypt({ cipher: cred.cipher, iv: cred.iv, tag: cred.tag });
export function markCredential(id: string, err: string | null) {
    run("UPDATE api_credentials SET last_used_at=?, last_error=? WHERE id=?", now(), err ? err.slice(0, 200) : null, id);
}

export async function testProvider(providerId: string, workspaceId: string | null, projectId: string | null) {
    const p = get("SELECT * FROM providers WHERE id=?", providerId);
    if (!p) throw notFound("provider");
    const ad = ADAPTERS[p.adapter];
    const cred = credentialFor(providerId, workspaceId, projectId);
    if (ad.requiresKey && !cred) return { ok: false, message: "no credential configured", latencyMs: 0 };
    const res = await ad.testConnection({ apiKey: cred ? secretOf(cred) : undefined, baseUrl: p.base_url });
    if (cred) markCredential(cred.id, res.ok ? null : res.message);
    return res;
}

// ---- seeding ----
export function seedProviders() {
    if (get("SELECT 1 FROM providers WHERE id='mock'")) return;
    upsertProvider(null, { id: "mock", name: "Mock Studio (offline)", adapter: "mock", priority: 10, concurrency: 8 });
    upsertProvider(null, { id: "openai-compatible", name: "OpenAI-compatible relay", adapter: "openai-compatible", baseUrl: "https://api.openai.com/v1", status: "disabled", priority: 50 });
    const img = { resolutions: ["1280x720", "1920x1080", "1024x1024"], aspectRatios: ["16:9", "9:16", "1:1", "2.39:1"], limits: { maxInputs: 8 } };
    upsertModel(null, { id: "mock-image-pro", providerId: "mock", externalModelId: "mock-image-pro", name: "Mock Image Pro", type: "image", ...img, price: { perImage: 0.04 }, priority: 10, capabilities: { text2image: true, imageEdit: true, identityReference: true, multiReference: true, compositionReference: true, costClass: "mid", latencyClass: "mid", maxInputs: 8, async: true } });
    upsertModel(null, { id: "mock-image-lite", providerId: "mock", externalModelId: "mock-image-lite", name: "Mock Image Lite", type: "image", ...img, price: { perImage: 0.01 }, priority: 20, capabilities: { text2image: true, costClass: "low", latencyClass: "low", maxInputs: 0, async: true } });
    const vid = { resolutions: ["1280x720", "1920x1080"], aspectRatios: ["16:9", "9:16"], durations: [4, 6, 8], limits: { maxDuration: 8 } };
    upsertModel(null, { id: "mock-video-pro", providerId: "mock", externalModelId: "mock-video-pro", name: "Mock Video Pro", type: "video", ...vid, price: { perSecond: 0.05 }, priority: 10, capabilities: { image2video: true, text2video: true, startEndFrame: true, cameraControl: true, motionReference: true, costClass: "high", latencyClass: "high", maxInputs: 3, async: true }, fallbackModelId: "mock-video-lite" });
    upsertModel(null, { id: "mock-video-lite", providerId: "mock", externalModelId: "mock-video-lite", name: "Mock Video Lite", type: "video", ...vid, price: { perSecond: 0.02 }, priority: 20, capabilities: { image2video: true, costClass: "low", latencyClass: "mid", maxInputs: 1, async: true } });
    upsertModel(null, { id: "oai-gpt-image-1", providerId: "openai-compatible", externalModelId: "gpt-image-1", name: "GPT Image 1", type: "image", ...img, price: { perImage: 0.06 }, status: "disabled", capabilities: { text2image: true, imageEdit: true, multiReference: true, identityReference: true, costClass: "mid", latencyClass: "mid", maxInputs: 8 } });
    upsertModel(null, { id: "oai-sora-2", providerId: "openai-compatible", externalModelId: "sora-2", name: "Sora 2", type: "video", ...vid, price: { perSecond: 0.1 }, status: "disabled", capabilities: { text2video: true, image2video: true, nativeAudio: true, costClass: "high", latencyClass: "high", maxInputs: 1 } });
    audit(null, "system.seed_providers");
}
void setting; void camel; void mask;
