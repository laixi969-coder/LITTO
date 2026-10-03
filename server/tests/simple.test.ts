import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ovia-test-simple-"));
Object.assign(process.env, { OVIA_DATA_DIR: dir, OVIA_QUIET: "1", OVIA_MOCK_LATENCY_MS: "20", OVIA_WORKER_POLL_MS: "30", OVIA_NO_RATELIMIT: "1", OVIA_NO_DERIVATIVES: "1", NODE_ENV: "test" });
const { app } = await import("../src/app.ts");
const { startWorker, stopWorker } = await import("../src/jobs.ts");
const { seedProviders } = await import("../src/providers/registry.ts");
seedProviders();
before(() => startWorker());
after(() => { stopWorker(); rmSync(dir, { recursive: true, force: true }); });

async function call(tok: string, m: string, p: string, b?: unknown) {
    const r = await app.request(p, { method: m, headers: { authorization: `Bearer ${tok}`, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json() as any };
}
const ok = async (t: string, m: string, p: string, b?: unknown) => { const r = await call(t, m, p, b); assert.ok(r.status < 300, `${m} ${p} ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };

test("one-step project: script + style → assets, look, world, shots, no manual fields", async () => {
    const r0 = await app.request("/auth/request-code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "easy@example.com" }) });
    const code = ((await r0.json()) as any).devCode;
    const tok = ((await (await app.request("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "easy@example.com", code, client: "api" }) })).json()) as any).token;
    const presets = await ok(tok, "GET", "/presets/looks");
    assert.ok(presets.length >= 6 && presets.every((p: any) => p.name && p.look.contrast));
    const p = await ok(tok, "POST", "/projects", { name: "easy" });
    const script = `INT. APARTMENT - NIGHT\nMara stands by the window, watching the rain. Eli enters the apartment, quiet.\nMara notices the Letter on the table. She picks up the Letter and turns it over.\nMARA: You read it, didn't you?\nELI: I had to know.\nSuddenly the lamp flickers. Mara drops the Letter and steps back.\nEXT. STREET - DAY\nEli walks out and grabs the Key from his pocket. Mara follows Eli.`;
    const r = await ok(tok, "POST", `/projects/${p.id}/bootstrap`, { script, lookPresetId: "film" });
    const names = r.assets.map((a: any) => `${a.type}:${a.name}`).sort();
    assert.deepEqual(names, ["Character:Eli", "Character:Mara", "Environment:Apartment", "Environment:Street", "Prop:Key", "Prop:Letter"]);
    assert.ok(r.shotIds.length >= 8);
    const look = (await ok(tok, "GET", `/projects/${p.id}/looks`))[0];
    assert.equal(look.grain, "visible 16mm-like");
    const world = await ok(tok, "GET", `/projects/${p.id}/world`);
    assert.equal(world.time, "night");
    assert.match(world.locationLogic, /Apartment/);
    const assets = await ok(tok, "GET", `/projects/${p.id}/assets`);
    assert.ok(assets.every((a: any) => a.approvalStatus === "approved" && a.invariants.length));
    // no high-severity blockers out of the box: a take can be approved without touching Inspector fields
    const shots = await ok(tok, "GET", `/projects/${p.id}/shots`);
    assert.equal(shots.flatMap((s: any) => s.issues).filter((i: any) => i.severity === "high").length, 0);
    const sh = shots[1];
    const g = await ok(tok, "POST", `/shots/${sh.id}/keyframes`, { count: 1 });
    for (let i = 0; i < 100; i++) { if ((await ok(tok, "GET", `/generations/${g.job.id}`)).status === "SUCCEEDED") break; await new Promise((x) => setTimeout(x, 40)); }
    const kf = (await ok(tok, "GET", `/shots/${sh.id}`)).keyframes[0];
    await ok(tok, "POST", `/keyframes/${kf.id}/promote`);
    const t = await ok(tok, "POST", `/shots/${sh.id}/takes`, { count: 1 });
    for (let i = 0; i < 100; i++) { if ((await ok(tok, "GET", `/generations/${t.jobs[0].id}`)).status === "SUCCEEDED") break; await new Promise((x) => setTimeout(x, 40)); }
    const take = (await ok(tok, "GET", `/shots/${sh.id}`)).takes[0];
    assert.equal((await ok(tok, "POST", `/takes/${take.id}/approve`, {})).status, "approved");
    // idempotent: running again does not duplicate assets
    const again = await ok(tok, "POST", `/projects/${p.id}/bootstrap`, { script });
    assert.equal(again.assets.length, 0);
    assert.equal((await call(tok, "POST", `/projects/${p.id}/bootstrap`, { lookPresetId: "nope" })).status, 400);
});
