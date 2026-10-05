import { Hono } from "hono";
import { z } from "zod";
import { authOf, requireAdmin } from "../auth.ts";
import { all, audit, get, run, setSetting, setting } from "../db.ts";
import { body } from "../http.ts";
import { accountOf, adminAdjust, grant } from "../credits.ts";
import { addCredential, credentialView, listModels, listProviders, upsertModel, upsertProvider, testProvider, ADAPTERS, credentialFor, secretOf } from "../providers/registry.ts";
import { cancelJob, jobView, retryJob } from "../jobs.ts";
import { cleanupMedia } from "../storage.ts";
import { trialReport } from "../trial.ts";
import { scoped } from "../db.ts";
import { bad, notFound, now } from "../util.ts";
import { snapshot } from "../metrics.ts";

export const admin = new Hono();
admin.use("*", requireAdmin);
const actor = (c: any) => authOf(c).user.id;

admin.get("/dashboard", (c) => {
    const one = (sql: string, ...p: any[]) => get(sql, ...p)!;
    const jobs = one("SELECT COUNT(*) n, SUM(kind='image') img, SUM(kind='video') vid, SUM(status='FAILED' OR status='TIMEOUT') failed, SUM(status IN ('SUCCEEDED','FAILED','TIMEOUT')) finished, COALESCE(SUM(actual_cost),0) cost, COALESCE(SUM(user_charge),0) charged FROM generation_jobs");
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    return c.json({
        users: one("SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL").n,
        activeUsers7d: one("SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE created_at>?", week).n,
        generations: { total: jobs.n, images: jobs.img ?? 0, videos: jobs.vid ?? 0 },
        providerCostUsd: jobs.cost, creditsCharged: jobs.charged,
        failureRate: jobs.finished ? (jobs.failed ?? 0) / jobs.finished : 0,
        queue: { queued: one("SELECT COUNT(*) n FROM generation_jobs WHERE status='QUEUED'").n, running: one("SELECT COUNT(*) n FROM generation_jobs WHERE status='RUNNING'").n },
        storage: one("SELECT COALESCE(SUM(size),0) bytes, COUNT(*) files FROM media WHERE deleted_at IS NULL"),
        modelSuccess: all("SELECT model_id, COUNT(*) total, SUM(status='SUCCEEDED') ok FROM generation_jobs GROUP BY model_id"),
        metrics: snapshot(),
    });
});

// Users
admin.get("/users", (c) => {
    const q = `%${(c.req.query("q") ?? "").toLowerCase()}%`;
    const rows = all("SELECT u.id,u.email,u.status,u.is_admin,u.created_at,w.id AS workspace_id,w.name AS workspace, a.balance, a.held, s.plan, (SELECT COUNT(*) FROM generation_jobs g WHERE g.workspace_id=w.id) AS jobs, (SELECT COALESCE(SUM(size),0) FROM media m WHERE m.workspace_id=w.id AND m.deleted_at IS NULL) AS storage_bytes FROM users u LEFT JOIN workspaces w ON w.owner_id=u.id AND w.kind='personal' LEFT JOIN credit_accounts a ON a.workspace_id=w.id LEFT JOIN subscriptions s ON s.workspace_id=w.id WHERE u.deleted_at IS NULL AND lower(u.email) LIKE ? ORDER BY u.created_at DESC LIMIT 200", q);
    return c.json(rows);
});
admin.patch("/users/:id", async (c) => {
    const b = await body(c, z.object({ status: z.enum(["active", "disabled"]) }));
    if (c.req.param("id") === actor(c)) throw bad("cannot change your own status");
    const r = run("UPDATE users SET status=?, updated_at=? WHERE id=? AND deleted_at IS NULL", b.status, now(), c.req.param("id"));
    if (!r.changes) throw notFound("user");
    if (b.status === "disabled") run("DELETE FROM sessions WHERE user_id=?", c.req.param("id"));
    audit(actor(c), `user.${b.status}`, c.req.param("id"));
    return c.json({ ok: true });
});
admin.get("/users/:id/generations", (c) => {
    const ws = get("SELECT id FROM workspaces WHERE owner_id=? AND kind='personal'", c.req.param("id"));
    if (!ws) throw notFound("workspace");
    return c.json(scoped(ws.id).list("generation_jobs", {}, "created_at DESC").slice(0, 100).map(jobView));
});

// Providers / models
admin.get("/providers", (c) => c.json(listProviders()));
admin.post("/providers", async (c) => {
    const b = await body(c, z.object({ id: z.string().optional(), name: z.string(), adapter: z.string(), baseUrl: z.string().optional(), authType: z.string().optional(), status: z.enum(["active", "disabled"]).optional(), priority: z.number().optional(), concurrency: z.number().int().min(1).optional(), timeoutMs: z.number().int().optional(), retryPolicy: z.any().optional() }));
    const p = upsertProvider(null, b);
    audit(actor(c), "provider.create", p.id, { adapter: b.adapter });
    return c.json(p, 201);
});
admin.patch("/providers/:id", async (c) => {
    const b = await body(c, z.object({ name: z.string().optional(), baseUrl: z.string().optional(), status: z.enum(["active", "disabled"]).optional(), priority: z.number().optional(), concurrency: z.number().int().min(1).optional(), timeoutMs: z.number().int().optional(), retryPolicy: z.any().optional() }));
    if (!get("SELECT 1 FROM providers WHERE id=?", c.req.param("id"))) throw notFound("provider");
    const p = upsertProvider(c.req.param("id"), b);
    audit(actor(c), "provider.update", p.id, b);
    return c.json(p);
});
admin.post("/providers/:id/credentials", async (c) => {
    const b = await body(c, z.object({ secret: z.string(), label: z.string().optional() }));
    const v = addCredential("platform", null, { providerId: c.req.param("id"), ...b });
    audit(actor(c), "credential.platform.add", v.id, { providerId: c.req.param("id") }); // never the secret
    return c.json(v, 201);
});
admin.get("/providers/:id/credentials", (c) => c.json(all("SELECT * FROM api_credentials WHERE scope='platform' AND provider_id=? AND deleted_at IS NULL", c.req.param("id")).map(credentialView)));
admin.post("/providers/:id/test", async (c) => c.json(await testProvider(c.req.param("id"), null, null)));
admin.post("/providers/:id/sync-models", async (c) => {
    const p = get("SELECT * FROM providers WHERE id=?", c.req.param("id"));
    if (!p) throw notFound("provider");
    if (p.adapter !== "openai-compatible") return c.json({ synced: 0, note: "adapter has a fixed model catalogue" });
    const cred = credentialFor(p.id, null, null, true);
    if (!cred) throw bad("add a platform credential first");
    const r = await fetch(`${(p.base_url as string).replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${secretOf(cred)}` } });
    if (!r.ok) throw bad(`provider returned HTTP ${r.status}`);
    const list: any = await r.json();
    let n = 0;
    for (const m of list.data ?? []) {
        const id = `${p.id}:${m.id}`;
        if (get("SELECT 1 FROM models WHERE id=?", id)) continue;
        const video = /(sora|video|veo|kling|seedance|wan|runway)/i.test(m.id), image = /(image|dall|flux|midjourney|sd|imagen)/i.test(m.id);
        if (!video && !image) continue;
        upsertModel(null, { id, providerId: p.id, externalModelId: m.id, name: m.id, type: video ? "video" : "image", status: "disabled", capabilities: video ? { text2video: true, image2video: true } : { text2image: true, imageEdit: true } });
        n++;
    }
    audit(actor(c), "provider.sync_models", p.id, { added: n });
    return c.json({ synced: n });
});
admin.get("/models", (c) => c.json(listModels(false)));
admin.post("/models", async (c) => {
    const b = await body(c, z.object({ id: z.string().optional(), providerId: z.string(), externalModelId: z.string(), name: z.string(), type: z.string(), capabilities: z.record(z.any()).default({}), limits: z.any().optional(), resolutions: z.array(z.string()).optional(), aspectRatios: z.array(z.string()).optional(), durations: z.array(z.number()).optional(), price: z.any().optional(), status: z.enum(["active", "disabled"]).optional(), priority: z.number().optional(), fallbackModelId: z.string().nullable().optional() }));
    const m = upsertModel(null, b);
    audit(actor(c), "model.create", m.id);
    return c.json(m, 201);
});
admin.patch("/models/:id", async (c) => {
    if (!get("SELECT 1 FROM models WHERE id=?", c.req.param("id"))) throw notFound("model");
    const b = await body(c, z.object({ name: z.string().optional(), capabilities: z.record(z.any()).optional(), limits: z.any().optional(), price: z.any().optional(), status: z.enum(["active", "disabled"]).optional(), priority: z.number().optional(), fallbackModelId: z.string().nullable().optional() }));
    const m = upsertModel(c.req.param("id"), b);
    audit(actor(c), "model.update", m.id, b);
    return c.json(m);
});

// Jobs
admin.get("/jobs", (c) => {
    const q = c.req.query();
    const rows = all(`SELECT * FROM generation_jobs ${q.status ? "WHERE status=?" : ""} ORDER BY created_at DESC LIMIT 300`, ...(q.status ? [q.status] : []));
    return c.json(rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, kind: r.kind, status: r.status, modelId: r.model_id, providerId: r.provider_id, attempts: r.attempts, error: r.error, estimatedCost: r.estimated_cost, actualCost: r.actual_cost, userCharge: r.user_charge, createdAt: r.created_at, finishedAt: r.finished_at, fallbackChain: JSON.parse(r.fallback_chain ?? "[]") })));
});
admin.post("/jobs/:id/cancel", (c) => {
    const j = get("SELECT workspace_id FROM generation_jobs WHERE id=?", c.req.param("id"));
    if (!j) throw notFound("job");
    cancelJob(j.workspace_id, c.req.param("id"), actor(c));
    return c.json({ ok: true });
});
admin.post("/jobs/:id/retry", (c) => {
    const j = get("SELECT workspace_id FROM generation_jobs WHERE id=?", c.req.param("id"));
    if (!j) throw notFound("job");
    audit(actor(c), "job.retry", c.req.param("id"));
    return c.json(retryJob(j.workspace_id, c.req.param("id"), actor(c)), 201);
});

// Credits
admin.get("/credits/ledger", (c) => c.json(all("SELECT * FROM credit_ledger ORDER BY id DESC LIMIT 500")));
admin.post("/credits/adjust", async (c) => {
    const b = await body(c, z.object({ workspaceId: z.string(), amount: z.number(), type: z.enum(["CREDIT_GRANT", "ADMIN_ADJUSTMENT", "PURCHASE"]).default("ADMIN_ADJUSTMENT"), note: z.string().min(3) }));
    if (!get("SELECT 1 FROM workspaces WHERE id=?", b.workspaceId)) throw notFound("workspace");
    const r = b.type === "ADMIN_ADJUSTMENT" ? adminAdjust(b.workspaceId, b.amount, b.note) : grant(b.workspaceId, b.amount, b.type, b.note);
    audit(actor(c), "credits.adjust", b.workspaceId, b);
    return c.json({ ...r, account: accountOf(b.workspaceId) });
});

// Storage
admin.get("/storage", (c) => c.json({ perWorkspace: all("SELECT w.id, w.name, w.quota_bytes, COALESCE(SUM(m.size),0) bytes, COUNT(m.id) files FROM workspaces w LEFT JOIN media m ON m.workspace_id=w.id AND m.deleted_at IS NULL WHERE w.deleted_at IS NULL GROUP BY w.id ORDER BY bytes DESC"), softDeleted: get("SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM media WHERE deleted_at IS NOT NULL"), orphans: all("SELECT id, workspace_id, size FROM media WHERE workspace_id NOT IN (SELECT id FROM workspaces)") }));
admin.post("/storage/cleanup", async (c) => { const n = await cleanupMedia(0); audit(actor(c), "storage.cleanup", undefined, { removed: n }); return c.json({ removed: n }); });
admin.patch("/storage/quota/:workspaceId", async (c) => {
    const b = await body(c, z.object({ quotaBytes: z.number().int().min(0) }));
    run("UPDATE workspaces SET quota_bytes=? WHERE id=?", b.quotaBytes, c.req.param("workspaceId"));
    audit(actor(c), "storage.quota", c.req.param("workspaceId"), b);
    return c.json({ ok: true });
});

// System
const SYSTEM_KEYS = { platformTrial: { enabled: false, creditsPer1kTokens: 1 }, registrationOpen: true, defaultCredits: 200, maxConcurrency: 4, maxUploadMb: 200, defaultImageModel: "", defaultVideoModel: "", announcement: "", maintenanceMode: false, billingEnabled: true, creditsPerUsd: 100, markup: 1.0, modelPolicy: { optimize: "balanced", allowFallback: true }, pricing: {} } as Record<string, any>;
admin.get("/system", (c) => c.json(Object.fromEntries(Object.entries(SYSTEM_KEYS).map(([k, v]) => [k, setting(k, v)]))));
admin.put("/system", async (c) => {
    const b = await body(c, z.record(z.any()));
    for (const [k, v] of Object.entries(b)) { if (!(k in SYSTEM_KEYS)) throw bad(`unknown setting ${k}`); setSetting(k, v); }
    audit(actor(c), "system.update", undefined, b);
    return c.json({ ok: true });
});

// 实验 1 读数：时间段内新注册用户多快拿到首个文本回复，默认最近 7 天。
admin.get("/experiments/trial", (c) => {
    const until = c.req.query("until") ?? new Date().toISOString();
    const since = c.req.query("since") ?? new Date(Date.parse(until) - 7 * 864e5).toISOString();
    if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) throw bad("since/until 须为 ISO 时间");
    return c.json(trialReport(new Date(since).toISOString(), new Date(until).toISOString()));
});

// Audit
admin.get("/audit", (c) => c.json(all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500").map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }))));
void ADAPTERS;
