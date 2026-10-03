import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createSign, generateKeyPairSync, randomBytes, createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ff-test3-"));
Object.assign(process.env, { FILMFLOW_DATA_DIR: dir, FILMFLOW_QUIET: "1", FILMFLOW_MOCK_LATENCY_MS: "20", FILMFLOW_WORKER_POLL_MS: "30", FILMFLOW_NO_RATELIMIT: "1", FILMFLOW_NO_DERIVATIVES: "1", NODE_ENV: "test", FILMFLOW_PUBLIC_URL: "http://ff.test" });

const { app } = await import("../src/app.ts");
const { startWorker, stopWorker } = await import("../src/jobs.ts");
const { seedProviders } = await import("../src/providers/registry.ts");
const { db } = await import("../src/db.ts");
seedProviders();
before(() => startWorker());

type Who = { token: string; email: string };
async function call(who: Who | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
}
const ok = async (who: Who | null, m: string, p: string, b?: unknown, h?: Record<string, string>) => { const r = await call(who, m, p, b, h); assert.ok(r.status < 300, `${m} ${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };
async function login(email: string): Promise<Who> {
    const { devCode } = await ok(null, "POST", "/auth/request-code", { email });
    return { token: (await ok(null, "POST", "/auth/verify", { email, code: devCode, client: "api" })).token, email };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tiny SSE client over app.request(): parses `event:`/`data:` frames into an array. */
async function sse(who: Who, path: string, headers: Record<string, string> = {}) {
    const res = await app.request(path, { headers: { authorization: `Bearer ${who.token}`, ...headers } });
    if (res.status !== 200) return { status: res.status, events: [] as any[], close: async () => {}, waitFor: async (): Promise<any> => null };
    const events: { event: string; data: any }[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value);
                let i;
                while ((i = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                    const ev = /^event: (.*)$/m.exec(frame)?.[1], data = /^data: (.*)$/m.exec(frame)?.[1];
                    if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
                }
            }
        } catch { /* closed */ }
    })();
    const waitFor = async (pred: (e: { event: string; data: any }) => boolean, ms = 3000) => {
        for (const t = Date.now(); Date.now() - t < ms; await sleep(20)) { const f = events.find(pred); if (f) return f; }
        return null;
    };
    return { status: 200, events, waitFor, close: async () => { await reader.cancel().catch(() => {}); } };
}

const S: any = {};
test("collab: SSE change feed, presence, tenancy", async () => {
    const owner = await login("collab-owner@example.com"), editor = await login("collab-editor@example.com"), outsider = await login("collab-out@example.com");
    const ws = await ok(owner, "POST", "/workspaces", { name: "Collab team" });
    const H = { "x-workspace-id": ws.id };
    await ok(owner, "POST", "/workspaces/current/members", { email: editor.email, role: "EDITOR" }, H);
    const p = await ok(owner, "POST", "/projects", { name: "Live" }, H);
    const seq = await ok(owner, "POST", `/projects/${p.id}/sequences`, { name: "s" }, H);
    Object.assign(S, { owner, editor, outsider, H, p, seq });

    // an outsider (different workspace) cannot subscribe, and a spoofed workspace header is refused
    assert.equal((await sse(outsider, `/projects/${p.id}/events`)).status, 404);
    assert.equal((await sse(outsider, `/projects/${p.id}/events`, H)).status, 403);
    // a subscriber in another workspace never sees these events
    const otherProj = await ok(outsider, "POST", "/projects", { name: "elsewhere" });
    const spy = await sse(outsider, `/projects/${otherProj.id}/events`);
    assert.equal(spy.status, 200);

    const feed = await sse(owner, `/projects/${p.id}/events`, H);
    assert.equal(feed.status, 200);
    assert.ok(await feed.waitFor((e) => e.event === "hello"));

    // edits by the editor reach the owner's stream
    const shot = await ok(editor, "POST", `/projects/${p.id}/shots`, { sequenceId: seq.id, title: "live shot" }, H);
    const ev = await feed.waitFor((e) => e.event === "change" && e.data.table === "shots" && e.data.id === shot.id);
    assert.ok(ev, "shot change delivered");
    assert.equal(ev!.data.projectId, p.id);
    assert.equal(ev!.data.workspaceId, ws.id);
    // bursts for one row coalesce
    feed.events.length = 0;
    for (let i = 0; i < 5; i++) await ok(editor, "PATCH", `/shots/${shot.id}`, { title: `t${i}` }, H);
    await sleep(300);
    const shotEvents = feed.events.filter((e) => e.event === "change" && e.data.table === "shots" && e.data.id === shot.id);
    assert.ok(shotEvents.length >= 1 && shotEvents.length < 5, `coalesced (${shotEvents.length})`);
    // soft deletes are announced too
    await ok(editor, "DELETE", `/shots/${(await ok(editor, "POST", `/projects/${p.id}/shots`, { sequenceId: seq.id, title: "tmp" }, H)).id}`, undefined, H);
    assert.ok(await feed.waitFor((e) => e.event === "change" && e.data.table === "shots"));

    // presence: heartbeat is pushed to others, carries a stable colour; VIEWER-level reads work
    const pres = await ok(editor, "POST", `/projects/${p.id}/presence`, { shotId: shot.id }, H);
    assert.equal(pres.length, 1);
    assert.equal(pres[0].email, editor.email);
    const color = pres[0].color;
    const pe = await feed.waitFor((e) => e.event === "presence" && e.data.some((x: any) => x.shotId === shot.id));
    assert.ok(pe, "presence event pushed");
    assert.equal((await ok(editor, "POST", `/projects/${p.id}/presence`, { shotId: null }, H))[0].color, color, "colour is stable");
    assert.equal((await ok(owner, "GET", `/projects/${p.id}/presence`, undefined, H)).length, 1);
    // nothing leaked to the other workspace's listener
    assert.ok(!spy.events.some((e) => e.event === "change" && e.data.projectId === p.id));

    // closing the stream removes that user's presence
    const edFeed = await sse(editor, `/projects/${p.id}/events`, H);
    await ok(editor, "POST", `/projects/${p.id}/presence`, { shotId: shot.id }, H);
    await edFeed.close();
    for (let i = 0; i < 60 && (await ok(owner, "GET", `/projects/${p.id}/presence`, undefined, H)).length; i++) await sleep(50);
    assert.equal((await ok(owner, "GET", `/projects/${p.id}/presence`, undefined, H)).length, 0, "presence removed on close");
    await feed.close(); await spy.close();
    S.shot = shot;
});

test("collab: optimistic concurrency (412 stale)", async () => {
    const { owner, editor, H, p, shot } = S;
    const seen = (await ok(owner, "GET", `/shots/${shot.id}`, undefined, H)).updatedAt;
    await sleep(5);
    await ok(editor, "PATCH", `/shots/${shot.id}`, { title: "editor wins" }, H);
    const stale = await call(owner, "PATCH", `/shots/${shot.id}`, { title: "owner loses", expectedUpdatedAt: seen }, H);
    assert.equal(stale.status, 412);
    assert.equal(stale.json.code, "stale");
    assert.equal(stale.json.details.current.title, "editor wins");
    // retrying with the fresh timestamp succeeds; no precondition = last write wins (backward compatible)
    const fresh = (await ok(owner, "GET", `/shots/${shot.id}`, undefined, H)).updatedAt;
    await ok(owner, "PATCH", `/shots/${shot.id}`, { title: "ok", expectedUpdatedAt: fresh }, H);
    await ok(owner, "PATCH", `/shots/${shot.id}`, { title: "no precondition" }, H);
    // same for assets, and via the If-Unmodified-Since header
    const a = await ok(owner, "POST", `/projects/${p.id}/assets`, { type: "Prop", name: "Cup" }, H);
    const t0 = (await ok(owner, "GET", `/assets/${a.id}`, undefined, H)).updatedAt ?? a.createdAt; // never-edited rows fall back to createdAt
    await sleep(5);
    await ok(editor, "PATCH", `/assets/${a.id}`, { description: "changed" }, H);
    assert.equal((await call(owner, "PATCH", `/assets/${a.id}`, { description: "mine" }, { ...H, "if-unmodified-since": t0 })).status, 412);
    assert.equal((await call(owner, "PATCH", `/assets/${a.id}`, { description: "mine", expectedUpdatedAt: t0 }, H)).status, 412);
});

// ---------------------------------------------------------------- SSO (OIDC) against a fake IdP
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object, o: { key?: any; alg?: string; kid?: string } = {}) => {
    const head = b64({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1", typ: "JWT" }), pay = b64(claims);
    if (o.alg === "none") return `${head}.${pay}.`;
    return `${head}.${pay}.${createSign("RSA-SHA256").update(`${head}.${pay}`).sign(o.key ?? privateKey).toString("base64url")}`;
};
let idpUrl = "";
const idp = { next: {} as any, lastToken: null as any };
const server: Server = createServer(async (req, res) => {
    const json = (o: unknown) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(o)));
    if (req.url === "/.well-known/openid-configuration") return json({ issuer: idpUrl, authorization_endpoint: `${idpUrl}/authorize`, token_endpoint: `${idpUrl}/token`, jwks_uri: `${idpUrl}/jwks` });
    if (req.url === "/jwks") return json({ keys: [jwk] });
    if (req.url === "/token") {
        let raw = ""; for await (const c of req) raw += c;
        const form = new URLSearchParams(raw);
        idp.lastToken = Object.fromEntries(form);
        const n = idp.next;
        // PKCE: the verifier must hash to the challenge captured at /authorize time
        if (n.challenge && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== n.challenge) { res.statusCode = 400; return json({ error: "invalid_grant" }); }
        if (form.get("client_secret") !== "s3cr3t-client-secret-value") { res.statusCode = 401; return json({ error: "invalid_client" }); }
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: n.iss ?? idpUrl, aud: n.aud ?? "ff-client", sub: n.sub ?? "u-1", email: n.email, email_verified: n.email_verified ?? true, nonce: n.nonce, iat: now, exp: n.exp ?? now + 300 };
        return json({ id_token: n.idToken ?? jwt(claims, n.sign), access_token: "x", token_type: "Bearer" });
    }
    res.statusCode = 404; res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
idpUrl = `http://127.0.0.1:${(server.address() as any).port}`;
after(() => { stopWorker(); server.close(); rmSync(dir, { recursive: true, force: true }); });

/** Runs start → (fake IdP) → callback and returns the callback response. */
async function ssoLogin(id: string, n: Record<string, unknown>, tamper?: { state?: string; noCookie?: boolean }) {
    const start = await app.request(`/auth/sso/${id}/start`);
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get("location")!);
    assert.equal(loc.origin, idpUrl);
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    assert.equal(loc.searchParams.get("client_id"), "ff-client");
    idp.next = { nonce: loc.searchParams.get("nonce"), challenge: loc.searchParams.get("code_challenge"), ...n };
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    return app.request(`/auth/sso/${id}/callback?code=abc&state=${tamper?.state ?? loc.searchParams.get("state")}`, { headers: tamper?.noCookie ? {} : { cookie } });
}

test("SSO: admin CRUD never exposes the secret; lookup; happy path joins the workspace", async () => {
    const admin = await login("admin@filmflow.local");
    const { owner, ws: _ws } = { owner: S.owner, ws: null };
    const team = await ok(owner, "POST", "/workspaces", { name: "Acme" });
    const SECRET = "s3cr3t-client-secret-value";
    const mk = await call(admin, "POST", "/admin/sso", { name: "Acme Okta", issuer: idpUrl, clientId: "ff-client", clientSecret: SECRET, domains: ["@Acme.test"], workspaceId: team.id, role: "EDITOR" });
    assert.equal(mk.status, 201, JSON.stringify(mk.json));
    S.conn = mk.json;
    assert.ok(!JSON.stringify(mk.json).includes(SECRET) && mk.json.hasSecret === true);
    assert.deepEqual(mk.json.domains, ["acme.test"]);
    assert.ok(!JSON.stringify(await ok(admin, "GET", "/admin/sso")).includes(SECRET));
    assert.equal((await call(owner, "GET", "/admin/sso")).status, 403);
    // domain can't be claimed twice; workspace must be a team workspace
    assert.equal((await call(admin, "POST", "/admin/sso", { name: "dup", issuer: idpUrl, clientId: "x", clientSecret: "y", domains: ["acme.test"] })).status, 400);
    assert.equal((await call(admin, "POST", "/admin/sso", { name: "p", issuer: idpUrl, clientId: "x", clientSecret: "y", domains: ["other.test"], workspaceId: (await ok(owner, "GET", "/auth/me")).workspaceId })).status, 400);
    // secret never in plaintext in the DB or audit log
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const f of readdirSync(dir).filter((x) => x.startsWith("filmflow.db"))) assert.ok(!readFileSync(join(dir, f)).toString("latin1").includes(SECRET), `${f} has plaintext secret`);
    assert.ok(!JSON.stringify(await ok(admin, "GET", "/admin/audit")).includes(SECRET));

    assert.deepEqual(await ok(null, "GET", "/auth/sso/lookup?email=Jane@ACME.test"), { id: S.conn.id, name: "Acme Okta", enforce: false });
    assert.equal((await call(null, "GET", "/auth/sso/lookup?email=jane@nowhere.test")).status, 404);

    const r = await ssoLogin(S.conn.id, { email: "jane@acme.test", sub: "jane-1" });
    assert.equal(r.status, 302, await r.clone().text());
    assert.equal(idp.lastToken.grant_type, "authorization_code");
    const session = r.headers.get("set-cookie")!.match(/ff_session=([^;]+)/)![1];
    const me = await (await app.request("/auth/me", { headers: { cookie: `ff_session=${session}` } })).json() as any;
    assert.equal(me.user.email, "jane@acme.test");
    assert.ok(me.workspaces.some((w: any) => w.id === team.id && w.role === "EDITOR"), "auto-joined the team workspace");
    // logging in again keeps a role an admin changed (no silent upgrade/downgrade)
    db.prepare("UPDATE workspace_members SET role='VIEWER' WHERE workspace_id=? AND user_id=?").run(team.id, me.user.id);
    await ssoLogin(S.conn.id, { email: "jane@acme.test", sub: "jane-1" });
    assert.equal((db.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?").get(team.id, me.user.id) as any).role, "VIEWER");
    S.team = team;
});

test("SSO: forged / replayed / invalid tokens are rejected", async () => {
    const id = S.conn.id;
    const bad = async (n: Record<string, unknown>, status: number, code?: string, tamper?: any) => {
        const r = await ssoLogin(id, { email: "mallory@acme.test", ...n }, tamper);
        assert.equal(r.status, status, `${JSON.stringify(Object.keys(n))} → ${r.status} ${await r.clone().text()}`);
        if (code) assert.equal(((await r.json()) as any).code, code);
        assert.ok(!(r.headers.get("set-cookie") ?? "").includes("ff_session="), "no session on failure");
    };
    await bad({ nonce: "wrong" }, 401, "sso_bad_token");
    await bad({ aud: "someone-else" }, 401, "sso_bad_token");
    await bad({ exp: Math.floor(Date.now() / 1000) - 3600 }, 401, "sso_bad_token");
    await bad({ iss: "https://evil.example" }, 401, "sso_bad_token");
    await bad({ sign: { key: other.privateKey } }, 401, "sso_bad_token"); // forged signature
    await bad({ idToken: jwt({ iss: idpUrl, aud: "ff-client", email: "mallory@acme.test", nonce: "x", exp: 9999999999 }, { alg: "none" }) }, 401, "sso_bad_token");
    await bad({ idToken: jwt({ iss: idpUrl, aud: "ff-client", email: "mallory@acme.test", nonce: "x", exp: 9999999999 }, { alg: "HS256" }) }, 401, "sso_bad_token");
    await bad({ sign: { kid: "unknown" } }, 401, "sso_bad_token");
    await bad({ email_verified: false }, 403, "unverified_email");
    await bad({ email: "mallory@evil.test" }, 403, "domain_not_allowed");
    await bad({}, 400, "bad_state", { state: "forged" });
    await bad({}, 400, "bad_state", { noCookie: true });
    assert.equal((await app.request(`/auth/sso/${id}/callback?code=abc`)).status, 400);
    assert.equal((await app.request(`/auth/sso/nope/start`)).status, 404);
    assert.equal(db.prepare("SELECT 1 FROM users WHERE email='mallory@acme.test'").get(), undefined, "no account created by failed logins");
});

test("SSO: enforce blocks OTP and generic OAuth for the domain; disable lifts it", async () => {
    const admin = await login("admin@filmflow.local");
    await ok(admin, "PATCH", `/admin/sso/${S.conn.id}`, { enforce: true });
    assert.equal((await ok(null, "GET", "/auth/sso/lookup?email=x@acme.test")).enforce, true);
    const r = await call(null, "POST", "/auth/request-code", { email: "bob@acme.test" });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "sso_required");
    assert.equal((await call(null, "POST", "/auth/request-code", { email: "bob@free.test" })).status, 200, "other domains unaffected");
    // a code issued before enforcement cannot be redeemed afterwards
    await ok(admin, "PATCH", `/admin/sso/${S.conn.id}`, { enforce: false });
    const { devCode } = await ok(null, "POST", "/auth/request-code", { email: "late@acme.test" });
    await ok(admin, "PATCH", `/admin/sso/${S.conn.id}`, { enforce: true });
    assert.equal((await call(null, "POST", "/auth/verify", { email: "late@acme.test", code: devCode, client: "api" })).json.code, "sso_required");
    // SSO itself still works while enforced
    assert.equal((await ssoLogin(S.conn.id, { email: "jane@acme.test", sub: "jane-1" })).status, 302);
    // disabling the connection lifts the lock and removes the lookup
    await ok(admin, "PATCH", `/admin/sso/${S.conn.id}`, { enabled: false });
    assert.equal((await call(null, "GET", "/auth/sso/lookup?email=x@acme.test")).status, 404);
    assert.equal((await call(null, "POST", "/auth/request-code", { email: "bob@acme.test" })).status, 200);
    assert.equal((await app.request(`/auth/sso/${S.conn.id}/start`)).status, 404);
    await ok(admin, "DELETE", `/admin/sso/${S.conn.id}`);
    assert.equal((await ok(admin, "GET", "/admin/sso")).length, 0);
    assert.ok((await ok(admin, "GET", "/admin/audit")).some((a: any) => a.action === "sso.delete"));
});

test("provider list exposes hasWebhookSecret (never the secret)", async () => {
    const admin = await login("admin@filmflow.local");
    const before = (await ok(admin, "GET", "/admin/providers")).find((p: any) => p.id === "mock");
    assert.equal(before.hasWebhookSecret, false);
    const { secret } = await ok(admin, "POST", "/admin/providers/mock/webhook-secret");
    const list = await ok(admin, "GET", "/admin/providers");
    assert.equal(list.find((p: any) => p.id === "mock").hasWebhookSecret, true);
    assert.ok(!JSON.stringify(list).includes(secret));
    void randomBytes;
});
