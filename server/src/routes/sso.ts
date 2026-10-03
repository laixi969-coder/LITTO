import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { authOf, loginUser, requireAdmin, setSessionCookie } from "../auth.ts";
import { audit, get, run, all } from "../db.ts";
import { config } from "../config.ts";
import { decrypt, encrypt, sign, verifySig } from "../crypto.ts";
import { body } from "../http.ts";
import { discover, pkce, verifyIdToken } from "../sso.ts";
import { connectionForEmail, domainOf } from "../sso-policy.ts";
import { bad, HttpError, notFound, now, ulid } from "../util.ts";
import { randomBytes } from "node:crypto";

// ---------------- public: lookup + OIDC flow ----------------
export const ssoPublic = new Hono();
const redirectUri = (id: string) => `${config.publicUrl}/auth/sso/${id}/callback`;

ssoPublic.get("/lookup", (c) => {
    const conn = connectionForEmail(c.req.query("email") ?? "");
    if (!conn) throw notFound("sso connection");
    return c.json({ id: conn.id, name: conn.name, enforce: !!conn.enforce });
});

ssoPublic.get("/:id/start", async (c) => {
    const conn = get("SELECT * FROM sso_connections WHERE id=? AND enabled=1", c.req.param("id"));
    if (!conn) throw notFound("sso connection");
    const d = await discover(conn.issuer);
    const { verifier, challenge } = pkce();
    const payload = Buffer.from(JSON.stringify({ id: conn.id, state: randomBytes(16).toString("base64url"), nonce: randomBytes(16).toString("base64url"), verifier })).toString("base64url");
    setCookie(c, "ff_sso", `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: "Lax", secure: config.production, path: "/", maxAge: 600 });
    const st = JSON.parse(Buffer.from(payload, "base64url").toString());
    const q = new URLSearchParams({ client_id: conn.client_id, redirect_uri: redirectUri(conn.id), response_type: "code", scope: "openid email profile", state: st.state, nonce: st.nonce, code_challenge: challenge, code_challenge_method: "S256" });
    return c.redirect(`${d.authorization_endpoint}${d.authorization_endpoint.includes("?") ? "&" : "?"}${q}`);
});

ssoPublic.get("/:id/callback", async (c) => {
    const conn = get("SELECT * FROM sso_connections WHERE id=? AND enabled=1", c.req.param("id"));
    if (!conn) throw notFound("sso connection");
    const [payload, sig] = (getCookie(c, "ff_sso") ?? "").split(".");
    if (!payload || !sig || !verifySig(payload, sig)) throw new HttpError(400, "invalid sso state", "bad_state");
    const st = JSON.parse(Buffer.from(payload, "base64url").toString());
    deleteCookie(c, "ff_sso", { path: "/" });
    if (st.id !== conn.id || !c.req.query("state") || c.req.query("state") !== st.state || !c.req.query("code")) throw new HttpError(400, "invalid sso state", "bad_state");
    const d = await discover(conn.issuer);
    const tr = await fetch(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code: c.req.query("code")!, redirect_uri: redirectUri(conn.id), client_id: conn.client_id, client_secret: decrypt(JSON.parse(conn.secret_enc)), code_verifier: st.verifier }), signal: AbortSignal.timeout(10_000) });
    const tj: any = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.id_token) throw new HttpError(502, `IdP token error: ${tj.error_description ?? tj.error ?? tr.status}`, "sso_bad_idp");
    const claims = await verifyIdToken(tj.id_token, { issuer: conn.issuer, discoveredIssuer: d.issuer, clientId: conn.client_id, nonce: st.nonce, jwksUri: d.jwks_uri });
    const email = String(claims.email ?? "").toLowerCase();
    if (!email || claims.email_verified === false || claims.email_verified === "false") throw new HttpError(403, "the IdP did not return a verified email", "unverified_email");
    if (!(JSON.parse(conn.domains) as string[]).map((x) => x.toLowerCase()).includes(domainOf(email))) throw new HttpError(403, "email domain is not allowed for this connection", "domain_not_allowed");
    const r = loginUser(email, { provider: `sso:${conn.id}`, subject: String(claims.sub) });
    if (conn.workspace_id && get("SELECT 1 FROM workspaces WHERE id=? AND deleted_at IS NULL", conn.workspace_id)) {
        // INSERT OR IGNORE: an existing membership (and its role, higher or lower) is never changed by SSO login.
        run("INSERT OR IGNORE INTO workspace_members VALUES(?,?,?,?)", conn.workspace_id, r.user.id, conn.role, now());
    }
    setSessionCookie(c, r.token);
    return c.redirect(process.env.FILMFLOW_WEB_URL ?? "/studio");
});

// ---------------- admin CRUD (mounted under /admin) ----------------
export const sso = new Hono();
sso.use("*", requireAdmin);
const view = (r: any) => ({ id: r.id, name: r.name, issuer: r.issuer, clientId: r.client_id, hasSecret: !!r.secret_enc, domains: JSON.parse(r.domains), workspaceId: r.workspace_id, role: r.role, enforce: !!r.enforce, enabled: !!r.enabled, createdAt: r.created_at });
const fields = z.object({ name: z.string().min(1).max(80), issuer: z.string().url(), clientId: z.string().min(1), domains: z.array(z.string().min(3).max(253)).min(1), workspaceId: z.string().nullable().optional(), role: z.enum(["ADMIN", "EDITOR", "VIEWER"]).default("EDITOR"), enforce: z.boolean().default(false), enabled: z.boolean().default(true) });
const cleanDomains = (d: string[]) => [...new Set(d.map((x) => x.trim().toLowerCase().replace(/^@/, "")))];
const checkWs = (id?: string | null) => { if (id && get("SELECT kind FROM workspaces WHERE id=? AND deleted_at IS NULL", id)?.kind !== "team") throw bad("workspaceId must be an existing team workspace"); };
const overlap = (domains: string[], exceptId?: string) => {
    for (const c of all("SELECT id, domains FROM sso_connections WHERE enabled=1")) if (c.id !== exceptId && (JSON.parse(c.domains) as string[]).some((x) => domains.includes(x))) throw bad("a domain is already claimed by another SSO connection");
};

sso.get("/sso", (c) => c.json(all("SELECT * FROM sso_connections ORDER BY created_at").map(view)));
sso.post("/sso", async (c) => {
    const b = await body(c, fields.extend({ clientSecret: z.string().min(1) }));
    const domains = cleanDomains(b.domains);
    checkWs(b.workspaceId);
    if (b.enabled) overlap(domains);
    const id = ulid();
    run("INSERT INTO sso_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, b.name, b.issuer, b.clientId, JSON.stringify(encrypt(b.clientSecret)), JSON.stringify(domains), b.workspaceId ?? null, b.role, b.enforce ? 1 : 0, b.enabled ? 1 : 0, now(), now());
    audit(authOf(c).user.id, "sso.create", id, { name: b.name, issuer: b.issuer, domains, enforce: b.enforce }); // never the secret
    return c.json(view(get("SELECT * FROM sso_connections WHERE id=?", id)), 201);
});
sso.patch("/sso/:id", async (c) => {
    const cur = get("SELECT * FROM sso_connections WHERE id=?", c.req.param("id"));
    if (!cur) throw notFound("sso connection");
    const b = await body(c, fields.partial().extend({ clientSecret: z.string().min(1).optional() }));
    const domains = b.domains ? cleanDomains(b.domains) : JSON.parse(cur.domains);
    if (b.workspaceId !== undefined) checkWs(b.workspaceId);
    if ((b.enabled ?? !!cur.enabled)) overlap(domains, cur.id);
    run("UPDATE sso_connections SET name=?, issuer=?, client_id=?, secret_enc=?, domains=?, workspace_id=?, role=?, enforce=?, enabled=?, updated_at=? WHERE id=?", b.name ?? cur.name, b.issuer ?? cur.issuer, b.clientId ?? cur.client_id, b.clientSecret ? JSON.stringify(encrypt(b.clientSecret)) : cur.secret_enc, JSON.stringify(domains), b.workspaceId === undefined ? cur.workspace_id : b.workspaceId, b.role ?? cur.role, (b.enforce ?? !!cur.enforce) ? 1 : 0, (b.enabled ?? !!cur.enabled) ? 1 : 0, now(), cur.id);
    const { clientSecret, ...logged } = b;
    audit(authOf(c).user.id, "sso.update", cur.id, { ...logged, secretRotated: !!clientSecret });
    return c.json(view(get("SELECT * FROM sso_connections WHERE id=?", cur.id)));
});
sso.delete("/sso/:id", (c) => {
    if (!run("DELETE FROM sso_connections WHERE id=?", c.req.param("id")).changes) throw notFound("sso connection");
    audit(authOf(c).user.id, "sso.delete", c.req.param("id"));
    return c.json({ ok: true });
});
