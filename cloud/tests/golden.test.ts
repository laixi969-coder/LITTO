import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "litto-test-"));
Object.assign(process.env, { LITTO_DATA_DIR: dir, LITTO_MOCK_LATENCY_MS: "30", LITTO_WORKER_POLL_MS: "40", LITTO_NO_RATELIMIT: "1", NODE_ENV: "test" });

const { app } = await import("../src/app.ts");
const { startWorker, stopWorker } = await import("../src/jobs.ts");
const { seedProviders } = await import("../src/providers/registry.ts");
const { db } = await import("../src/db.ts");

seedProviders();
before(() => startWorker());
after(() => { stopWorker(); rmSync(dir, { recursive: true, force: true }); });

type Who = { token: string; email: string };
async function call(who: Who | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}
const ok = async (who: Who | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await call(who, method, path, body, headers);
    assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
    return r.json;
};
async function login(email: string): Promise<Who> {
    const { devCode } = await ok(null, "POST", "/auth/request-code", { email });
    const r = await ok(null, "POST", "/auth/verify", { email, code: devCode, client: "api" });
    return { token: r.token, email };
}
async function waitJobs(who: Who, ids: string[], want = "SUCCEEDED", ms = 8000) {
    const t = Date.now();
    for (;;) {
        const js = await Promise.all(ids.map((id) => ok(who, "GET", `/generations/${id}`)));
        if (js.every((j) => ["SUCCEEDED", "FAILED", "TIMEOUT", "CANCELLED"].includes(j.status))) { js.forEach((j) => assert.equal(j.status, want, j.error)); return js; }
        assert.ok(Date.now() - t < ms, "jobs did not finish: " + JSON.stringify(js.map((j) => j.status)));
        await new Promise((r) => setTimeout(r, 50));
    }
}
const png = (() => { // minimal valid 1x1 PNG
    const b = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    return b;
})();
const upload = async (who: Who, projectId: string) => {
    const res = await app.request(`/media?projectId=${projectId}`, { method: "POST", headers: { authorization: `Bearer ${who.token}`, "content-type": "image/png" }, body: png });
    assert.equal(res.status, 201);
    return (await res.json()) as any;
};

const SCRIPT = `INT. APARTMENT - NIGHT
Mara stands by the window, watching the rain. Eli enters the apartment, quiet.
Mara notices the Letter on the table. She picks up the Letter and turns it over.
MARA: You read it, didn't you?
ELI: I had to know.
Suddenly the lamp flickers. Mara drops the Letter and steps back, afraid.
EXT. STREET - DAY
Eli walks out and grabs the Key from his pocket. He stares at the door behind him.`;

const S: any = {};

test("1-2 auth, personal workspace and tenant isolation", async () => {
    S.A = await login("alice@example.com");
    S.B = await login("bob@example.com");
    const me = await ok(S.A, "GET", "/auth/me");
    assert.equal(me.workspaces.length, 1);
    assert.equal(me.workspaces[0].kind, "personal");
    assert.notEqual((await ok(S.B, "GET", "/auth/me")).workspaceId, me.workspaceId);
    assert.equal((await call(null, "GET", "/projects")).status, 401);

    S.proj = await ok(S.A, "POST", "/projects", { name: "Night Letter" });
    const media = await upload(S.A, S.proj.id);
    // B can't read A's project / media / sub-resources, nor spoof A's workspace header.
    assert.equal((await call(S.B, "GET", `/projects/${S.proj.id}`)).status, 404);
    assert.equal((await call(S.B, "GET", `/media/${media.id}`)).status, 404);
    assert.equal((await call(S.B, "GET", `/projects/${S.proj.id}/assets`)).status, 404);
    assert.equal((await call(S.B, "GET", "/projects", undefined, { "x-workspace-id": me.workspaceId })).status, 403);
    assert.deepEqual(await ok(S.B, "GET", "/projects"), []);
    // Signed URL works and tampering fails.
    const f = await app.request(media.url);
    assert.equal(f.status, 200);
    assert.equal((await app.request(media.url.replace(/sig=.{4}/, "sig=0000"))).status, 403);
    // Upload validation: non-media rejected.
    const bad = await app.request("/media", { method: "POST", headers: { authorization: `Bearer ${S.A.token}` }, body: "not an image" });
    assert.equal(bad.status, 400);
    S.refImg = media;
});

test("3 admin configures providers/models, tests connection, toggles models", async () => {
    S.ADMIN = await login("admin@litto.local");
    assert.equal((await call(S.A, "GET", "/admin/dashboard")).status, 403);
    const providers = await ok(S.ADMIN, "GET", "/admin/providers");
    assert.ok(providers.find((p: any) => p.id === "mock"));
    const t = await ok(S.ADMIN, "POST", "/admin/providers/mock/test");
    assert.equal(t.ok, true);
    // a flaky provider whose model is top-ranked, to exercise fallback / refund
    await ok(S.ADMIN, "POST", "/admin/providers", { id: "dead", name: "Dead provider", adapter: "mock", baseUrl: "mock://fail", priority: 1, retryPolicy: { maxAttempts: 2, backoffMs: 10 } });
    assert.equal((await ok(S.ADMIN, "POST", "/admin/providers/dead/test")).ok, false);
    await ok(S.ADMIN, "POST", "/admin/models", { id: "dead-image", providerId: "dead", externalModelId: "dead", name: "Dead Image", type: "image", capabilities: { text2image: true, identityReference: true, multiReference: true, compositionReference: true, maxInputs: 8, costClass: "high", latencyClass: "low" }, price: { perImage: 0.02 }, status: "disabled", fallbackModelId: "mock-image-pro" });
    const m = await ok(S.ADMIN, "PATCH", "/admin/models/mock-image-lite", { status: "disabled" });
    assert.equal(m.status, "disabled");
    await ok(S.ADMIN, "PATCH", "/admin/models/mock-image-lite", { status: "active" });
    const audit = await ok(S.ADMIN, "GET", "/admin/audit");
    assert.ok(audit.some((a: any) => a.action === "provider.create"));
});

test("4 BYOK: key is encrypted, masked, never stored in plaintext", async () => {
    await ok(S.ADMIN, "POST", "/admin/providers/openai-compatible/credentials", { secret: "sk-PLATFORM-0123456789abcdef" });
    const SECRET = "sk-USER-SECRET-9876543210zyxwv";
    const c = await ok(S.A, "POST", "/credentials", { providerId: "openai-compatible", secret: SECRET, label: "my key" });
    assert.match(c.masked, /^••••zxwv$|^••••.{4}$/);
    assert.ok(!JSON.stringify(c).includes("SECRET"));
    assert.ok(!JSON.stringify(await ok(S.A, "GET", "/credentials")).includes("SECRET"));
    assert.equal((await call(S.B, "GET", "/credentials")).json.length, 0);
    // 20: plaintext must not appear anywhere in the db files.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const f of readdirSync(dir).filter((x) => x.startsWith("litto.db"))) {
        const bytes = readFileSync(join(dir, f)).toString("latin1");
        assert.ok(!bytes.includes(SECRET), `${f} contains plaintext key`);
        assert.ok(!bytes.includes("PLATFORM-0123456789"), `${f} contains plaintext platform key`);
    }
    const audits = JSON.stringify(await ok(S.ADMIN, "GET", "/admin/audit"));
    assert.ok(!audits.includes("PLATFORM-0123") && !audits.includes("USER-SECRET"));
    await ok(S.A, "DELETE", `/credentials/${c.id}`);
});

test("5-6 world/look and approved assets", async () => {
    const pid = S.proj.id;
    await ok(S.A, "PUT", `/projects/${pid}/world`, { era: "present day", locationLogic: "a rainy coastal city", architecture: "1960s concrete apartment block", weather: "heavy rain", time: "night", material: "concrete, worn wood, glass", physics: "real-world", realism: "photographic" });
    await ok(S.A, "PUT", `/projects/${pid}/looks/project`, { contrast: "high", saturation: "muted", palette: ["teal", "amber"], grain: "visible 16mm-like", halation: "subtle", highlightRolloff: "long, filmic" });
    const mk = async (type: string, name: string, extra: any = {}) => {
        const ref = await ok(S.A, "POST", `/projects/${pid}/references`, { kind: "image", name: `${name} ref`, mediaId: S.refImg.id });
        const sug = await ok(S.A, "POST", `/projects/${pid}/assets/suggest`, { type, name });
        const a = await ok(S.A, "POST", `/projects/${pid}/assets`, { type, name, references: [ref.id], invariants: sug.invariants, allowedVariations: sug.allowedVariations, forbiddenChanges: sug.forbiddenChanges, ...extra });
        S[name] = { asset: await ok(S.A, "POST", `/assets/${a.id}/approve`), ref };
        return S[name];
    };
    await mk("Character", "Mara"); await mk("Character", "Eli"); await mk("Environment", "Apartment");
    await mk("Prop", "Letter"); await mk("Prop", "Key");
    const wardrobe = await mk("Wardrobe", "Mara coat", { attributes: { wornBy: S.Mara.asset.id } });
    assert.equal(wardrobe.asset.approvalStatus, "approved");
    // approved assets are locked
    const r = await call(S.A, "PATCH", `/assets/${S.Mara.asset.id}`, { description: "changed" });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "asset_locked");
    // approval requires invariants
    const empty = await ok(S.A, "POST", `/projects/${pid}/assets`, { type: "Prop", name: "Empty" });
    assert.equal((await call(S.A, "POST", `/assets/${empty.id}/approve`)).status, 400);
    // unapproved deletion of approved asset needs confirmation
    assert.equal((await call(S.A, "DELETE", `/assets/${S.Key.asset.id}`)).status, 400);
});

test("7-8 script → ≥8 shots with assets and reference roles (Director Agent)", async () => {
    const pid = S.proj.id;
    const run = await ok(S.A, "POST", `/projects/${pid}/director/run`, { script: SCRIPT, goal: "moody 16mm drama", mode: "director", minShots: 8 });
    assert.ok(run.shotIds.length >= 8, `got ${run.shotIds.length} shots`);
    assert.deepEqual(run.steps.map((s: any) => s.step), ["understand_goal", "world_and_assets", "sequence_and_shots", "skills", "reference_plan", "freedom_map", "router", "generate", "qc", "continuity", "repair"]);
    S.seq = run.sequenceId;
    const fns = new Set(run.steps[2].detail.functions);
    for (const f of ["Establish", "Reveal", "Reaction"]) assert.ok(fns.has(f), `missing narrative function ${f}`);
    assert.ok(run.shotIds.length < SCRIPT.split(/[.!?]/).length + 4, "must not be one-shot-per-sentence");
    S.shots = await ok(S.A, "GET", `/projects/${pid}/shots?sequenceId=${S.seq}`);
    // every Shot gets Asset + ReferenceRole bindings
    for (const sh of S.shots) {
        assert.ok(sh.assetIds.length > 0);
        for (const id of sh.assetIds) {
            const asset = [S.Mara, S.Eli, S.Apartment, S.Letter, S.Key, S["Mara coat"]].find((x) => x.asset.id === id);
            if (!asset) continue;
            const role = asset.asset.type === "Character" ? "IDENTITY" : asset.asset.type === "Environment" ? "ENVIRONMENT" : "GEOMETRY";
            await ok(S.A, "POST", `/shots/${sh.id}/bindings`, { referenceId: asset.ref.id, role, weight: 1, lockLevel: role === "IDENTITY" ? "LOCK" : "CONTROL" });
        }
    }
    S.shots = await ok(S.A, "GET", `/projects/${pid}/shots?sequenceId=${S.seq}`);
    assert.ok(S.shots.every((s: any) => s.bindings.length > 0));
    // continuity is clean for a director-authored storyboard
    assert.equal(S.shots.flatMap((s: any) => s.issues).filter((i: any) => i.severity === "high").length, 0, JSON.stringify(S.shots.flatMap((s: any) => s.issues)));
});

test("9 keyframes → Hero Frame (LOCK) with compiled, non-fluff prompt", async () => {
    const sh = S.shots[1];
    const c = await ok(S.A, "POST", `/shots/${sh.id}/compile`, { kind: "image" });
    assert.ok(c.compiled.prompt.includes("LOCK:"), "prompt carries LOCK items");
    assert.ok(!/8k|ultra realistic|masterpiece/i.test(c.compiled.prompt));
    const dirty = await ok(S.A, "PATCH", `/shots/${sh.id}`, { action: "Mara stands, ultra realistic 8K cinematic perfect masterpiece" });
    const c2 = await ok(S.A, "POST", `/shots/${sh.id}/compile`, { kind: "image" });
    assert.ok(!/8k|ultra realistic|masterpiece/i.test(c2.compiled.prompt), "fluff must be stripped");
    assert.ok(c2.compiled.warnings.length > 0);
    void dirty;
    const gen = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 3 }, { "idempotency-key": "kf-1" });
    const again = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 3 }, { "idempotency-key": "kf-1" });
    assert.equal(again.job.id, gen.job.id, "idempotent");
    await waitJobs(S.A, [gen.job.id]);
    const detail = await ok(S.A, "GET", `/shots/${sh.id}`);
    assert.equal(detail.keyframes.length, 3);
    const hero = await ok(S.A, "POST", `/keyframes/${detail.keyframes[0].id}/promote`);
    assert.equal(hero.status, "hero");
    S.heroShot = sh;
    S.kf = detail.keyframes;
    // promoting another keeps history (no silent overwrite)
    await ok(S.A, "POST", `/keyframes/${detail.keyframes[1].id}/promote`);
    const d2 = await ok(S.A, "GET", `/shots/${sh.id}`);
    assert.equal(d2.keyframes.find((k: any) => k.id === detail.keyframes[0].id).status, "superseded");
    assert.equal(d2.keyframes.length, 3);
    // 14: rollback Hero
    const rb = await ok(S.A, "POST", `/shots/${sh.id}/hero/rollback`, { keyframeId: detail.keyframes[0].id });
    assert.equal(rb.status, "hero");
});

test("10 takes from Hero Frame and approval; 13 QC → repair actions", async () => {
    const sh = S.heroShot;
    const t = await ok(S.A, "POST", `/shots/${sh.id}/takes`, { count: 2 });
    await waitJobs(S.A, t.jobs.map((j: any) => j.id));
    const detail = await ok(S.A, "GET", `/shots/${sh.id}`);
    assert.equal(detail.takes.length, 2);
    // Take requires a hero frame
    const noHero = await call(S.A, "POST", `/shots/${S.shots[5].id}/takes`, {});
    assert.equal(noHero.status, 409);
    assert.equal(noHero.json.code, "no_hero_frame");
    const qc = await ok(S.A, "POST", `/shots/${sh.id}/qc`, { targetType: "take", targetId: detail.takes[1].id, observations: [{ kind: "hand_artifact" }, { kind: "identity_drift" }, { kind: "color_shift" }] });
    const actions = qc.repairActions.map((a: any) => a.action);
    assert.ok(actions.includes("inpaint_local") && actions.includes("reference_replace") && actions.includes("look_normalization"));
    assert.ok(qc.report.score < 100 && qc.repairActions.every((a: any) => a.cause && a.detail));
    const ap = await ok(S.A, "POST", `/repair-actions/${qc.repairActions.find((a: any) => a.action === "reference_replace").id}/apply`);
    assert.equal(ap.applied, true);
    await waitJobs(S.A, ap.jobs.map((j: any) => j.id));
    const approved = await ok(S.A, "POST", `/takes/${detail.takes[0].id}/approve`, {});
    assert.equal(approved.status, "approved");
    // 14: rollback approved take
    await ok(S.A, "POST", `/takes/${detail.takes[1].id}/approve`, {});
    const rb = await ok(S.A, "POST", `/shots/${sh.id}/take/rollback`, { takeId: detail.takes[0].id });
    assert.equal(rb.id, detail.takes[0].id);
    assert.equal((await ok(S.A, "GET", `/shots/${sh.id}`)).takes.filter((x: any) => x.status === "approved").length, 1);
    const hist = await ok(S.A, "GET", `/shots/${sh.id}/history`);
    assert.ok(hist.some((h: any) => h.action === "rollback"));
});

test("11 state inheritance: shot N+1 inherits shot N result", async () => {
    const shots = await ok(S.A, "GET", `/projects/${S.proj.id}/shots?sequenceId=${S.seq}`);
    for (let i = 1; i < shots.length; i++) {
        const prev = shots[i - 1].state.result, cur = shots[i].state.start;
        // everything the previous shot ended with (props, characters, lighting) is what this one starts with
        for (const k of Object.keys(prev.props)) assert.deepEqual(cur.props[k]?.name, prev.props[k].name);
        for (const k of Object.keys(prev.characters)) assert.ok(cur.characters[k], `character ${k} inherited into shot ${i}`);
        // lighting carries within a scene; a new scene re-declares its own
        if (shots[i].sceneId === shots[i - 1].sceneId) assert.equal(cur.lighting.timeOfDay, prev.lighting.timeOfDay);
    }
    const pickup = shots.find((s: any) => Object.values<any>(s.intendedStateDelta?.props ?? {}).some((p: any) => p.heldBy));
    assert.ok(pickup, "script has a pick-up delta");
    const idx = shots.indexOf(pickup);
    const letterId = Object.keys(pickup.intendedStateDelta.props)[0];
    assert.ok(pickup.state.result.props[letterId].heldBy, "result has the prop held");
    assert.ok(shots[idx + 1].state.start.props[letterId].heldBy, "next shot inherits who holds the prop");
});

test("12 continuity catches identity / prop / lighting / direction conflicts and gates approval", async () => {
    const pid = S.proj.id;
    const seq = await ok(S.A, "POST", `/projects/${pid}/sequences`, { name: "Conflict test" });
    const scenes = await ok(S.A, "POST", `/projects/${pid}/scenes`, { sequenceId: seq.id, name: "Room" });
    const base = { sequenceId: seq.id, sceneId: scenes.id };
    const cam = (side: string, dir = "none") => ({ shotSize: "MS", lensMm: 35, side, screenDirection: dir });
    const unapproved = await ok(S.A, "POST", `/projects/${pid}/assets`, { type: "Character", name: "Ghost", invariants: ["x"] });
    const dress = await ok(S.A, "POST", `/projects/${pid}/assets`, { type: "Wardrobe", name: "Mara dress", invariants: ["red"], attributes: { wornBy: S.Mara.asset.id } });
    const s1 = await ok(S.A, "POST", `/projects/${pid}/shots`, { ...base, title: "one", intendedStateDelta: { props: { [S.Letter.asset.id]: { heldBy: S.Mara.asset.id, present: true } } }, assetIds: [S.Mara.asset.id, S["Mara coat"].asset.id, S.Apartment.asset.id, S.Letter.asset.id], camera: cam("A", "left"), lighting: { timeOfDay: "day", keyDirection: "left", colorTemp: "5600K" }, performance: { intensity: 0.2 } });
    const s2 = await ok(S.A, "POST", `/projects/${pid}/shots`, { ...base, title: "two", assetIds: [S.Mara.asset.id, dress.id, unapproved.id], camera: cam("B", "right"), lighting: { timeOfDay: "night", keyDirection: "right", colorTemp: "3200K" }, performance: { intensity: 0.2 } });
    const issues = await ok(S.A, "POST", `/sequences/${seq.id}/continuity`);
    const cats = issues.map((i: any) => `${i.category}:${i.severity}`);
    for (const want of ["Cinematic:high", "Lighting:high", "Lighting:medium", "Identity:medium", "State:low", "State:high"]) assert.ok(cats.includes(want), `expected ${want} in ${cats}`);
    assert.ok(issues.some((i: any) => /180/.test(i.message)));
    assert.ok(issues.every((i: any) => i.repair?.action));
    // High issues block approving a take; override requires a reason and is recorded.
    const kf = await ok(S.A, "POST", `/shots/${s2.id}/keyframes`, { count: 1 }).catch(() => null);
    void kf;
    const bindRef = await ok(S.A, "POST", `/shots/${s2.id}/bindings`, { referenceId: S.Mara.ref.id, role: "IDENTITY" });
    void bindRef;
    const g = await ok(S.A, "POST", `/shots/${s2.id}/keyframes`, { count: 1 });
    await waitJobs(S.A, [g.job.id]);
    const kfs = (await ok(S.A, "GET", `/shots/${s2.id}`)).keyframes;
    await ok(S.A, "POST", `/keyframes/${kfs[0].id}/promote`);
    const tk = await ok(S.A, "POST", `/shots/${s2.id}/takes`, { count: 1 });
    await waitJobs(S.A, tk.jobs.map((j: any) => j.id));
    const take = (await ok(S.A, "GET", `/shots/${s2.id}`)).takes[0];
    const blocked = await call(S.A, "POST", `/takes/${take.id}/approve`, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "continuity_blocked");
    const forced = await ok(S.A, "POST", `/takes/${take.id}/approve`, { overrideReason: "intentional crossing for the match cut" });
    assert.equal(forced.status, "approved");
    assert.ok((await ok(S.A, "GET", `/shots/${s2.id}/history`)).some((h: any) => h.action === "override_continuity"));
    void s1;
});

test("15 swapping provider keeps ShotSpec and asset relations", async () => {
    const sh = S.shots[2];
    const before = await ok(S.A, "GET", `/shots/${sh.id}`);
    await ok(S.A, "PUT", "/workspaces/current/model-policy", { imageModelId: "mock-image-lite" });
    const g = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    assert.ok(g.degradations.some((d: any) => d.role === "IDENTITY"), "lite model degrades IDENTITY visibly");
    const [job] = await waitJobs(S.A, [g.job.id]);
    assert.equal(job.modelId, "mock-image-lite");
    await ok(S.A, "PUT", "/workspaces/current/model-policy", { imageModelId: "mock-image-pro" });
    const g2 = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    const [job2] = await waitJobs(S.A, [g2.job.id]);
    assert.equal(job2.modelId, "mock-image-pro");
    const after = await ok(S.A, "GET", `/shots/${sh.id}`);
    for (const k of ["assetIds", "camera", "lighting", "narrativeFunction", "intendedStateDelta"]) assert.deepEqual(after[k], before[k]);
    assert.equal(after.bindings.length, before.bindings.length);
    await ok(S.A, "PUT", "/workspaces/current/model-policy", { imageModelId: null });
});

test("16 jobs survive restart and resume", async () => {
    const sh = S.shots[3];
    const g = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    stopWorker();
    db.prepare("UPDATE generation_jobs SET status='RUNNING' WHERE id=?").run(g.job.id); // as if the process died mid-run
    startWorker(); // boot recovery re-queues RUNNING jobs
    await waitJobs(S.A, [g.job.id]);
});

test("17 failure: retry, fallback, refund, cancel", async () => {
    const ws = await ok(S.A, "GET", "/credits");
    const sh = S.shots[4];
    // enable the dead model and force it first
    await ok(S.ADMIN, "PATCH", "/admin/models/dead-image", { status: "active" });
    await ok(S.A, "PUT", "/workspaces/current/model-policy", { imageModelId: "dead-image", allowFallback: true });
    const g = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    const [fb] = await waitJobs(S.A, [g.job.id]);
    assert.deepEqual(fb.fallbackChain, ["dead-image", "mock-image-pro"]);
    assert.ok(fb.attempts >= 1 && fb.userCharge > 0);
    // no fallback: fails, hold fully refunded
    await ok(S.A, "PUT", "/workspaces/current/model-policy", { imageModelId: "dead-image", allowFallback: false });
    const before = await ok(S.A, "GET", "/credits");
    const g2 = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    const [bad] = await waitJobs(S.A, [g2.job.id], "FAILED");
    assert.match(bad.error, /unavailable/);
    const after = await ok(S.A, "GET", "/credits");
    assert.equal(after.held, 0);
    assert.equal(after.balance, before.balance, "failed job costs nothing");
    assert.ok(after.ledger.some((l: any) => l.type === "REFUND" && l.job_id === g2.job.id));
    // manual retry after the provider is fixed creates a child job
    await ok(S.ADMIN, "PATCH", "/admin/providers/dead", { baseUrl: "mock://ok" });
    await ok(S.A, "PUT", "/workspaces/current/model-policy", { imageModelId: null, allowFallback: true });
    const child = await ok(S.A, "POST", `/generations/${g2.job.id}/retry`);
    assert.equal(child.parentJobId, g2.job.id);
    await waitJobs(S.A, [child.id]);
    // cancel
    const g3 = await ok(S.A, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    await ok(S.A, "POST", `/generations/${g3.job.id}/cancel`);
    const c = await ok(S.A, "GET", `/generations/${g3.job.id}`);
    assert.equal(c.status, "CANCELLED");
    assert.equal((await ok(S.A, "GET", "/credits")).held, 0);
    // ledger is immutable
    assert.throws(() => db.prepare("UPDATE credit_ledger SET amount=0").run(), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM credit_ledger").run(), /immutable/);
    void ws;
});

test("18 everything restores: world/assets/shots/states/references/generations via API", async () => {
    const pid = S.proj.id;
    assert.equal((await ok(S.A, "GET", `/projects/${pid}/world`)).architecture, "1960s concrete apartment block");
    assert.ok((await ok(S.A, "GET", `/projects/${pid}/assets`)).length >= 6);
    assert.ok((await ok(S.A, "GET", `/projects/${pid}/references`)).length >= 6);
    assert.ok((await ok(S.A, "GET", `/projects/${pid}/shots?sequenceId=${S.seq}`)).every((s: any) => s.state.start && s.state.result));
    assert.ok((await ok(S.A, "GET", `/generations?projectId=${pid}`)).length > 5);
    const strip = await ok(S.A, "GET", `/projects/${pid}/shot-strip`);
    assert.ok(strip.some((s: any) => s.hero) && strip.some((s: any) => s.approvedTake));
    await ok(S.A, "PUT", `/projects/${pid}/canvas`, { nodes: [{ id: "n1", kind: "shot", refId: S.shots[0].id, x: 10, y: 20 }], edges: [], viewport: { x: 0, y: 0, k: 1 } });
    assert.equal((await ok(S.A, "GET", `/projects/${pid}/canvas`)).nodes[0].x, 10);
});

test("19 admin sees jobs, cost, failure rate, ledger", async () => {
    const d = await ok(S.ADMIN, "GET", "/admin/dashboard");
    assert.ok(d.generations.total > 5 && d.providerCostUsd > 0 && d.failureRate > 0 && d.users >= 3);
    assert.ok((await ok(S.ADMIN, "GET", "/admin/jobs?status=FAILED")).length >= 1);
    const ledger = await ok(S.ADMIN, "GET", "/admin/credits/ledger");
    assert.ok(ledger.some((l: any) => l.type === "GENERATION_CHARGE") && ledger.some((l: any) => l.type === "CREDIT_GRANT"));
    const ws = (await ok(S.A, "GET", "/workspaces/current")).id;
    await ok(S.ADMIN, "POST", "/admin/credits/adjust", { workspaceId: ws, amount: 50, note: "goodwill" });
    assert.ok((await ok(S.ADMIN, "GET", "/admin/audit")).some((a: any) => a.action === "credits.adjust"));
    await ok(S.ADMIN, "PUT", "/admin/system", { maintenanceMode: false, announcement: "hello" });
    assert.equal((await ok(null, "GET", "/health")).announcement, "hello");
    const users = await ok(S.ADMIN, "GET", "/admin/users?q=bob");
    await ok(S.ADMIN, "PATCH", `/admin/users/${users[0].id}`, { status: "disabled" });
    assert.equal((await call(S.B, "GET", "/projects")).status, 401);
});

test("insufficient credits blocks generation; project lifecycle; legacy import; account deletion", async () => {
    const pid = S.proj.id;
    const ws = (await ok(S.A, "GET", "/workspaces/current")).id;
    const bal = (await ok(S.A, "GET", "/credits")).available;
    await ok(S.ADMIN, "POST", "/admin/credits/adjust", { workspaceId: ws, amount: -bal, note: "drain for test" });
    const r = await call(S.A, "POST", `/shots/${S.shots[0].id}/keyframes`, { count: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "insufficient_credits");
    await ok(S.ADMIN, "POST", "/admin/credits/adjust", { workspaceId: ws, amount: 100, note: "restore" });

    const dup = await ok(S.A, "POST", `/projects/${pid}/duplicate`);
    assert.equal((await ok(S.A, "GET", `/projects/${dup.id}/assets`)).length, (await ok(S.A, "GET", `/projects/${pid}/assets`)).length);
    assert.ok((await ok(S.A, "GET", `/projects/${dup.id}/shots`)).length >= 8);
    await ok(S.A, "PATCH", `/projects/${dup.id}`, { status: "archived" });
    assert.equal((await ok(S.A, "GET", "/projects?archived=1")).length, 1);
    await ok(S.A, "DELETE", `/projects/${dup.id}`);
    assert.equal((await ok(S.A, "GET", "/projects/trash")).length, 1);
    await ok(S.A, "POST", `/projects/${dup.id}/restore`);
    await ok(S.A, "DELETE", `/projects/${dup.id}`);
    await ok(S.A, "DELETE", `/projects/${dup.id}/permanent`);
    assert.equal((await call(S.A, "GET", `/projects/${dup.id}`)).status, 404);

    const imp = await ok(S.A, "POST", `/projects/${pid}/import-legacy-canvas`, { project: { nodes: [{ id: "a", type: "image", title: "角色: Nora", position: { x: 1, y: 2 }, width: 100, height: 100, metadata: { prompt: "a woman" } }, { id: "b", type: "text", title: "note", position: { x: 5, y: 5 }, width: 10, height: 10, metadata: { content: "hello" } }], connections: [{ id: "c", fromNodeId: "a", toNodeId: "b" }] } });
    assert.deepEqual([imp.references, imp.assets, imp.edges], [2, 1, 1]);

    await ok(S.A, "DELETE", "/auth/account", { confirm: "DELETE" });
    assert.equal((await call(S.A, "GET", "/projects")).status, 401);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((db.prepare("SELECT COUNT(*) n FROM projects WHERE workspace_id=?").get(ws) as any).n, 0, "workspace data purged");
});
