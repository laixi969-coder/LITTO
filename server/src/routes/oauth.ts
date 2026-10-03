import { createHmac, createPrivateKey, createPublicKey, createVerify, randomBytes, sign as edSign } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { loginUser, setSessionCookie } from "../auth.ts";
import { config } from "../config.ts";
import { sign, verifySig } from "../crypto.ts";
import { HttpError } from "../util.ts";
import { assertNotSsoEnforced } from "../sso-policy.ts";

/**
 * P2 OAuth: GitHub, Google, Apple. Each is enabled only when its env credentials exist.
 * Endpoints are overridable via env so the flow can be tested against a local fake IdP.
 *   FILMFLOW_OAUTH_GITHUB_ID/SECRET, FILMFLOW_OAUTH_GOOGLE_ID/SECRET,
 *   FILMFLOW_OAUTH_APPLE_ID (Services ID) / _TEAM_ID / _KEY_ID / _PRIVATE_KEY (PEM, ES256)
 */
export const oauth = new Hono();
const env = (k: string) => process.env[k];

type P = { id: string; clientId: string; authUrl: string; scope: string; exchange: (code: string, redirect: string) => Promise<{ email: string; subject: string; verified: boolean }> };

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function postForm(url: string, body: Record<string, string>, headers: Record<string, string> = {}) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers }, body: form(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new HttpError(502, `oauth provider error: ${j.error_description ?? j.error ?? r.status}`);
    return j;
}

const providers = (): Record<string, P> => {
    const out: Record<string, P> = {};
    if (env("FILMFLOW_OAUTH_GITHUB_ID")) {
        const base = env("FILMFLOW_OAUTH_GITHUB_BASE") ?? "https://github.com", api = env("FILMFLOW_OAUTH_GITHUB_API") ?? "https://api.github.com";
        out.github = { id: "github", clientId: env("FILMFLOW_OAUTH_GITHUB_ID")!, authUrl: `${base}/login/oauth/authorize`, scope: "read:user user:email", async exchange(code, redirect) {
            const t = await postForm(`${base}/login/oauth/access_token`, { client_id: env("FILMFLOW_OAUTH_GITHUB_ID")!, client_secret: env("FILMFLOW_OAUTH_GITHUB_SECRET")!, code, redirect_uri: redirect });
            const h = { authorization: `Bearer ${t.access_token}`, accept: "application/json", "user-agent": "filmflow" };
            const me: any = await (await fetch(`${api}/user`, { headers: h })).json();
            const emails: any[] = await (await fetch(`${api}/user/emails`, { headers: h })).json().catch(() => []);
            const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : null;
            const email = primary?.email ?? (me.email as string);
            return { email, subject: String(me.id), verified: !!primary || !!me.email };
        } };
    }
    if (env("FILMFLOW_OAUTH_GOOGLE_ID")) {
        const auth = env("FILMFLOW_OAUTH_GOOGLE_AUTH") ?? "https://accounts.google.com/o/oauth2/v2/auth", tok = env("FILMFLOW_OAUTH_GOOGLE_TOKEN") ?? "https://oauth2.googleapis.com/token", info = env("FILMFLOW_OAUTH_GOOGLE_USERINFO") ?? "https://openidconnect.googleapis.com/v1/userinfo";
        out.google = { id: "google", clientId: env("FILMFLOW_OAUTH_GOOGLE_ID")!, authUrl: auth, scope: "openid email", async exchange(code, redirect) {
            const t = await postForm(tok, { client_id: env("FILMFLOW_OAUTH_GOOGLE_ID")!, client_secret: env("FILMFLOW_OAUTH_GOOGLE_SECRET")!, code, redirect_uri: redirect, grant_type: "authorization_code" });
            const me: any = await (await fetch(info, { headers: { authorization: `Bearer ${t.access_token}` } })).json();
            return { email: me.email, subject: String(me.sub), verified: me.email_verified !== false };
        } };
    }
    if (env("FILMFLOW_OAUTH_APPLE_ID")) {
        out.apple = { id: "apple", clientId: env("FILMFLOW_OAUTH_APPLE_ID")!, authUrl: "https://appleid.apple.com/auth/authorize", scope: "name email", async exchange(code, redirect) {
            // Apple's client secret is an ES256 JWT signed with the team's private key.
            const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
            const iat = Math.floor(Date.now() / 1000);
            const head = b64({ alg: "ES256", kid: env("FILMFLOW_OAUTH_APPLE_KEY_ID") }), pay = b64({ iss: env("FILMFLOW_OAUTH_APPLE_TEAM_ID"), iat, exp: iat + 300, aud: "https://appleid.apple.com", sub: env("FILMFLOW_OAUTH_APPLE_ID") });
            const sig = edSign("sha256", Buffer.from(`${head}.${pay}`), { key: createPrivateKey(env("FILMFLOW_OAUTH_APPLE_PRIVATE_KEY")!), dsaEncoding: "ieee-p1363" }).toString("base64url");
            const t = await postForm("https://appleid.apple.com/auth/token", { client_id: env("FILMFLOW_OAUTH_APPLE_ID")!, client_secret: `${head}.${pay}.${sig}`, code, redirect_uri: redirect, grant_type: "authorization_code" });
            // Verify the id_token against Apple's published JWKS (never trust an unverified JWT).
            const [h, p, s] = String(t.id_token).split(".");
            const kid = JSON.parse(Buffer.from(h, "base64url").toString()).kid;
            const jwks: any = await (await fetch("https://appleid.apple.com/auth/keys")).json();
            const jwk = jwks.keys.find((k: any) => k.kid === kid);
            if (!jwk) throw new HttpError(502, "apple key not found");
            const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
            const claims = JSON.parse(Buffer.from(p, "base64url").toString());
            if (!ok || claims.iss !== "https://appleid.apple.com" || claims.aud !== env("FILMFLOW_OAUTH_APPLE_ID") || claims.exp < Date.now() / 1000) throw new HttpError(401, "invalid apple id_token");
            return { email: claims.email, subject: String(claims.sub), verified: claims.email_verified === true || claims.email_verified === "true" };
        } };
    }
    return out;
};

const redirectUri = (provider: string) => `${config.publicUrl}/auth/oauth/${provider}/callback`;

oauth.get("/providers", (c) => c.json(Object.keys(providers())));

oauth.get("/:provider/start", (c) => {
    const p = providers()[c.req.param("provider")];
    if (!p) throw new HttpError(404, "oauth provider not configured", "not_configured");
    const state = randomBytes(16).toString("base64url");
    setCookie(c, "ff_oauth_state", `${state}.${sign(state)}`, { httpOnly: true, sameSite: "Lax", secure: config.production, path: "/", maxAge: 600 });
    const q = form({ client_id: p.clientId, redirect_uri: redirectUri(p.id), response_type: "code", scope: p.scope, state, ...(p.id === "apple" ? { response_mode: "form_post" } : {}) });
    return c.redirect(`${p.authUrl}?${q}`);
});

async function callback(c: any, code: string | undefined, state: string | undefined) {
    const p = providers()[c.req.param("provider")];
    if (!p) throw new HttpError(404, "oauth provider not configured", "not_configured");
    const [s, sig] = (getCookie(c, "ff_oauth_state") ?? "").split(".");
    if (!code || !state || state !== s || !sig || !verifySig(s, sig)) throw new HttpError(400, "invalid oauth state", "bad_state");
    deleteCookie(c, "ff_oauth_state", { path: "/" });
    const id = await p.exchange(code, redirectUri(p.id));
    if (!id.email || !id.verified) throw new HttpError(403, "the provider did not return a verified email", "unverified_email");
    assertNotSsoEnforced(id.email);
    const r = loginUser(id.email, { provider: p.id, subject: id.subject });
    setSessionCookie(c, r.token);
    return c.redirect(env("FILMFLOW_WEB_URL") ?? "/studio");
}
oauth.get("/:provider/callback", (c) => callback(c, c.req.query("code"), c.req.query("state")));
oauth.post("/:provider/callback", async (c) => { const f = await c.req.parseBody(); return callback(c, f.code as string, f.state as string); }); // Apple form_post
void createHmac;
