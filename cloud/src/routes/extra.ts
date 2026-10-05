import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { authOf, requireAdmin } from "../auth.ts";
import { all, audit, get, run, setting, setSetting, tx } from "../db.ts";
import { body, ctx, project } from "../http.ts";
import { checkout, fulfil, packs, paymentsOf, plans, setPlan, subscriptionOf, verifyStripe, paymentProvider } from "../billing.ts";
import { buildTimeline, exportPackage, startRender, toEdl, toSrt } from "../domain/assembly.ts";
import { decrypt, encrypt } from "../crypto.ts";
import { kick } from "../jobs.ts";
import { snapshot } from "../metrics.ts";
import { storage, mediaView, saveMedia, usage } from "../storage.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bad, forbidden, notFound, now, ulid } from "../util.ts";
import { config } from "../config.ts";
import { exportCsv, summary } from "../usage.ts";

export const extra = new Hono();

// ---------------- assembly (Phase 5) ----------------
extra.get("/sequences/:id/timeline", (c) => { const { s } = ctx(c); return c.json(buildTimeline(s, c.req.param("id"))); });
extra.get("/sequences/:id/subtitles.srt", (c) => { const { s } = ctx(c); return c.text(toSrt(buildTimeline(s, c.req.param("id"))), 200, { "content-type": "application/x-subrip; charset=utf-8" }); });
extra.get("/sequences/:id/timeline.edl", (c) => { const { s } = ctx(c); const q = s.get("sequences", c.req.param("id")); if (!q) throw notFound("sequence"); return c.text(toEdl(buildTimeline(s, q.id), q.name), 200, { "content-type": "text/plain; charset=utf-8" }); });
extra.get("/sequences/:id/export", async (c) => {
    const { s } = ctx(c);
    const r = await exportPackage(s, c.req.param("id"));
    return new Response(new Uint8Array(r.zip), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${r.name}"` } });
});
extra.post("/sequences/:id/render", async (c) => {
    const { s, a } = ctx(c, "EDITOR");
    const q = s.get("sequences", c.req.param("id"));
    if (!q) throw notFound("sequence");
    const o = await body(c, z.object({ normalizeAudio: z.boolean().default(true), targetLufs: z.number().min(-40).max(-5).default(-16), burnSubtitles: z.boolean().default(false) }));
    return c.json(startRender(a.workspaceId, q.projectId, q.id, a.user.id, o), 202);
});
extra.get("/sequences/:id/renders", (c) => {
    const { s } = ctx(c);
    return c.json(s.list("renders", { sequenceId: c.req.param("id") }, "created_at DESC").map((r: any) => ({ id: r.id, status: r.status, error: r.error, createdAt: r.createdAt, media: r.mediaId ? mediaView(s.get("media", r.mediaId)) : null })));
});
extra.put("/sequences/:id/subtitles", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ lines: z.array(z.object({ shotId: z.string(), text: z.string() })) }));
    for (const l of b.lines) {
        const sh = s.get("shots", l.shotId);
        if (!sh || sh.sequenceId !== c.req.param("id")) throw notFound("shot");
        const { id, workspaceId, projectId, sequenceId, sceneId, ord, schemaVersion, status, heroKeyframeId, approvedTakeId, createdAt, updatedAt, deletedAt, ...data } = sh;
        s.update("shots", sh.id, { data: { ...data, subtitle: l.text } });
    }
    return c.json({ ok: true });
});

// ---------------- chunked / resumable upload (P2) ----------------
// init → PUT parts (any order, retriable, idempotent) → GET status (resume) → complete. Parts live on disk until complete; stale sessions are swept.
const upDir = (ws: string, id: string) => join(config.dataDir, "uploads", ws, id);
const PART_MAX = 16 * 1024 * 1024;
extra.post("/media/uploads", async (c) => {
    const { a, s } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ size: z.number().int().positive().max(200 * 1024 * 1024), parts: z.number().int().min(1).max(2000), projectId: z.string().optional() }));
    if (b.projectId && !s.get("projects", b.projectId)) throw notFound("project");
    const q = get("SELECT quota_bytes FROM workspaces WHERE id=?", a.workspaceId)!;
    if (usage(a.workspaceId).bytes + b.size > q.quota_bytes) throw bad("storage quota exceeded");
    const id = ulid();
    mkdirSync(upDir(a.workspaceId, id), { recursive: true });
    writeFileSync(join(upDir(a.workspaceId, id), "meta.json"), JSON.stringify({ ...b, createdAt: Date.now() }));
    return c.json({ uploadId: id, partMaxBytes: PART_MAX }, 201);
});
const upMeta = (ws: string, id: string) => {
    if (!/^[0-9A-Z]{26}$/.test(id) || !existsSync(join(upDir(ws, id), "meta.json"))) throw notFound("upload");
    return JSON.parse(readFileSync(join(upDir(ws, id), "meta.json"), "utf8"));
};
extra.put("/media/uploads/:id/:part", async (c) => {
    const { a } = ctx(c, "EDITOR");
    const meta = upMeta(a.workspaceId, c.req.param("id"));
    const n = Number(c.req.param("part"));
    if (!Number.isInteger(n) || n < 0 || n >= meta.parts) throw bad("part out of range");
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length || buf.length > PART_MAX) throw bad("bad part size");
    writeFileSync(join(upDir(a.workspaceId, c.req.param("id")), `part-${n}`), buf);
    return c.json({ part: n, bytes: buf.length });
});
extra.get("/media/uploads/:id", (c) => {
    const { a } = ctx(c);
    const meta = upMeta(a.workspaceId, c.req.param("id"));
    const received = readdirSync(upDir(a.workspaceId, c.req.param("id"))).filter((f) => f.startsWith("part-")).map((f) => Number(f.slice(5))).sort((x, y) => x - y);
    return c.json({ parts: meta.parts, received, missing: Array.from({ length: meta.parts }, (_, i) => i).filter((i) => !received.includes(i)) });
});
extra.post("/media/uploads/:id/complete", async (c) => {
    const { a } = ctx(c, "EDITOR");
    const id = c.req.param("id"), meta = upMeta(a.workspaceId, id), d = upDir(a.workspaceId, id);
    const bufs: Buffer[] = [];
    for (let i = 0; i < meta.parts; i++) { const f = join(d, `part-${i}`); if (!existsSync(f)) throw bad(`part ${i} missing`, { missing: [i] }); bufs.push(readFileSync(f)); }
    const all = Buffer.concat(bufs);
    if (all.length !== meta.size) throw bad(`size mismatch: expected ${meta.size}, got ${all.length}`);
    const m = await saveMedia(a.workspaceId, meta.projectId ?? null, all, { source: "upload" }); // same magic-byte / quota validation as single-shot upload
    rmSync(d, { recursive: true, force: true });
    return c.json(mediaView(m), 201);
});
/** Abandoned upload sessions older than a day are removed. */
export function sweepUploads(maxAgeMs = 24 * 3600_000) {
    const root = join(config.dataDir, "uploads");
    if (!existsSync(root)) return 0;
    let n = 0;
    for (const ws of readdirSync(root)) for (const id of readdirSync(join(root, ws))) {
        const p = join(root, ws, id);
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) { rmSync(p, { recursive: true, force: true }); n++; }
    }
    return n;
}

// ---------------- usage & spend receipts ----------------
extra.get("/usage/summary", (c) => { const { a } = ctx(c); return c.json(summary(a.workspaceId, Math.min(365, Number(c.req.query("days") ?? 30) || 30), c.req.query("period") === "month" ? "month" : undefined)); });
extra.get("/usage/export.csv", (c) => { const { a } = ctx(c); return c.text(exportCsv(a.workspaceId), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="usage.csv"' }); });

// ---------------- billing ----------------
extra.get("/billing", (c) => {
    const { a } = ctx(c);
    return c.json({ subscription: subscriptionOf(a.workspaceId), plans: plans(), packs: packs(), paymentProvider: paymentProvider().id, payments: paymentsOf(a.workspaceId) });
});
extra.post("/billing/checkout", async (c) => {
    const { a } = ctx(c, "OWNER");
    const b = await body(c, z.object({ kind: z.enum(["pack", "plan"]), id: z.string() }));
    return c.json(await checkout(a.workspaceId, b.kind, b.id, `${config.publicUrl}/studio/settings`));
});
/** Stripe webhook: signature verified over the raw body; fulfilment is idempotent. */
extra.post("/webhooks/stripe", async (c) => {
    const secret = process.env.LITTO_STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "not configured" }, 404);
    const raw = await c.req.text();
    if (!verifyStripe(raw, c.req.header("stripe-signature"), secret)) return c.json({ error: "bad signature" }, 400);
    const ev = JSON.parse(raw);
    if (ev.type === "checkout.session.completed") { const id = ev.data?.object?.client_reference_id; if (id && get("SELECT 1 FROM payments WHERE id=?", id)) fulfil(id); }
    return c.json({ received: true });
});

// ---------------- provider callbacks (PRD §16: Callback/Webhook) ----------------
/**
 * Providers that finish asynchronously POST here. Body: {taskId, status:'done'|'failed', outputs?:[{b64,mime,duration?}|{url,mime?}], costUsd?, error?}.
 * Header X-LITTO-Signature = hex HMAC-SHA256(provider webhook secret, raw body).
 */
extra.post("/webhooks/providers/:providerId", async (c) => {
    const p = get("SELECT * FROM providers WHERE id=?", c.req.param("providerId"));
    if (!p?.webhook_secret) return c.json({ error: "not configured" }, 404);
    const raw = await c.req.text();
    const want = createHmac("sha256", decrypt(JSON.parse(p.webhook_secret))).update(raw).digest("hex");
    const got = c.req.header("x-litto-signature") ?? "";
    if (want.length !== got.length || !timingSafeEqual(Buffer.from(want), Buffer.from(got))) return c.json({ error: "bad signature" }, 400);
    const payload = JSON.parse(raw);
    const job = get("SELECT id FROM generation_jobs WHERE provider_id=? AND provider_task_id=?", p.id, String(payload.taskId));
    if (!job) return c.json({ error: "unknown task" }, 404);
    run("INSERT INTO webhook_events VALUES(?,?,?,?,?)", ulid(), job.id, p.id, raw, now());
    kick();
    return c.json({ received: true });
});

// ---------------- admin extras ----------------
export const adminExtra = new Hono();
adminExtra.use("*", requireAdmin);
adminExtra.post("/providers/:id/webhook-secret", (c) => {
    if (!get("SELECT 1 FROM providers WHERE id=?", c.req.param("id"))) throw notFound("provider");
    const secret = randomBytes(24).toString("hex");
    run("UPDATE providers SET webhook_secret=? WHERE id=?", JSON.stringify(encrypt(secret)), c.req.param("id"));
    audit(authOf(c).user.id, "provider.webhook_secret", c.req.param("id"));
    // Shown once; only the encrypted form is stored.
    return c.json({ secret, url: `${config.publicUrl}/webhooks/providers/${c.req.param("id")}`, header: "X-LITTO-Signature: hex(HMAC-SHA256(secret, rawBody))" });
});
adminExtra.get("/usage", (c) => c.json(summary(null, Math.min(365, Number(c.req.query("days") ?? 30) || 30))));
adminExtra.get("/plans", (c) => c.json({ plans: plans(), packs: packs() }));
adminExtra.put("/plans", async (c) => {
  const itemSchema = z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(100), priceUsd: z.number().finite().nonnegative().max(1e9), credits: z.number().finite().nonnegative().max(1e9) });
  const b = await body(c, z.object({
    plans: z.array(itemSchema.extend({ period: z.enum(["free", "monthly", "quarterly", "annual", "custom"]), storageGb: z.number().finite().nonnegative().max(1e6) }).strict()).min(1).max(100),
    packs: z.array(itemSchema.strict()).max(100),
  }).strict());
  if (new Set(b.plans.map(plan => plan.id)).size !== b.plans.length || new Set(b.packs.map(pack => pack.id)).size !== b.packs.length) throw bad("套餐和积分包 ID 不能重复");
  if (!b.plans.some(plan => plan.id === "free" && plan.period === "free" && plan.priceUsd === 0)) throw bad("必须保留免费的 free 套餐");
  const currentPlans = plans();
  const currentPacks = packs();
  if (b.plans.length !== currentPlans.length || b.packs.length !== currentPacks.length || currentPlans.some(plan => !b.plans.some(item => item.id === plan.id)) || currentPacks.some(pack => !b.packs.some(item => item.id === pack.id))) throw bad("请保留现有套餐和积分包，仅编辑价格与积分");
  tx(() => {
    setSetting("plans", currentPlans.map(plan => { const item = b.plans.find(item => item.id === plan.id)!; return { ...plan, priceUsd: item.priceUsd, credits: item.credits }; }));
    setSetting("packs", currentPacks.map(pack => { const item = b.packs.find(item => item.id === pack.id)!; return { ...pack, priceUsd: item.priceUsd, credits: item.credits }; }));
    audit(authOf(c).user.id, "pricing.catalogue.update", undefined, b);
  });
  return c.json({ plans: plans(), packs: packs() });
});
adminExtra.put("/workspaces/:id/subscription", async (c) => {
    const b = await body(c, z.object({ planId: z.string(), grantCredits: z.boolean().default(false), custom: z.object({ credits: z.number().optional(), storageGb: z.number().optional(), months: z.number().optional() }).optional() }));
    const plan = plans().find((p) => p.id === b.planId);
    if (!plan) throw notFound("plan");
    if (!get("SELECT 1 FROM workspaces WHERE id=?", c.req.param("id"))) throw notFound("workspace");
    setPlan(c.req.param("id"), { ...plan, credits: b.custom?.credits ?? plan.credits, storageGb: b.custom?.storageGb ?? plan.storageGb }, b.grantCredits, "admin");
    audit(authOf(c).user.id, "subscription.set", c.req.param("id"), b);
    return c.json({ ok: true, subscription: subscriptionOf(c.req.param("id")) });
});
adminExtra.get("/payments", (c) => c.json(all("SELECT * FROM payments ORDER BY created_at DESC LIMIT 300")));
adminExtra.get("/metrics.txt", (c) => {
    const m = snapshot();
    const q = (st: string) => get("SELECT COUNT(*) n FROM generation_jobs WHERE status=?", st)!.n;
    const lines = [`litto_queue_depth{status="QUEUED"} ${q("QUEUED")}`, `litto_queue_depth{status="RUNNING"} ${q("RUNNING")}`, `litto_storage_bytes ${get("SELECT COALESCE(SUM(size),0) b FROM media WHERE deleted_at IS NULL")!.b}`];
    for (const [k, v] of Object.entries(m.counters)) lines.push(`litto_${k.replace(/[^\w]/g, "_")} ${v}`);
    for (const [k, v] of Object.entries(m.latency)) lines.push(`litto_${k.replace(/[^\w]/g, "_")}_avg ${v.avgMs.toFixed(2)}`, `litto_${k.replace(/[^\w]/g, "_")}_count ${v.count}`);
    return c.text(lines.join("\n") + "\n");
});
void project; void forbidden; void bad; void setting; void storage;
