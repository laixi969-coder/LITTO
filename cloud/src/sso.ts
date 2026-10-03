import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { HttpError } from "./util.ts";

/** Minimal OIDC relying party: discovery, PKCE, id_token verification against the IdP's JWKS. SAML is out of scope. */
export type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
const cache = new Map<string, { at: number; v: any }>();
const TTL = 5 * 60_000;

const guardUrl = (u: string) => {
    const x = new URL(u);
    if (x.protocol !== "https:" && !(x.protocol === "http:" && !config.production)) throw new HttpError(502, "IdP endpoints must use https", "sso_bad_idp");
    return x.toString();
};
async function getJson(url: string, fresh = false) {
    const hit = cache.get(url);
    if (hit && !fresh && Date.now() - hit.at < TTL) return hit.v;
    const r = await fetch(guardUrl(url), { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new HttpError(502, `IdP request failed (${r.status})`, "sso_bad_idp");
    const v = await r.json();
    cache.set(url, { at: Date.now(), v });
    return v;
}
export async function discover(issuer: string): Promise<Discovery> {
    const d = await getJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new HttpError(502, "incomplete OIDC discovery document", "sso_bad_idp");
    return d;
}

export const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const b64j = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());

/** Verifies signature (RS256 only), iss, aud, exp, nonce. Rejects `alg:none`, HS* (key-confusion) and anything else. */
export async function verifyIdToken(token: string, o: { issuer: string; discoveredIssuer: string; clientId: string; nonce: string; jwksUri: string }) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new HttpError(401, "malformed id_token", "sso_bad_token");
    const [h, p, s] = parts;
    let head: any, claims: any;
    try { head = b64j(h); claims = b64j(p); } catch { throw new HttpError(401, "malformed id_token", "sso_bad_token"); }
    if (head.alg !== "RS256") throw new HttpError(401, `unsupported id_token alg ${head.alg}`, "sso_bad_token");
    let jwks = await getJson(o.jwksUri);
    let jwk = jwks.keys?.find((k: any) => k.kid === head.kid && (!k.use || k.use === "sig") && k.kty === "RSA");
    if (!jwk) { jwks = await getJson(o.jwksUri, true); jwk = jwks.keys?.find((k: any) => k.kid === head.kid && k.kty === "RSA"); } // key rotation
    if (!jwk) throw new HttpError(401, "id_token signing key not found", "sso_bad_token");
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
    if (!ok) throw new HttpError(401, "id_token signature invalid", "sso_bad_token");
    const norm = (x: string) => String(x).replace(/\/$/, "");
    if (![o.issuer, o.discoveredIssuer].some((i) => norm(i) === norm(claims.iss))) throw new HttpError(401, "id_token issuer mismatch", "sso_bad_token");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(o.clientId)) throw new HttpError(401, "id_token audience mismatch", "sso_bad_token");
    if (typeof claims.exp !== "number" || claims.exp < Date.now() / 1000 - 60) throw new HttpError(401, "id_token expired", "sso_bad_token");
    if (claims.nonce !== o.nonce) throw new HttpError(401, "id_token nonce mismatch", "sso_bad_token");
    return claims as { sub: string; email?: string; email_verified?: boolean | string };
}
