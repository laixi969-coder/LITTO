import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "litto-test3-"));
const hasFfmpeg = (() => { try { execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch { return false; } })();
Object.assign(process.env, { LITTO_DATA_DIR: dir, LITTO_QUIET: "1", LITTO_MOCK_LATENCY_MS: "20", LITTO_WORKER_POLL_MS: "30", LITTO_NO_RATELIMIT: "1", NODE_ENV: "test", LITTO_NO_DERIVATIVES: "1" });

const { app } = await import("../src/app.ts");
const { startWorker, stopWorker } = await import("../src/jobs.ts");
const { seedProviders } = await import("../src/providers/registry.ts");
const { seedSkills } = await import("../src/domain/market-seed.ts");
const { db } = await import("../src/db.ts");
seedProviders();
seedSkills();
seedSkills(); // idempotent
before(() => startWorker());
after(() => { stopWorker(); rmSync(dir, { recursive: true, force: true }); });

type Who = { token: string; email: string };
async function call(who: Who | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any; try { json = JSON.parse(buf.toString()); } catch { json = buf.toString(); }
    return { status: res.status, json, buf, headers: res.headers };
}
const ok = async (who: Who | null, m: string, p: string, b?: unknown, h?: Record<string, string>) => { const r = await call(who, m, p, b, h); assert.ok(r.status < 300, `${m} ${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`); return r.json; };
// Hero/Take 采用前须完成人工真实感检查（realism.requireReviewed）；用例模拟审阅者确认已看过输出。
const reviewed = (who: Who | null, shotId: string, targetType: "keyframe" | "take", targetId: string) => ok(who, "POST", `/shots/${shotId}/qc`, {
    targetType, targetId, note: "已查看实际输出",
    reviewed: targetType === "take" ? ["surface", "imaging", "world", "motion", "cinematic"] : ["surface", "imaging", "world", "cinematic"],
    ...(targetType === "take" ? { observedStateDelta: {} } : {}),
});
async function login(email: string): Promise<Who> {
    const { devCode } = await ok(null, "POST", "/auth/request-code", { email });
    return { token: (await ok(null, "POST", "/auth/verify", { email, code: devCode, client: "api" })).token, email };
}
const png1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const upload = async (u: Who, projectId: string, data: Buffer) => (await (await app.request(`/media?projectId=${projectId}`, { method: "POST", headers: { authorization: `Bearer ${u.token}` }, body: new Uint8Array(data) })).json()) as any;
const equirect = () => { const f = join(dir, "eq.png"); execSync(`ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=1024x512 -frames:v 1 ${f}`); return readFileSync(f); };

async function fixture(email: string) {
    const u = await login(email);
    const p = await ok(u, "POST", "/projects", { name: "pano" });
    const media = await upload(u, p.id, hasFfmpeg ? equirect() : png1);
    const ref = await ok(u, "POST", `/projects/${p.id}/references`, { kind: "image", name: "lobby 360", mediaId: media.id });
    const env = await ok(u, "POST", `/projects/${p.id}/assets`, { type: "Environment", name: "Lobby", invariants: ["layout"] });
    await ok(u, "POST", `/assets/${env.id}/bindings`, { referenceId: ref.id, role: "PANORAMA" });
    const seq = await ok(u, "POST", `/projects/${p.id}/sequences`, { name: "s" });
    const shot = await ok(u, "POST", `/projects/${p.id}/shots`, { sequenceId: seq.id, title: "Wide", assetIds: [env.id], camera: { shotSize: "WS", lensMm: 24, viewYaw: 30, viewPitch: -5, viewFov: 80 } });
    return { u, p, ref, env, shot, seq };
}

test("DEPTH / PANORAMA roles, router degradation and camera view fields", async () => {
    const { u, p, ref, shot, seq } = await fixture("pano1@example.com");
    // roles accepted on shot bindings
    for (const role of ["DEPTH", "PANORAMA"]) assert.ok((await ok(u, "POST", `/shots/${shot.id}/bindings`, { referenceId: ref.id, role })).id);
    assert.equal((await call(u, "POST", `/shots/${shot.id}/bindings`, { referenceId: ref.id, role: "NOPE" })).status, 400);
    // router: pro supports both, lite degrades both
    const r = await ok(u, "POST", "/models/route-preview", { kind: "image", roles: ["DEPTH", "PANORAMA"], projectId: p.id });
    const pro = r.candidates.find((c: any) => c.modelId === "mock-image-pro"), lite = r.candidates.find((c: any) => c.modelId === "mock-image-lite");
    assert.equal(pro.degradations.length, 0);
    assert.deepEqual(lite.degradations.map((d: any) => d.role).sort(), ["DEPTH", "PANORAMA"]);
    assert.match(lite.degradations.find((d: any) => d.role === "DEPTH").strategy, /depth structure described textually/);
    assert.equal(r.chosen.modelId, "mock-image-pro");
    // camera validation: ranges enforced, old shots without a view still fine
    assert.equal((await call(u, "PATCH", `/shots/${shot.id}`, { camera: { shotSize: "MS", lensMm: 35, viewYaw: 200 } })).status, 400);
    assert.equal((await call(u, "PATCH", `/shots/${shot.id}`, { camera: { shotSize: "MS", lensMm: 35, viewFov: 5 } })).status, 400);
    const plain = await ok(u, "POST", `/projects/${p.id}/shots`, { sequenceId: seq.id, title: "plain" });
    assert.equal(plain.camera.viewYaw, undefined);
    void shot;
});

test("compiler: VIEW section, panorama input when supported, degradation when not, auto crop", async () => {
    const { u, shot } = await fixture("pano2@example.com");
    const pro = await ok(u, "POST", `/shots/${shot.id}/compile`, { kind: "image", modelId: "mock-image-pro" });
    assert.match(pro.compiled.prompt, /VIEW: camera inside Lobby facing yaw 30° pitch -5°, fov 80° — 0° yaw = panorama centre\/front, positive = turn right/);
    const pano = pro.compiled.inputs.find((i: any) => i.role === "PANORAMA");
    assert.ok(pano?.sent, "panorama sent to a capable model");
    assert.ok(!pro.compiled.degradations.some((d: any) => d.role === "PANORAMA"));
    const crop = pro.compiled.inputs.find((i: any) => i.role === "COMPOSITION");
    if (hasFfmpeg) { assert.ok(crop?.sent && crop.mediaId, "auto perspective crop attached"); assert.ok(pro.compiled.warnings.every((w: string) => !/panorama crop/.test(w))); }
    else assert.ok(pro.compiled.warnings.some((w: string) => /panorama crop skipped/.test(w)));
    // cached: compiling again reuses the same crop media
    if (hasFfmpeg) assert.equal((await ok(u, "POST", `/shots/${shot.id}/compile`, { kind: "image", modelId: "mock-image-pro" })).compiled.inputs.find((i: any) => i.role === "COMPOSITION").mediaId, crop.mediaId);
    // lite model: reported degradation, text fallback, nothing sent
    const lite = await ok(u, "POST", `/shots/${shot.id}/compile`, { kind: "image", modelId: "mock-image-lite" });
    assert.ok(lite.compiled.degradations.some((d: any) => d.role === "PANORAMA" && /described textually/.test(d.strategy)));
    assert.ok(!lite.compiled.inputs.some((i: any) => i.sent));
    // no view angles → no VIEW section
    await ok(u, "PATCH", `/shots/${shot.id}`, { camera: { shotSize: "WS", lensMm: 24 } });
    assert.ok(!/VIEW:/.test((await ok(u, "POST", `/shots/${shot.id}/compile`, { kind: "image", modelId: "mock-image-pro" })).compiled.prompt));
    // keyframe generation end-to-end with the panorama inputs
    await ok(u, "PATCH", `/shots/${shot.id}`, { camera: { shotSize: "WS", lensMm: 24, viewYaw: 90, viewPitch: 0, viewFov: 70 } });
    const g = await ok(u, "POST", `/shots/${shot.id}/keyframes`, { count: 1 });
    for (const t = Date.now(); ; ) { const j = await ok(u, "GET", `/generations/${g.job.id}`); if (j.status === "SUCCEEDED") break; assert.ok(j.status !== "FAILED", j.error); assert.ok(Date.now() - t < 8000); await new Promise((r) => setTimeout(r, 40)); }
});

test("panorama-view endpoint", async () => {
    const { u, ref, p } = await fixture("pano3@example.com");
    const r = await call(u, "GET", `/references/${ref.id}/panorama-view?yaw=45&pitch=10&fov=90&w=320&h=180`);
    if (hasFfmpeg) {
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-type"), "image/png");
        assert.deepEqual([...r.buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        assert.equal(r.buf.readUInt32BE(16), 320);
        assert.equal(r.buf.readUInt32BE(20), 180);
    } else { assert.equal(r.status, 501); assert.match(r.json.error, /ffmpeg/); }
    assert.equal((await call(u, "GET", `/references/${ref.id}/panorama-view?yaw=999`)).status, 400);
    const text = await ok(u, "POST", `/projects/${p.id}/references`, { kind: "text", name: "t", text: "hello" });
    assert.equal((await call(u, "GET", `/references/${text.id}/panorama-view`)).status, 400, "only raster images");
    const other = await login("pano3-other@example.com");
    assert.equal((await call(other, "GET", `/references/${ref.id}/panorama-view`)).status, 404, "tenant isolated");
});

const NOIR = "acme-noir-lighting";
const skillId = async (u: Who, slug: string) => (await ok(u, "GET", "/skills")).find((s: any) => s.slug === slug)?.id as string;
const manifest = (over: Record<string, any> = {}) => ({ slug: "custom-test", name: "T", version: "1.0.0", author: "t", description: "d", target: "shot", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: [] }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, systemPrompt: "sys", promptTemplate: "Note: {{input.note}}", apply: [], ...over });

test("skills catalog, install gating, run → validated patches → apply", async () => {
    const { u, p, shot, env } = await fixture("skills1@example.com");
    const cat = await ok(u, "GET", "/skills");
    assert.ok(cat.some((s: any) => s.builtin && s.slug === "assetDirector") && cat.some((s: any) => s.slug === NOIR && s.installed === false));
    assert.equal(cat.filter((s: any) => s.slug === NOIR).length, 1, "seed is idempotent");
    const id = await skillId(u, NOIR);
    // not installed → blocked
    const blocked = await call(u, "POST", `/skills/${id}/run`, { shotId: shot.id, input: { mood: "tense" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, "not_installed");
    await ok(u, "POST", `/skills/${id}/install`);
    // input validation
    assert.equal((await call(u, "POST", `/skills/${id}/run`, { shotId: shot.id, input: { mood: "sparkly" } })).status, 422);
    assert.equal((await call(u, "POST", `/skills/${id}/run`, { shotId: shot.id, input: {} })).status, 422);
    const run = await ok(u, "POST", `/skills/${id}/run`, { shotId: shot.id, input: { mood: "tense" } });
    assert.equal(run.model, "mock-text");
    assert.equal(run.patches[0].to, "shot.lighting");
    // run is a preview only: shot untouched
    assert.equal((await ok(u, "GET", `/shots/${shot.id}`)).lighting.key, "");
    // the prompt was built from this workspace's data only and recorded as a job
    const job = (await ok(u, "GET", `/generations/${run.jobId}`));
    assert.match(job.compiledPrompt, /Shot: Wide\. Action: \. Camera: WS 24mm/);
    assert.match(job.compiledPrompt, /Mood: tense/);
    // apply (user-edited patch value is validated again)
    assert.equal((await call(u, "POST", `/skills/${id}/apply`, { shotId: shot.id, patches: [{ to: "shot.lighting", value: { key: 1 } }] })).status, 422);
    assert.equal((await call(u, "POST", `/skills/${id}/apply`, { shotId: shot.id, patches: [{ to: "shot.camera", value: { lensMm: 50 } }] })).status, 400, "skill cannot apply outside its mapping");
    const applied = await ok(u, "POST", `/skills/${id}/apply`, { shotId: shot.id, patches: [{ to: "shot.lighting", value: { key: "hard top light", keyDirection: "top" } }] });
    assert.equal(applied.lighting.key, "hard top light");
    assert.equal(applied.lighting.keyDirection, "top");
    assert.equal(applied.lighting.timeOfDay, "", "merge keeps untouched fields");
    // another tenant cannot target this shot, nor run without installing
    const other = await login("skills1-other@example.com");
    await ok(other, "POST", `/skills/${id}/install`);
    assert.equal((await call(other, "POST", `/skills/${id}/run`, { shotId: shot.id, input: { mood: "tense" } })).status, 404);
    assert.equal((await call(other, "POST", `/skills/${id}/apply`, { shotId: shot.id, patches: [{ to: "shot.lighting", value: { key: "x" } }] })).status, 404);
    // uninstall
    await ok(u, "DELETE", `/skills/${id}/install`);
    assert.equal((await call(u, "POST", `/skills/${id}/run`, { shotId: shot.id, input: { mood: "tense" } })).status, 403);
    // asset skill: draft asset can be updated, approved asset is locked
    const pid = await skillId(u, "acme-prop-continuity");
    await ok(u, "POST", `/skills/${pid}/install`);
    const draft = await ok(u, "POST", `/projects/${p.id}/assets`, { type: "Prop", name: "Lamp", invariants: ["shape"] });
    const pr = await ok(u, "POST", `/skills/${pid}/run`, { assetId: draft.id, input: { strictness: "strict" } });
    assert.deepEqual(pr.patches.map((x: any) => x.to), ["asset.invariants", "asset.forbiddenChanges"]);
    const up = await ok(u, "POST", `/skills/${pid}/apply`, { assetId: draft.id, patches: [{ to: "asset.invariants", value: ["brass base", "linen shade"] }] });
    assert.deepEqual(up.invariants, ["brass base", "linen shade"]);
    await ok(u, "POST", `/assets/${draft.id}/approve`);
    const locked = await call(u, "POST", `/skills/${pid}/apply`, { assetId: draft.id, patches: [{ to: "asset.invariants", value: ["changed"] }] });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.code, "asset_locked");
    assert.deepEqual((await ok(u, "GET", `/assets/${draft.id}`)).invariants, ["brass base", "linen shade"]);
    void env;
});

test("built-in skills run deterministically", async () => {
    const { u, p, shot, env } = await fixture("skills2@example.com");
    const ad = await ok(u, "POST", "/skills/builtin:assetDirector/run", { assetId: env.id });
    assert.ok(ad.output.requiredViews.length && ad.patches.some((x: any) => x.to === "asset.invariants"));
    const ci = await ok(u, "POST", "/skills/builtin:cinematographer/run", { shotId: shot.id });
    assert.ok(ci.output.lensMm > 0);
    const vd = await ok(u, "POST", "/skills/builtin:visualDirector/run", { projectId: p.id, input: { notes: "noir, high contrast, 16mm film" } });
    assert.equal(vd.output.look.contrast, "high");
    assert.equal((await call(u, "POST", "/skills/builtin:visualDirector/run", { projectId: p.id, input: {} })).status, 422);
    assert.equal((await call(u, "POST", "/skills/builtin:storyboardDirector/run", { projectId: p.id })).status, 400);
    assert.equal((await call(u, "POST", "/skills/builtin:assetDirector/install")).status, 400);
});

test("publishing: strict manifests, admin only, draft/unpublish, injection safety, invalid LLM output", async () => {
    const admin = await login("admin@litto.local");
    const { u, shot } = await fixture("skills3@example.com");
    // only admins publish
    assert.equal((await call(u, "POST", "/admin/skills", { manifest: manifest() })).status, 403);
    assert.equal((await call(u, "GET", "/admin/skills")).status, 403);
    // strict manifest validation
    const bad = async (over: Record<string, any>, re: RegExp) => { const r = await call(admin, "POST", "/admin/skills", { manifest: manifest(over) }); assert.equal(r.status, 422, JSON.stringify(r.json)); assert.match(JSON.stringify(r.json.details), re); };
    await bad({ promptTemplate: "key {{credentials.apiKey}}" }, /not allowed/);
    await bad({ promptTemplate: "{{shot.id}} {{shot.workspaceId}}" }, /not allowed/);
    await bad({ promptTemplate: "{{input.missing}}" }, /unknown input/);
    await bad({ promptTemplate: "{{asset.name}}" }, /not allowed for target .{1,2}shot/);
    await bad({ promptTemplate: "{{world.era}" }, /malformed/);
    await bad({ apply: [{ to: "shot.workspace", from: "/text" }] }, /apply/);
    await bad({ apply: [{ to: "asset.invariants", from: "/text" }] }, /requires skill target/);
    await bad({ apply: [{ to: "shot.action", from: "/nope" }] }, /does not exist/);
    await bad({ slug: "Bad Slug" }, /slug/);
    await bad({ version: "1.0" }, /version/);
    await bad({ extra: true }, /Unrecognized|unrecognized/);
    await bad({ outputSchema: { type: "object", properties: { text: { type: "function" } } } }, /type/);
    assert.equal((await call(admin, "POST", "/admin/skills", { manifest: manifest({ systemPrompt: "x".repeat(5000) }) })).status, 422);
    // publish + update (slug+version unique → update in place)
    const pub = await ok(admin, "POST", "/admin/skills", { manifest: manifest({ promptTemplate: "Note: {{input.note}} | era: {{world.era}} | title: {{shot.title}}", apply: [{ to: "shot.action", from: "/text" }] }) });
    await ok(admin, "POST", "/admin/skills", { manifest: manifest({ name: "T renamed", promptTemplate: "Note: {{input.note}} | era: {{world.era}} | title: {{shot.title}}", apply: [{ to: "shot.action", from: "/text" }] }) });
    assert.equal((await ok(admin, "GET", "/admin/skills")).filter((s: any) => s.slug === "custom-test").length, 1);
    await ok(u, "POST", `/skills/${pub.id}/install`);
    // template injection: values are substituted once and never re-expanded; no way to name other data
    const r = await ok(u, "POST", `/skills/${pub.id}/run`, { shotId: shot.id, input: { note: "{{world.era}} {{credentials.x}} {{shot.workspaceId}}" } });
    const job = await ok(u, "GET", `/generations/${r.jobId}`);
    assert.match(job.compiledPrompt, /Note: \{\{world\.era\}\} \{\{credentials\.x\}\} \{\{shot\.workspaceId\}\} \| era: {2}\| title: Wide/);
    assert.ok(!job.compiledPrompt.includes(shot.workspaceId));
    // oversized prompt rejected
    assert.equal((await call(u, "POST", `/skills/${pub.id}/run`, { shotId: shot.id, input: { note: "x".repeat(9000) } })).status, 422); // string > 4000 fails input validation first
    // apply to a core-intent field goes through the confirm gate
    const g = await ok(u, "POST", `/shots/${shot.id}/keyframes`, { count: 1 });
    for (const t = Date.now(); (await ok(u, "GET", `/generations/${g.job.id}`)).status !== "SUCCEEDED"; ) { assert.ok(Date.now() - t < 8000); await new Promise((x) => setTimeout(x, 40)); }
    const kf = (await ok(u, "GET", `/shots/${shot.id}`)).keyframes[0];
    await reviewed(u, shot.id, "keyframe", kf.id);
    await ok(u, "POST", `/keyframes/${kf.id}/promote`);
    const gate = await call(u, "POST", `/skills/${pub.id}/apply`, { shotId: shot.id, patches: [{ to: "shot.action", value: "new action" }] });
    assert.equal(gate.status, 409);
    assert.equal(gate.json.code, "needs_confirmation");
    assert.equal((await ok(u, "POST", `/skills/${pub.id}/apply`, { shotId: shot.id, patches: [{ to: "shot.action", value: "new action" }], confirm: true })).action, "new action");
    // invalid model output is rejected and never applied (enum [] can never be satisfied by the mock reply)
    const strict = await ok(admin, "POST", "/admin/skills", { manifest: manifest({ slug: "strict-out", outputSchema: { type: "object", properties: { text: { type: "string", enum: [] } }, required: ["text"] }, apply: [{ to: "shot.action", from: "/text" }] }) });
    await ok(u, "POST", `/skills/${strict.id}/install`);
    const inv = await call(u, "POST", `/skills/${strict.id}/run`, { shotId: shot.id, input: {} });
    assert.equal(inv.status, 422);
    assert.equal(inv.json.code, "invalid_output");
    assert.equal((await ok(u, "GET", `/shots/${shot.id}`)).action, "new action");
    // draft hides from the catalog and blocks installs; delete removes
    await ok(admin, "PATCH", `/admin/skills/${strict.id}`, { status: "draft" });
    assert.ok(!(await ok(u, "GET", "/skills")).some((s: any) => s.id === strict.id));
    assert.equal((await call(u, "POST", `/skills/${strict.id}/install`)).status, 404);
    await ok(admin, "DELETE", `/admin/skills/${strict.id}`);
    assert.ok(!(await ok(admin, "GET", "/admin/skills")).some((s: any) => s.id === strict.id));
    assert.ok((await ok(admin, "GET", "/admin/audit")).some((a: any) => a.action === "skill.publish"));
    void db;
});

test("team: only ADMIN+ may install skills; EDITOR may run installed ones", async () => {
    const owner = await login("skills-owner@example.com"), editor = await login("skills-editor@example.com");
    const ws = await ok(owner, "POST", "/workspaces", { name: "Skills team" });
    const H = { "x-workspace-id": ws.id };
    await ok(owner, "POST", "/workspaces/current/members", { email: editor.email, role: "EDITOR" }, H);
    const id = await skillId(owner, NOIR);
    assert.equal((await call(editor, "POST", `/skills/${id}/install`, undefined, H)).status, 403);
    await ok(owner, "POST", `/skills/${id}/install`, undefined, H);
    const p = await ok(editor, "POST", "/projects", { name: "t" }, H);
    const seq = await ok(editor, "POST", `/projects/${p.id}/sequences`, { name: "s" }, H);
    const sh = await ok(editor, "POST", `/projects/${p.id}/shots`, { sequenceId: seq.id, title: "x" }, H);
    assert.equal((await call(editor, "POST", `/skills/${id}/run`, { shotId: sh.id, input: { mood: "menacing" } }, H)).status, 200);
});
