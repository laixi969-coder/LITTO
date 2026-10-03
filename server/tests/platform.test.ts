import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ff-test2-"));
const hasFfmpeg = (() => { try { execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch { return false; } })();
Object.assign(process.env, { FILMFLOW_DATA_DIR: dir, FILMFLOW_QUIET: "1", FILMFLOW_MOCK_LATENCY_MS: "20", FILMFLOW_WORKER_POLL_MS: "30", FILMFLOW_NO_RATELIMIT: "1", NODE_ENV: "test", FILMFLOW_PUBLIC_URL: "http://ff.test", FILMFLOW_STRIPE_WEBHOOK_SECRET: "whsec_test", FILMFLOW_OAUTH_GITHUB_ID: "gh-id", FILMFLOW_OAUTH_GITHUB_SECRET: "gh-secret", ...(hasFfmpeg ? {} : { FILMFLOW_NO_DERIVATIVES: "1" }) });

// A fake GitHub: /login/oauth/access_token, /user, /user/emails
let ghEmail = { email: "octo@example.com", verified: true };
const idp = createServer((req, res) => {
    const json = (o: unknown) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(o)));
    if (req.url === "/login/oauth/access_token") return json({ access_token: "tok" });
    if (req.url === "/user") return json({ id: 4242, email: null });
    if (req.url === "/user/emails") return json([{ email: ghEmail.email, primary: true, verified: ghEmail.verified }]);
    res.statusCode = 404; res.end();
});
await new Promise<void>((r) => idp.listen(0, r));
process.env.FILMFLOW_OAUTH_GITHUB_BASE = `http://127.0.0.1:${(idp.address() as any).port}`;
process.env.FILMFLOW_OAUTH_GITHUB_API = process.env.FILMFLOW_OAUTH_GITHUB_BASE;

const { app } = await import("../src/app.ts");
const { startWorker, stopWorker } = await import("../src/jobs.ts");
const { seedProviders } = await import("../src/providers/registry.ts");
const { db } = await import("../src/db.ts");
seedProviders();
before(() => startWorker());
after(() => { stopWorker(); idp.close(); rmSync(dir, { recursive: true, force: true }); });

type Who = { token: string; email: string };
async function call(who: Who | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any; try { json = JSON.parse(buf.toString()); } catch { json = buf.toString(); }
    return { status: res.status, json, buf, headers: res.headers };
}
const ok = async (who: Who | null, m: string, p: string, b?: unknown, h?: Record<string, string>) => { const r = await call(who, m, p, b, h); assert.ok(r.status < 300, `${m} ${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };
async function login(email: string): Promise<Who> {
    const { devCode } = await ok(null, "POST", "/auth/request-code", { email });
    return { token: (await ok(null, "POST", "/auth/verify", { email, code: devCode, client: "api" })).token, email };
}
const wait = async (who: Who, ids: string[], want = "SUCCEEDED") => {
    for (const t = Date.now(); ; ) {
        const js = await Promise.all(ids.map((id) => ok(who, "GET", `/generations/${id}`)));
        if (js.every((j) => ["SUCCEEDED", "FAILED", "TIMEOUT", "CANCELLED"].includes(j.status))) { js.forEach((j) => assert.equal(j.status, want, j.error)); return js; }
        assert.ok(Date.now() - t < 8000, "timeout waiting for jobs");
        await new Promise((r) => setTimeout(r, 40));
    }
};
const S: any = {};

test("team workspaces + RBAC", async () => {
    const owner = await login("owner@example.com"), editor = await login("editor@example.com"), viewer = await login("viewer@example.com");
    const personal = (await ok(owner, "GET", "/auth/me")).workspaceId;
    const ws = await ok(owner, "POST", "/workspaces", { name: "Studio X" });
    const H = { "x-workspace-id": ws.id };
    // personal workspaces refuse members
    assert.equal((await call(owner, "POST", "/workspaces/current/members", { email: "a@b.co" })).status, 400);
    assert.equal((await ok(owner, "POST", "/workspaces/current/members", { email: "editor@example.com", role: "EDITOR" }, H)).status, "added");
    assert.equal((await ok(owner, "POST", "/workspaces/current/members", { email: "viewer@example.com", role: "VIEWER" }, H)).status, "added");
    // invitation for someone who hasn't signed up: applied on first login
    assert.equal((await ok(owner, "POST", "/workspaces/current/members", { email: "newbie@example.com", role: "EDITOR" }, H)).status, "invited");
    const newbie = await login("newbie@example.com");
    assert.ok((await ok(newbie, "GET", "/auth/me")).workspaces.some((w: any) => w.id === ws.id && w.role === "EDITOR"));

    const eH = H, p = await ok(editor, "POST", "/projects", { name: "Team film" }, eH);
    assert.equal((await call(viewer, "POST", "/projects", { name: "nope" }, H)).status, 403);
    assert.equal((await call(viewer, "GET", `/projects/${p.id}`, undefined, H)).status, 200);
    assert.equal((await call(viewer, "PUT", `/projects/${p.id}/world`, { era: "x" }, H)).status, 403);
    assert.equal((await call(editor, "POST", "/workspaces/current/members", { email: "x@y.co" }, H)).status, 403, "editors cannot manage members");
    assert.equal((await call(editor, "POST", "/credentials", { providerId: "mock", secret: "sk-123456789" }, H)).status, 403, "BYOK needs ADMIN");
    // a non-member cannot enter, and personal data stays separate
    const outsider = await login("out@example.com");
    assert.equal((await call(outsider, "GET", "/projects", undefined, H)).status, 403);
    assert.equal((await ok(owner, "GET", "/projects")).length, 0, "personal workspace has no team projects");
    // role management
    const members = (await ok(owner, "GET", "/workspaces/current/members", undefined, H)).members;
    const ed = members.find((m: any) => m.email === "editor@example.com");
    await ok(owner, "PATCH", `/workspaces/current/members/${ed.id}`, { role: "ADMIN" }, H);
    assert.equal((await call(editor, "POST", "/workspaces/current/members", { email: "adm2@x.co", role: "ADMIN" }, H)).status, 403, "ADMIN cannot mint admins");
    assert.equal((await call(owner, "PATCH", `/workspaces/current/members/${members.find((m: any) => m.role === "OWNER").id}`, { role: "VIEWER" }, H)).status, 403);
    // transfer + leave
    await ok(owner, "POST", "/workspaces/current/transfer", { userId: ed.id }, H);
    assert.equal((await call(owner, "POST", "/workspaces/current/leave", {}, H)).status, 200);
    assert.equal((await call(owner, "GET", "/projects", undefined, H)).status, 403);
    // removal revokes access
    const v = members.find((m: any) => m.email === "viewer@example.com");
    await ok(editor, "DELETE", `/workspaces/current/members/${v.id}`, undefined, H);
    assert.equal((await call(viewer, "GET", "/projects", undefined, H)).status, 403);
    void personal;
});

test("OAuth (GitHub flow against a fake IdP): state, verified email, session", async () => {
    assert.deepEqual((await ok(null, "GET", "/auth/oauth/providers")), ["github"]);
    const start = await app.request("/auth/oauth/github/start");
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get("location")!);
    assert.equal(loc.searchParams.get("client_id"), "gh-id");
    const state = loc.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    // forged state is rejected
    assert.equal((await app.request(`/auth/oauth/github/callback?code=c&state=evil`, { headers: { cookie } })).status, 400);
    assert.equal((await app.request(`/auth/oauth/github/callback?code=c&state=${state}`)).status, 400, "no state cookie");
    const cb = await app.request(`/auth/oauth/github/callback?code=c&state=${state}`, { headers: { cookie } });
    assert.equal(cb.status, 302);
    const session = cb.headers.get("set-cookie")!.match(/ff_session=([^;]+)/)![1];
    const me = await app.request("/auth/me", { headers: { cookie: `ff_session=${session}` } });
    assert.equal((await me.json() as any).user.email, "octo@example.com");
    // unverified email is refused
    ghEmail = { email: "x@example.com", verified: false };
    const s2 = await app.request("/auth/oauth/github/start");
    const st2 = new URL(s2.headers.get("location")!).searchParams.get("state")!;
    assert.equal((await app.request(`/auth/oauth/github/callback?code=c&state=${st2}`, { headers: { cookie: s2.headers.get("set-cookie")!.split(";")[0] } })).status, 403);
    assert.equal((await ok(null, "GET", "/auth/oauth/providers")).includes("google"), false);
    assert.equal((await call(null, "GET", "/auth/oauth/google/start")).status, 404);
});

test("billing: plans, packs, subscription lifecycle, Stripe webhook", async () => {
    const u = await login("payer@example.com");
    const b = await ok(u, "GET", "/billing");
    assert.deepEqual(b.plans.map((p: any) => p.period), ["free", "monthly", "quarterly", "annual", "custom"]);
    const before = (await ok(u, "GET", "/credits")).balance;
    await ok(u, "POST", "/billing/checkout", { kind: "pack", id: "pack-1000" });
    assert.equal((await ok(u, "GET", "/credits")).balance, before + 1000);
    await ok(u, "POST", "/billing/checkout", { kind: "plan", id: "monthly" });
    const after = await ok(u, "GET", "/billing");
    assert.equal(after.subscription.plan, "monthly");
    assert.equal((await ok(u, "GET", "/workspaces/current")).storage.quotaBytes, 50 * 1024 ** 3);
    assert.equal((await call(u, "POST", "/billing/checkout", { kind: "plan", id: "custom" })).status, 400);
    assert.ok((await ok(u, "GET", "/credits")).ledger.some((l: any) => l.type === "PURCHASE"));
    // Stripe: unsigned/forged rejected, signed accepted exactly once
    const ws = (await ok(u, "GET", "/workspaces/current")).id;
    db.prepare("INSERT INTO payments VALUES('pay_1',?,?,?,?,?,?,?,?,?,?)").run(ws, "pack", "pack-5000", 45, 5000, "stripe", "cs_1", "pending", new Date().toISOString(), new Date().toISOString());
    const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: { client_reference_id: "pay_1" } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = (body: string, secret = "whsec_test") => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    assert.equal((await call(null, "POST", "/webhooks/stripe", undefined, { "stripe-signature": "t=1,v1=00" })).status, 400);
    const bal0 = (await ok(u, "GET", "/credits")).balance;
    for (let i = 0; i < 2; i++) assert.equal((await app.request("/webhooks/stripe", { method: "POST", body: raw, headers: { "stripe-signature": sig(raw) } })).status, 200);
    assert.equal((await app.request("/webhooks/stripe", { method: "POST", body: raw, headers: { "stripe-signature": sig(raw, "wrong") } })).status, 400);
    assert.equal((await ok(u, "GET", "/credits")).balance, bal0 + 5000, "fulfilled once despite retry");
    // admin: custom enterprise plan; lapse → free
    const admin = await login("admin@filmflow.local");
    await ok(admin, "PUT", `/admin/workspaces/${ws}/subscription`, { planId: "custom", grantCredits: true, custom: { credits: 777, storageGb: 500 } });
    assert.equal((await ok(u, "GET", "/billing")).subscription.plan, "custom");
    db.prepare("UPDATE subscriptions SET period_end='2000-01-01T00:00:00.000Z' WHERE workspace_id=?").run(ws);
    assert.equal((await ok(u, "GET", "/billing")).subscription.plan, "free");
    assert.equal((await call(u, "PUT", `/admin/workspaces/${ws}/subscription`, { planId: "free" })).status, 403);
});

test("provider webhook (callback-only provider), signed", async () => {
    const admin = await login("admin@filmflow.local");
    const u = await login("hook@example.com");
    await ok(admin, "POST", "/admin/providers", { id: "cb", name: "Callback provider", adapter: "mock", baseUrl: "mock://callback", priority: 1 });
    await ok(admin, "POST", "/admin/models", { id: "cb-image", providerId: "cb", externalModelId: "cb", name: "CB", type: "image", capabilities: { text2image: true, costClass: "low", latencyClass: "low", maxInputs: 0 }, price: { perImage: 0.01 } });
    const secret = (await ok(admin, "POST", "/admin/providers/cb/webhook-secret")).secret;
    await ok(u, "PUT", "/workspaces/current/model-policy", { imageModelId: "cb-image" });
    const p = await ok(u, "POST", "/projects", { name: "hook" });
    const seq = await ok(u, "POST", `/projects/${p.id}/sequences`, { name: "s" });
    const sh = await ok(u, "POST", `/projects/${p.id}/shots`, { sequenceId: seq.id, title: "t" });
    const g = await ok(u, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    // wait until the worker has submitted (provider task id known)
    let task: string | undefined;
    for (let i = 0; i < 100 && !task; i++) { task = (db.prepare("SELECT provider_task_id t FROM generation_jobs WHERE id=?").get(g.job.id) as any).t; await new Promise((r) => setTimeout(r, 30)); }
    assert.ok(task);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await ok(u, "GET", `/generations/${g.job.id}`)).status, "RUNNING", "polling alone never completes it");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="red"/></svg>').toString("base64");
    const raw = JSON.stringify({ taskId: task, status: "done", outputs: [{ b64: svg, mime: "image/svg+xml" }], costUsd: 0.01 });
    const sign = (secret: string) => createHmac("sha256", secret).update(raw).digest("hex");
    assert.equal((await app.request("/webhooks/providers/cb", { method: "POST", body: raw, headers: { "x-filmflow-signature": sign("nope") } })).status, 400);
    assert.equal((await app.request("/webhooks/providers/cb", { method: "POST", body: raw, headers: { "x-filmflow-signature": sign(secret) } })).status, 200);
    await wait(u, [g.job.id]);
    assert.equal((await ok(u, "GET", `/shots/${sh.id}`)).keyframes.length, 1);
    assert.equal((await call(null, "POST", "/webhooks/providers/mock", undefined)).status, 404, "unconfigured provider has no webhook");
});

async function productionFixture(u: Who) {
    const p = await ok(u, "POST", "/projects", { name: "asm" });
    const seq = await ok(u, "POST", `/projects/${p.id}/sequences`, { name: "Cut A" });
    const shots: any[] = [];
    for (const [i, d] of [4, 2, 3].entries()) shots.push(await ok(u, "POST", `/projects/${p.id}/shots`, { sequenceId: seq.id, title: `S${i + 1}`, duration: d, subtitle: i === 1 ? "" : `line ${i + 1}`, camera: { shotSize: "MS", lensMm: 35, side: "A" } }));
    return { p, seq, shots };
}
async function approvedTake(u: Who, shotId: string) {
    const g = await ok(u, "POST", `/shots/${shotId}/keyframes`, { count: 1 });
    await wait(u, [g.job.id]);
    const kf = (await ok(u, "GET", `/shots/${shotId}`)).keyframes[0];
    await ok(u, "POST", `/keyframes/${kf.id}/promote`);
    const t = await ok(u, "POST", `/shots/${shotId}/takes`, { count: 1 });
    await wait(u, t.jobs.map((j: any) => j.id));
    const take = (await ok(u, "GET", `/shots/${shotId}`)).takes[0];
    await ok(u, "POST", `/takes/${take.id}/approve`, {});
    return take;
}

test("assembly: timeline, EDL, SRT, export package, render guard", async () => {
    const u = await login("editor2@example.com");
    const { p, seq, shots } = await productionFixture(u);
    await approvedTake(u, shots[0].id);
    await approvedTake(u, shots[2].id);
    const tl = await ok(u, "GET", `/sequences/${seq.id}/timeline`);
    assert.deepEqual(tl.clips.map((c: any) => [c.start, c.duration, c.kind]), [[0, 4, "take"], [4, 2, "missing"], [6, 3, "take"]]);
    assert.equal(tl.duration, 9);
    assert.deepEqual(tl.missing, [shots[1].id]);
    assert.ok(tl.warnings[0].includes("#2"));
    const srt = (await call(u, "GET", `/sequences/${seq.id}/subtitles.srt`)).json as string;
    assert.match(srt, /1\n00:00:00,000 --> 00:00:04,000\nline 1/);
    assert.match(srt, /2\n00:00:06,000 --> 00:00:09,000\nline 3/);
    assert.ok(!srt.includes("line 2"));
    await ok(u, "PUT", `/sequences/${seq.id}/subtitles`, { lines: [{ shotId: shots[1].id, text: "added later" }] });
    assert.match((await call(u, "GET", `/sequences/${seq.id}/subtitles.srt`)).json as string, /added later/);
    const edl = (await call(u, "GET", `/sequences/${seq.id}/timeline.edl`)).json as string;
    assert.match(edl, /^TITLE: Cut A/);
    assert.match(edl, /002  AX       V     C        00:00:00:00 00:00:02:00 00:00:04:00 00:00:06:00/);
    // audio references on the timeline
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(20)]);
    const up = await (await app.request(`/media?projectId=${p.id}`, { method: "POST", headers: { authorization: `Bearer ${u.token}` }, body: wav })).json() as any;
    assert.equal(up.mime, "audio/wav");
    const ref = await ok(u, "POST", `/projects/${p.id}/references`, { kind: "audio", name: "score", mediaId: up.id });
    await ok(u, "POST", `/shots/${shots[0].id}/bindings`, { referenceId: ref.id, role: "AUDIO" });
    assert.equal((await ok(u, "GET", `/sequences/${seq.id}/timeline`)).audio[0].name, "score");
    // export package is a valid ZIP with manifest + EDL + SRT + media
    const z = await call(u, "GET", `/sequences/${seq.id}/export`);
    assert.equal(z.headers.get("content-type"), "application/zip");
    const names: string[] = [];
    const eocd = z.buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let off = z.buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < z.buf.readUInt16LE(eocd + 10); i++) { const n = z.buf.readUInt16LE(off + 28); names.push(z.buf.subarray(off + 46, off + 46 + n).toString()); off += 46 + n; }
    assert.ok(["manifest.json", "timeline.edl", "subtitles.srt"].every((n) => names.includes(n)), names.join());
    assert.ok(names.filter((n) => n.startsWith("media/shot-")).length === 2 && names.some((n) => n.startsWith("media/audio-")));
    if (process.platform !== "win32") { // the ZIP must be readable by a real unzip tool
        const f = join(dir, "x.zip"); (await import("node:fs")).writeFileSync(f, z.buf);
        assert.match(execSync(`unzip -t ${f}`).toString(), /No errors detected/);
    }
    // render needs real video for every shot: mock output is SVG so it must fail clearly (never silently)
    const r = await ok(u, "POST", `/sequences/${seq.id}/render`);
    let st: any;
    for (let i = 0; i < 100; i++) { st = (await ok(u, "GET", `/sequences/${seq.id}/renders`))[0]; if (st.status !== "RUNNING") break; await new Promise((x) => setTimeout(x, 50)); }
    assert.equal(st.status, "FAILED");
    assert.match(st.error, /ffmpeg|not an approved video|video/);
    void r;
});

test("confirm gate on core shot intent; LLM refine; vision QC; metrics", async () => {
    const u = await login("director@example.com");
    const { p, seq, shots } = await productionFixture(u);
    const sh = shots[0];
    const g = await ok(u, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    await wait(u, [g.job.id]);
    const kf = (await ok(u, "GET", `/shots/${sh.id}`)).keyframes[0];
    await ok(u, "PATCH", `/shots/${sh.id}`, { action: "free to change before approval" });
    await ok(u, "POST", `/keyframes/${kf.id}/promote`);
    const blocked = await call(u, "PATCH", `/shots/${sh.id}`, { action: "now it changes" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "needs_confirmation");
    assert.deepEqual(blocked.json.details.fields, ["action"]);
    await ok(u, "PATCH", `/shots/${sh.id}`, { camera: { shotSize: "CU", lensMm: 85 } }); // non-core edits are free
    await ok(u, "PATCH", `/shots/${sh.id}`, { action: "now it changes", confirm: true });
    // LLM refine on top of rules (mock echo): step is reported and shots still come out
    const a = await ok(u, "POST", `/projects/${p.id}/assets`, { type: "Character", name: "Mara", invariants: ["face"] });
    const run = await ok(u, "POST", `/projects/${p.id}/director/run`, { script: "INT. ROOM - NIGHT\nMara stands by the window.\nMARA: Hello.\nSuddenly the lamp flickers.", useLlm: true, minShots: 4 });
    const llm = run.steps.find((s: any) => s.step === "llm_refine");
    assert.equal(llm.status, "done");
    assert.equal(llm.detail.model, "mock-text");
    assert.ok(run.shotIds.length >= 4);
    assert.ok((await ok(u, "GET", `/generations?projectId=${p.id}`)).some((j: any) => j.kind === "text" && j.status === "SUCCEEDED" && j.userCharge > 0), "LLM call is recorded and charged");
    void a;
    // vision QC: SVG frames are not readable → skipped with a reason; a PNG frame goes to the vision model
    const q1 = await ok(u, "POST", `/shots/${sh.id}/qc`, { targetType: "keyframe", targetId: kf.id, auto: true });
    assert.equal(q1.vision.used, false);
    assert.match(q1.vision.reason, /raster/);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const media = await (await app.request(`/media?projectId=${p.id}`, { method: "POST", headers: { authorization: `Bearer ${u.token}` }, body: png })).json() as any;
    const ws = (await ok(u, "GET", "/workspaces/current")).id;
    db.prepare("INSERT INTO keyframes(id,workspace_id,project_id,shot_id,media_id,status,meta,created_at) VALUES('kfpng',?,?,?,?,?,?,?)").run(ws, p.id, sh.id, media.id, "variant", "{}", new Date().toISOString());
    const q2 = await ok(u, "POST", `/shots/${sh.id}/qc`, { targetType: "keyframe", targetId: "kfpng", auto: true });
    assert.equal(q2.vision.used, true);
    assert.equal(q2.vision.model, "mock-text");
    // metrics
    const admin = await login("admin@filmflow.local");
    const m = await call(admin, "GET", "/admin/metrics.txt");
    assert.match(m.json as string, /filmflow_queue_depth\{status="QUEUED"\}/);
    assert.match(m.json as string, /filmflow_job_run_ms_avg/);
    assert.match(m.json as string, /filmflow_job_succeeded_model_mock_image_(pro|lite)/);
    assert.equal((await call(u, "GET", "/admin/metrics.txt")).status, 403);
    void seq;
});

test("media derivatives (thumbnail) when ffmpeg is present", { skip: !hasFfmpeg }, async () => {
    const u = await login("media@example.com");
    const p = await ok(u, "POST", "/projects", { name: "m" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const up = await (await app.request(`/media?projectId=${p.id}`, { method: "POST", headers: { authorization: `Bearer ${u.token}` }, body: png })).json() as any;
    let m: any;
    for (let i = 0; i < 60; i++) { m = await ok(u, "GET", `/media/${up.id}`); if (m.thumbnailUrl) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(m.thumbnailUrl, "thumbnail generated");
    const t = await app.request(m.thumbnailUrl);
    assert.equal(t.headers.get("content-type"), "image/jpeg");
});

test("chunked resumable upload", async () => {
    const u = await login("chunk@example.com");
    const p = await ok(u, "POST", "/projects", { name: "c" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const parts = [png.subarray(0, 20), png.subarray(20, 50), png.subarray(50)];
    const { uploadId } = await ok(u, "POST", "/media/uploads", { size: png.length, parts: 3, projectId: p.id });
    const put = (n: number, b: Buffer) => app.request(`/media/uploads/${uploadId}/${n}`, { method: "PUT", headers: { authorization: `Bearer ${u.token}` }, body: new Uint8Array(b) });
    assert.equal((await put(2, parts[2])).status, 200); // out of order is fine
    assert.equal((await put(0, parts[0])).status, 200);
    assert.deepEqual((await ok(u, "GET", `/media/uploads/${uploadId}`)).missing, [1]); // resume: only part 1 is missing
    assert.equal((await call(u, "POST", `/media/uploads/${uploadId}/complete`, {})).status, 400);
    assert.equal((await put(5, parts[0])).status, 400);
    assert.equal((await put(1, parts[1])).status, 200);
    assert.equal((await put(1, parts[1])).status, 200); // retry is idempotent
    const m = await ok(u, "POST", `/media/uploads/${uploadId}/complete`, {});
    assert.equal(m.mime, "image/png");
    assert.equal((await call(u, "GET", `/media/uploads/${uploadId}`)).status, 404, "session cleaned");
    // type is validated on the assembled bytes, other tenants cannot touch the session
    const bad = await ok(u, "POST", "/media/uploads", { size: 12, parts: 1 });
    await app.request(`/media/uploads/${bad.uploadId}/0`, { method: "PUT", headers: { authorization: `Bearer ${u.token}` }, body: "not an image" });
    assert.equal((await call(u, "POST", `/media/uploads/${bad.uploadId}/complete`, {})).status, 400);
    const other = await login("chunk2@example.com");
    assert.equal((await call(other, "GET", `/media/uploads/${uploadId}`)).status, 404);
    const sess = await ok(u, "POST", "/media/uploads", { size: 5, parts: 1 });
    assert.equal((await call(other, "PUT", `/media/uploads/${sess.uploadId}/0`)).status, 404);
});
