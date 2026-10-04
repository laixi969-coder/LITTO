import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authenticate } from "./auth.ts";
import { authPublic, platform } from "./routes/platform.ts";
import { production } from "./routes/production.ts";
import { admin } from "./routes/admin.ts";
import { team } from "./routes/team.ts";
import { oauth } from "./routes/oauth.ts";
import { extra, adminExtra } from "./routes/extra.ts";
import { collab } from "./routes/collab.ts";
import { ssoPublic, sso } from "./routes/sso.ts";
import { nle } from "./routes/nle.ts";
import { market, marketAdmin } from "./routes/market.ts";
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
    // 只在开发环境放行本机来源；生产环境不允许任意 localhost 页面携带 Cookie 跨域调用账号接口。
    if (origin && !config.production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Access-Control-Allow-Credentials", "true");
        c.header("Access-Control-Allow-Headers", "content-type, authorization, x-workspace-id, x-litto-csrf, idempotency-key");
        c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
});

// Metrics + simple per-IP rate limit (fixed one-minute window).
// x-forwarded-for 由客户端任意填写，只有部署在可信反向代理后（LITTO_TRUST_PROXY=1）才采用，否则每次换个假 IP 就能绕过限流。
const buckets = new Map<string, { t: number; n: number }>();
setInterval(() => { const cutoff = Date.now() - 60_000; for (const [key, b] of buckets) if (b.t < cutoff) buckets.delete(key); }, 60_000).unref();
function clientIp(c: Context) {
    if (process.env.LITTO_TRUST_PROXY === "1") {
        const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
        if (forwarded) return forwarded;
    }
    return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "local";
}
app.use("*", async (c, next) => {
    const auth = c.req.path.startsWith("/auth/");
    const key = `${clientIp(c)}:${auth ? "auth" : "api"}`;
    const b = buckets.get(key) ?? { t: Date.now(), n: 0 };
    if (Date.now() - b.t > 60_000) (b.t = Date.now()), (b.n = 0);
    b.n++;
    buckets.set(key, b);
    if (b.n > (auth ? 30 : 600) && !process.env.LITTO_NO_RATELIMIT) {
        c.header("Retry-After", String(Math.ceil((b.t + 60_000 - Date.now()) / 1000)));
        return c.json({ error: "操作太频繁，请稍后再试", code: "rate_limited" }, 429);
    }
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
    const variant = c.req.query("variant");
    const key = variant === "thumb" && m.thumbnail_key ? m.thumbnail_key : variant === "proxy" && m.proxy_key ? m.proxy_key : m.storage_key;
    const mime = key === m.thumbnail_key ? "image/jpeg" : key === m.proxy_key ? "video/mp4" : m.mime;
    const buf = await storage.get(key);
    // SVG could carry script: serve it inert.
    return new Response(new Uint8Array(buf), { headers: { "content-type": mime, "cache-control": "private, max-age=300", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "x-content-type-options": "nosniff" } });
});

app.route("/auth", authPublic);
app.route("/auth/oauth", oauth);
app.route("/auth/sso", ssoPublic);
// Provider/Stripe callbacks authenticate by signature, not by session.
app.post("/webhooks/*", (c) => extra.fetch(c.req.raw));
const secured = new Hono();
secured.use("*", authenticate);
secured.route("/", platform);
secured.route("/", production);
secured.route("/", team);
secured.route("/", extra);
secured.route("/", collab);
secured.route("/", nle);
secured.route("/", market);
secured.route("/admin", admin);
secured.route("/admin", adminExtra);
secured.route("/admin", marketAdmin);
secured.route("/admin", sso);
app.route("/", secured);

app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message, code: e.code, details: e.details }, e.status as any);
    log.error("unhandled", e.stack ?? e.message);
    inc("api_errors");
    return c.json({ error: "internal error", code: "internal" }, 500);
});
app.notFound((c) => c.json({ error: "not found", code: "not_found" }, 404));
void config;
