import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authenticate } from "./auth.ts";
import { authPublic, platform } from "./routes/platform.ts";
import { production } from "./routes/production.ts";
import { admin } from "./routes/admin.ts";
import { HttpError, log } from "./util.ts";
import { get, setting } from "./db.ts";
import { checkSignedUrl, storage } from "./storage.ts";
import { inc, observe } from "./metrics.ts";
import { config } from "./config.ts";

export const app = new Hono();

app.use("*", secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], imgSrc: ["'self'", "data:", "blob:"], mediaSrc: ["'self'", "blob:"], styleSrc: ["'self'", "'unsafe-inline'"] } }));

// Dev CORS for the Vite app (cookie auth needs an explicit origin).
app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Access-Control-Allow-Credentials", "true");
        c.header("Access-Control-Allow-Headers", "content-type, authorization, x-workspace-id, x-filmflow-csrf, idempotency-key");
        c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
});

// Metrics + simple per-IP rate limit (token bucket).
const buckets = new Map<string, { t: number; n: number }>();
app.use("*", async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0] ?? "local";
    const limit = c.req.path.startsWith("/auth/") ? 30 : 600;
    const key = `${ip}:${c.req.path.startsWith("/auth/") ? "auth" : "api"}`;
    const b = buckets.get(key) ?? { t: Date.now(), n: 0 };
    if (Date.now() - b.t > 60_000) (b.t = Date.now()), (b.n = 0);
    b.n++;
    buckets.set(key, b);
    if (b.n > limit && !process.env.FILMFLOW_NO_RATELIMIT) return c.json({ error: "rate limited", code: "rate_limited" }, 429);
    const t = Date.now();
    await next();
    observe("api_latency_ms", Date.now() - t);
    inc(`api_status_${Math.floor(c.res.status / 100)}xx`);
});

app.use("*", async (c, next) => {
    if (setting("maintenanceMode", false) && !c.req.path.startsWith("/admin") && !c.req.path.startsWith("/auth") && c.req.path !== "/health") return c.json({ error: "maintenance mode", code: "maintenance" }, 503);
    await next();
});

app.get("/health", (c) => c.json({ ok: true, announcement: setting("announcement", ""), time: new Date().toISOString() }));

// Signed media URLs are the only unauthenticated read path; tokens are HMAC'd and expire.
app.get("/media/:id/file", async (c) => {
    const { exp, sig } = c.req.query();
    const id = c.req.param("id");
    if (!exp || !sig || !checkSignedUrl(id, exp, sig)) return c.json({ error: "invalid or expired link" }, 403);
    const m = get("SELECT * FROM media WHERE id=? AND deleted_at IS NULL", id);
    if (!m) return c.json({ error: "not found" }, 404);
    const buf = await storage.get(m.storage_key);
    // SVG could carry script: serve it inert.
    return new Response(new Uint8Array(buf), { headers: { "content-type": m.mime, "cache-control": "private, max-age=300", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "x-content-type-options": "nosniff" } });
});

app.route("/auth", authPublic);
const secured = new Hono();
secured.use("*", authenticate);
secured.route("/", platform);
secured.route("/", production);
secured.route("/admin", admin);
app.route("/", secured);

app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message, code: e.code, details: e.details }, e.status as any);
    log.error("unhandled", e.stack ?? e.message);
    inc("api_errors");
    return c.json({ error: "internal error", code: "internal" }, 500);
});
app.notFound((c) => c.json({ error: "not found", code: "not_found" }, 404));
void config;
