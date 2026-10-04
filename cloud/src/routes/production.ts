import { Hono } from "hono";
import { z } from "zod";
import { all, get, run } from "../db.ts";
import { body, ctx, project } from "../http.ts";
import { ASSET_TYPES, assetInput, bindingInput, lookSchema, worldSchema, shotInput } from "../domain/schema.ts";
import { approveAsset, assetVersions, createAsset, createVariant, newAssetVersion, rollbackAsset, updateAsset } from "../domain/assets.ts";
import { bindReference, createShot, deleteShot, moveShot, shotPartial, updateShot } from "../domain/shots.ts";
import { statesOf, recomputeStates } from "../domain/state.ts";
import { checkSequence } from "../domain/continuity.ts";
import { applyRepair, OBSERVATION_KINDS, runQc } from "../domain/qc.ts";
import { approveTake, generateKeyframes, generateTakes, keyframeView, promoteHero, rollbackHero, rollbackTake, takeView } from "../domain/lifecycle.ts";
import { directorRun } from "../domain/director.ts";
import { assetDirector, cinematographer, motionDirector, visualDirector, storyboardDirector } from "../domain/skills.ts";
import { compileShot } from "../domain/compiler.ts";
import { mustRoute, resolvePolicy } from "../providers/router.ts";
import { bad, HttpError, notFound } from "../util.ts";
import { importLegacyCanvas } from "../legacy.ts";
import { mediaView } from "../storage.ts";
import { estimate } from "../jobs.ts";
import { autoObserve } from "../domain/qc-vision.ts";

export const production = new Hono();
const P = "/projects/:pid";

// ---- World / Look ----
production.get(`${P}/world`, (c) => { const { s } = project(c, c.req.param("pid")); return c.json(s.list("worlds", { projectId: c.req.param("pid") })[0]); });
production.put(`${P}/world`, async (c) => {
    const { s } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, worldSchema.partial());
    const w = s.list("worlds", { projectId: c.req.param("pid") })[0] as any;
    const { id, workspaceId, projectId, schemaVersion, createdAt, updatedAt, ...cur } = w;
    return c.json(s.update("worlds", w.id, { data: { ...cur, ...b } }));
});
production.get(`${P}/looks`, (c) => { const { s } = project(c, c.req.param("pid")); return c.json(s.list("looks", { projectId: c.req.param("pid") })); });
production.put(`${P}/looks/:scope/:scopeId?`, async (c) => {
    const { s } = project(c, c.req.param("pid"), "EDITOR");
    const scope = c.req.param("scope");
    if (!["project", "sequence", "shot"].includes(scope)) throw bad("scope must be project|sequence|shot");
    const scopeId = scope === "project" ? null : c.req.param("scopeId");
    const b = await body(c, lookSchema.partial());
    const ex = (s.list("looks", { projectId: c.req.param("pid") }) as any[]).find((l) => l.scope === scope && (l.scopeId ?? null) === scopeId);
    if (ex) { const { id, workspaceId, projectId, scope: _s, scopeId: _c, schemaVersion, createdAt, updatedAt, ...cur } = ex; return c.json(s.update("looks", ex.id, { data: { ...cur, ...b } })); }
    return c.json(s.insert("looks", { project_id: c.req.param("pid"), scope, scope_id: scopeId, data: lookSchema.parse(b) }), 201);
});

// ---- Assets ----
production.get(`${P}/assets`, (c) => { const { s } = project(c, c.req.param("pid")); return c.json(s.list("assets", { projectId: c.req.param("pid") })); });
production.post(`${P}/assets`, async (c) => {
    const { s, audit } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, assetInput);
    for (const r of b.references) if (!s.get("refs", r)) throw notFound(`reference ${r}`);
    const a = createAsset(s, c.req.param("pid"), b);
    audit("asset.create", a.id);
    return c.json(a, 201);
});
production.post(`${P}/assets/suggest`, async (c) => {
    project(c, c.req.param("pid"));
    const b = await body(c, z.object({ type: z.enum(ASSET_TYPES), name: z.string(), description: z.string().default("") }));
    return c.json(assetDirector(b.type, b.name, b.description));
});
production.get("/assets/:id", (c) => { const { s } = ctx(c); const a = s.get("assets", c.req.param("id")); if (!a) throw notFound("asset"); return c.json({ ...a, versions: assetVersions(s, a.id), bindings: s.list("reference_bindings", { targetType: "asset", targetId: a.id }) }); });
/** Optimistic concurrency: a client that sends expectedUpdatedAt loses (412 "stale") if the row changed after that timestamp. */
const fresh = (s: any, table: string, id: string, expected?: string) => {
    if (!expected) return;
    const cur = s.get(table, id);
    const at = cur?.updatedAt ?? cur?.createdAt; // rows never edited have no updatedAt yet
    if (cur && at && at > expected) throw new HttpError(412, "changed by another collaborator", "stale", { current: cur });
};
production.patch("/assets/:id", async (c) => { const { s } = ctx(c, "EDITOR"); const b = await body(c, assetInput.partial().extend({ expectedUpdatedAt: z.string().optional() })); const { expectedUpdatedAt, ...patch } = b; fresh(s, "assets", c.req.param("id"), expectedUpdatedAt ?? c.req.header("if-unmodified-since")); return c.json(updateAsset(s, c.req.param("id"), patch)); });
production.post("/assets/:id/approve", (c) => { const { s, a, audit } = ctx(c, "EDITOR"); const r = approveAsset(s, c.req.param("id"), a.user.id); audit("asset.approve", r.id); return c.json(r); });
production.post("/assets/:id/versions", async (c) => { const { s } = ctx(c, "EDITOR"); return c.json(newAssetVersion(s, c.req.param("id"), await body(c, assetInput.partial())), 201); });
production.post("/assets/:id/rollback", async (c) => { const { s, a } = ctx(c, "EDITOR"); const b = await body(c, z.object({ version: z.number().int() })); return c.json(rollbackAsset(s, c.req.param("id"), b.version, a.user.id)); });
production.post("/assets/:id/variants", async (c) => { const { s } = ctx(c, "EDITOR"); const b = await body(c, assetInput.partial().extend({ name: z.string() })); return c.json(createVariant(s, c.req.param("id"), b.name, b), 201); });
production.delete("/assets/:id", (c) => {
    const { s } = ctx(c, "EDITOR");
    const a = s.get("assets", c.req.param("id"));
    if (!a) throw notFound("asset");
    const used = s.list("shots").filter((x: any) => x.assetIds?.includes(a.id));
    if (a.approvalStatus === "approved" && c.req.query("confirm") !== "1") throw bad("deleting an approved asset needs ?confirm=1", { approved: true, usedBy: used.length });
    s.softDelete("assets", a.id);
    return c.json({ ok: true, usedByShots: used.length });
});
production.post("/assets/:id/bindings", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const a = s.get("assets", c.req.param("id"));
    if (!a) throw notFound("asset");
    return c.json(bindReference(s, a.projectId, { type: "asset", id: a.id }, await body(c, bindingInput)), 201);
});

// ---- References ----
production.get(`${P}/references`, (c) => {
    const { s } = project(c, c.req.param("pid"));
    return c.json(s.list("refs", { projectId: c.req.param("pid") }).map((r: any) => ({ ...r, media: r.mediaId ? mediaView(s.get("media", r.mediaId)) : null })));
});
production.post(`${P}/references`, async (c) => {
    const { s } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, z.object({ kind: z.enum(["image", "video", "audio", "text"]), name: z.string().optional(), mediaId: z.string().optional(), text: z.string().optional(), source: z.string().default("upload"), sourceRef: z.string().optional() }));
    if (b.mediaId && !s.get("media", b.mediaId)) throw notFound("media");
    if (b.kind === "text" ? !b.text : !b.mediaId) throw bad(b.kind === "text" ? "text required" : "mediaId required");
    return c.json(s.insert("refs", { project_id: c.req.param("pid"), kind: b.kind, name: b.name ?? null, media_id: b.mediaId ?? null, text: b.text ?? null, source: b.source, source_ref: b.sourceRef ?? null }), 201);
});
production.delete("/references/:id", (c) => { const { s } = ctx(c, "EDITOR"); if (!s.get("refs", c.req.param("id"))) throw notFound("reference"); s.softDelete("refs", c.req.param("id")); return c.json({ ok: true }); });

// ---- Sequences / Scenes ----
production.get(`${P}/sequences`, (c) => {
    const { s } = project(c, c.req.param("pid"));
    return c.json(s.list("sequences", { projectId: c.req.param("pid") }, "ord").map((q: any) => ({ ...q, scenes: s.list("scenes", { sequenceId: q.id }, "ord") })));
});
production.post(`${P}/sequences`, async (c) => {
    const { s } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, z.object({ name: z.string().min(1), script: z.string().default("") }));
    return c.json(s.insert("sequences", { project_id: c.req.param("pid"), name: b.name, script: b.script, ord: s.list("sequences", { projectId: c.req.param("pid") }).length, data: {} }), 201);
});
production.patch("/sequences/:id", async (c) => { const { s } = ctx(c, "EDITOR"); if (!s.get("sequences", c.req.param("id"))) throw notFound("sequence"); return c.json(s.update("sequences", c.req.param("id"), await body(c, z.object({ name: z.string().optional(), script: z.string().optional() })))); });
production.post(`${P}/scenes`, async (c) => {
    const { s } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, z.object({ sequenceId: z.string(), name: z.string() }));
    if (!s.get("sequences", b.sequenceId)) throw notFound("sequence");
    return c.json(s.insert("scenes", { project_id: c.req.param("pid"), sequence_id: b.sequenceId, name: b.name, ord: s.list("scenes", { sequenceId: b.sequenceId }).length, data: {} }), 201);
});

// ---- Shots ----
const withState = (s: any, sh: any) => ({ ...sh, state: statesOf(s, sh.id) });
production.get(`${P}/shots`, (c) => {
    const { s } = project(c, c.req.param("pid"));
    const seq = c.req.query("sequenceId");
    const shots = s.list("shots", { projectId: c.req.param("pid"), ...(seq ? { sequenceId: seq } : {}) }, "sequence_id, ord");
    const bindings = s.list("reference_bindings", { projectId: c.req.param("pid"), targetType: "shot" });
    return c.json(shots.map((sh: any) => ({ ...withState(s, sh), bindings: bindings.filter((b: any) => b.targetId === sh.id), heroKeyframe: sh.heroKeyframeId ? keyframeView(s.get("keyframes", sh.heroKeyframeId)) : null, approvedTake: sh.approvedTakeId ? takeView(s.get("takes", sh.approvedTakeId)) : null, issues: s.list("continuity_issues", { shotId: sh.id, status: "open" }) })));
});
production.post(`${P}/shots`, async (c) => { const { s } = project(c, c.req.param("pid"), "EDITOR"); return c.json(createShot(s, c.req.param("pid"), await body(c, shotInput)), 201); });
production.get("/shots/:id", (c) => {
    const { s } = ctx(c);
    const sh = s.get("shots", c.req.param("id"));
    if (!sh) throw notFound("shot");
    return c.json({ ...withState(s, sh), bindings: s.list("reference_bindings", { targetType: "shot", targetId: sh.id }), keyframes: s.list("keyframes", { shotId: sh.id }).map(keyframeView), takes: s.list("takes", { shotId: sh.id }).map(takeView), issues: s.list("continuity_issues", { shotId: sh.id }), qc: s.list("qc_reports", { shotId: sh.id }), repairs: s.list("repair_actions", { shotId: sh.id }) });
});
production.patch("/shots/:id", async (c) => { const { s } = ctx(c, "EDITOR"); const b = await body(c, shotPartial.extend({ confirm: z.boolean().optional(), expectedUpdatedAt: z.string().optional() })); const { confirm, expectedUpdatedAt, ...patch } = b; fresh(s, "shots", c.req.param("id"), expectedUpdatedAt ?? c.req.header("if-unmodified-since")); return c.json(updateShot(s, c.req.param("id"), patch, !!confirm)); });
production.post("/shots/:id/move", async (c) => { const { s } = ctx(c, "EDITOR"); const b = await body(c, z.object({ order: z.number().int() })); return c.json(moveShot(s, c.req.param("id"), b.order)); });
production.delete("/shots/:id", (c) => {
    const { s } = ctx(c, "EDITOR");
    const sh = s.get("shots", c.req.param("id"));
    if (!sh) throw notFound("shot");
    if ((sh.heroKeyframeId || sh.approvedTakeId) && c.req.query("confirm") !== "1") throw bad("shot has an approved Hero Frame/Take; pass ?confirm=1 to delete", { needsConfirmation: true });
    deleteShot(s, sh.id);
    return c.json({ ok: true });
});
production.post("/shots/:id/bindings", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const sh = s.get("shots", c.req.param("id"));
    if (!sh) throw notFound("shot");
    return c.json(bindReference(s, sh.projectId, { type: "shot", id: sh.id }, await body(c, bindingInput)), 201);
});
production.patch("/bindings/:id", async (c) => {
    const { s } = ctx(c, "EDITOR");
    if (!s.get("reference_bindings", c.req.param("id"))) throw notFound("binding");
    const b = await body(c, bindingInput.partial());
    return c.json(s.update("reference_bindings", c.req.param("id"), { ...(b.role && { role: b.role }), ...(b.weight !== undefined && { weight: b.weight }), ...(b.lockLevel && { lock_level: b.lockLevel }), ...(b.notes !== undefined && { notes: b.notes }) }));
});
production.delete("/bindings/:id", (c) => {
    const { s, a } = ctx(c, "EDITOR");
    const b = s.get("reference_bindings", c.req.param("id"));
    if (!b) throw notFound("binding");
    if (b.lockLevel === "LOCK" && c.req.query("confirm") !== "1") throw bad("removing a LOCK binding needs ?confirm=1", { needsConfirmation: true });
    run("DELETE FROM reference_bindings WHERE id=? AND workspace_id=?", b.id, a.workspaceId);
    return c.json({ ok: true });
});
production.post("/shots/:id/compile", async (c) => {
    const { s, a } = ctx(c);
    const sh = s.get("shots", c.req.param("id"));
    if (!sh) throw notFound("shot");
    const b = await body(c, z.object({ kind: z.enum(["image", "video"]).default("image"), modelId: z.string().optional() }));
    const roles = s.list("reference_bindings", { targetType: "shot", targetId: sh.id }).map((x: any) => x.role);
    const r = b.modelId ? null : mustRoute({ kind: b.kind, workspaceId: a.workspaceId, projectId: sh.projectId, roles: b.kind === "video" ? ["START_FRAME", ...roles] : roles, policy: resolvePolicy(a.workspaceId, sh.projectId, sh.modelOverride) });
    const modelId = b.modelId ?? r!.chosen!.modelId;
    return c.json({ modelId, routing: r, compiled: compileShot(s, sh.id, b.kind, modelId) });
});
production.post("/shots/:id/estimate", async (c) => {
    const { s, a } = ctx(c);
    const sh = s.get("shots", c.req.param("id"));
    if (!sh) throw notFound("shot");
    const b = await body(c, z.object({ kind: z.enum(["image", "video"]).default("image"), count: z.number().int().min(1).max(8).default(1) }));
    const roles = s.list("reference_bindings", { targetType: "shot", targetId: sh.id }).map((x: any) => x.role);
    const r = mustRoute({ kind: b.kind, workspaceId: a.workspaceId, projectId: sh.projectId, roles: b.kind === "video" ? ["START_FRAME", ...roles] : roles, policy: resolvePolicy(a.workspaceId, sh.projectId, sh.modelOverride) });
    const e = estimate(r.chosen!.modelId, b.kind, { count: b.kind === "image" ? b.count : 1, duration: sh.duration ?? 4 });
    return c.json({ modelId: r.chosen!.modelId, degradations: r.chosen!.degradations, perJob: e, total: { usd: e.usd === null ? null : e.usd * (b.kind === "video" ? b.count : 1), credits: e.credits * (b.kind === "video" ? b.count : 1) }, candidates: r.candidates.map((x) => ({ modelId: x.modelId, usable: x.usable, degradations: x.degradations.length })) });
});
production.post("/shots/:id/skills/plan", (c) => {
    const { s } = ctx(c);
    const sh = s.get("shots", c.req.param("id"));
    if (!sh) throw notFound("shot");
    return c.json({ cinematographer: cinematographer(sh.narrativeFunction, sh.performance?.emotion ?? "", sh.lighting?.timeOfDay === "night"), motionDirector: motionDirector(sh.action, sh.duration ?? 4), visualDirector: visualDirector(JSON.stringify(s.list("worlds", { projectId: sh.projectId })[0] ?? {})) });
});

// ---- Keyframes / Hero / Takes ----
production.post("/shots/:id/keyframes", async (c) => {
    const { s, a } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ count: z.number().int().min(1).max(8).default(3), policy: z.any().optional(), seed: z.number().optional() }));
    return c.json(generateKeyframes(s, c.req.param("id"), a.user.id, { ...b, idempotencyKey: c.req.header("idempotency-key") }), 202);
});
production.post("/keyframes/:id/promote", (c) => { const { s, a } = ctx(c, "EDITOR"); return c.json(keyframeView(promoteHero(s, c.req.param("id"), a.user.id))); });
production.post("/shots/:id/hero/rollback", async (c) => { const { s, a } = ctx(c, "EDITOR"); const b = await body(c, z.object({ keyframeId: z.string() })); return c.json(keyframeView(rollbackHero(s, c.req.param("id"), b.keyframeId, a.user.id))); });
production.post("/shots/:id/takes", async (c) => {
    const { s, a } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ count: z.number().int().min(1).max(4).default(2), keyframeId: z.string().optional(), policy: z.any().optional(), seed: z.number().optional() }));
    return c.json(generateTakes(s, c.req.param("id"), a.user.id, { ...b, idempotencyKey: c.req.header("idempotency-key") }), 202);
});
production.post("/takes/:id/approve", async (c) => {
    const { s, a } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ overrideReason: z.string().min(3).optional() }));
    return c.json(takeView(approveTake(s, c.req.param("id"), a.user.id, b.overrideReason ? { reason: b.overrideReason } : undefined)));
});
production.post("/shots/:id/take/rollback", async (c) => { const { s, a } = ctx(c, "EDITOR"); const b = await body(c, z.object({ takeId: z.string() })); return c.json(takeView(rollbackTake(s, c.req.param("id"), b.takeId, a.user.id))); });
production.get("/shots/:id/history", (c) => {
    const { a } = ctx(c);
    return c.json(all("SELECT * FROM approval_events WHERE workspace_id=? AND (scope_id=? OR entity_id=?) ORDER BY id", a.workspaceId, c.req.param("id"), c.req.param("id")));
});

// ---- Continuity & QC ----
production.post("/sequences/:id/continuity", (c) => {
    const { s } = ctx(c, "EDITOR");
    if (!s.get("sequences", c.req.param("id"))) throw notFound("sequence");
    recomputeStates(s, c.req.param("id"));
    checkSequence(s, c.req.param("id"));
    const shots = s.list("shots", { sequenceId: c.req.param("id") }, "ord");
    return c.json(shots.flatMap((sh: any) => s.list("continuity_issues", { shotId: sh.id })));
});
production.post("/continuity-issues/:id/override", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ reason: z.string().min(3) }));
    if (!s.get("continuity_issues", c.req.param("id"))) throw notFound("issue");
    return c.json(s.update("continuity_issues", c.req.param("id"), { status: "overridden", override_reason: b.reason }));
});
production.get("/qc/observation-kinds", (c) => c.json(OBSERVATION_KINDS));
production.post("/shots/:id/qc", async (c) => {
    const { s, a } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ targetType: z.enum(["keyframe", "take"]), targetId: z.string(), auto: z.boolean().default(false), visionModel: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).optional(), reviewed: z.array(z.enum(["surface", "imaging", "world", "motion", "cinematic"])).default([]), note: z.string().max(4000).optional(), observedStateDelta: z.record(z.any()).optional(), observations: z.array(z.object({ kind: z.string(), note: z.string().optional() })).default([]) }));
    const obs = [...b.observations];
    let vision: any = null;
    if (b.auto) vision = await autoObserve(s, c.req.param("id"), b.targetType, b.targetId, a.user.id, b.visionModel);
    if (vision?.observations) obs.push(...vision.observations);
    return c.json({ ...runQc(s, c.req.param("id"), { type: b.targetType, id: b.targetId }, obs, { reviewed: b.reviewed, note: b.note, actor: a.user.id, vision, observedStateDelta: b.observedStateDelta }), vision });
});
production.post("/repair-actions/:id/apply", (c) => { const { s, a } = ctx(c, "EDITOR"); return c.json(applyRepair(s, c.req.param("id"), a.user.id)); });

// ---- Director Agent ----
production.post(`${P}/director/run`, async (c) => {
    const { s, a } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, z.object({ goal: z.string().optional(), script: z.string(), sequenceId: z.string().optional(), mode: z.enum(["simple", "director"]).default("simple"), generate: z.boolean().default(false), confirm: z.boolean().default(false), replace: z.boolean().default(false), useLlm: z.boolean().default(false), minShots: z.number().int().min(1).max(60).optional() }));
    return c.json(await directorRun(s, c.req.param("pid"), a.user.id, b));
});

// ---- Canvas (layout only; semantics live in the domain tables) + legacy import ----
production.get(`${P}/canvas`, (c) => { const { p } = project(c, c.req.param("pid")); return c.json(p.canvas); });
production.put(`${P}/canvas`, async (c) => {
    const { s, p } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, z.object({ schemaVersion: z.number().default(1), nodes: z.array(z.object({ id: z.string(), kind: z.string(), refId: z.string().optional(), x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional(), collapsed: z.boolean().optional() })), edges: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), semantic: z.string().optional() })), viewport: z.object({ x: z.number(), y: z.number(), k: z.number() }) }));
    s.update("projects", p.id, { canvas: b });
    return c.json({ ok: true });
});
production.post(`${P}/import-legacy-canvas`, async (c) => {
    const { s, p } = project(c, c.req.param("pid"), "EDITOR");
    const b = await body(c, z.object({ project: z.any() }));
    return c.json(await importLegacyCanvas(s, p.id, b.project));
});

// ---- Shot strip (bottom bar) ----
production.get(`${P}/shot-strip`, (c) => {
    const { s } = project(c, c.req.param("pid"));
    const out = s.list("shots", { projectId: c.req.param("pid") }, "sequence_id, ord").map((sh: any) => {
        const hero = sh.heroKeyframeId ? s.get("keyframes", sh.heroKeyframeId) : null;
        const take = sh.approvedTakeId ? s.get("takes", sh.approvedTakeId) : null;
        const issues = s.list("continuity_issues", { shotId: sh.id, status: "open" });
        const qc = s.list("qc_reports", { shotId: sh.id }, "created_at DESC")[0];
        return { shotId: sh.id, order: sh.ord, sequenceId: sh.sequenceId, title: sh.title, status: sh.status, narrativeFunction: sh.narrativeFunction, hero: hero && keyframeView(hero), approvedTake: take && takeView(take), openIssues: issues.length, highIssues: issues.filter((i: any) => i.severity === "high").length, qcScore: qc?.score ?? null };
    });
    return c.json(out);
});
void get;

// ---- Simple mode: presets + one-step bootstrap ----
import { LOOK_PRESETS, extractEntities } from "../domain/presets.ts";
import { createShotsFromDrafts } from "../domain/shots.ts";
production.get("/presets/looks", (c) => c.json(LOOK_PRESETS));
production.post(`${P}/bootstrap`, async (c) => {
    const { s, a } = project(c, c.req.param("pid"), "EDITOR");
    const pid = c.req.param("pid");
    const b = await body(c, z.object({ script: z.string().default(""), lookPresetId: z.string().optional(), generate: z.boolean().default(false) }));
    const preset = LOOK_PRESETS.find((x) => x.id === b.lookPresetId);
    if (b.lookPresetId && !preset) throw bad("unknown look preset");
    if (preset) {
        const l = (s.list("looks", { projectId: pid }) as any[]).find((x) => x.scope === "project");
        if (l) s.update("looks", l.id, { data: { ...preset.look, colorReferenceIds: [] } });
    }
    const out: any = { look: preset?.name ?? null, assets: [], shotIds: [] };
    if (!b.script.trim()) return c.json(out);
    const ent = extractEntities(b.script);
    const w = s.list("worlds", { projectId: pid })[0] as any;
    const night = ent.environments.some((e) => e.time === "night");
    const { id: _i, workspaceId: _w, projectId: _p, schemaVersion: _s, createdAt: _c, updatedAt: _u, ...wcur } = w;
    s.update("worlds", w.id, { data: { ...wcur, locationLogic: ent.environments.map((e) => e.name).join(" / "), time: night ? "night" : "day" } });
    const existing = new Set((s.list("assets", { projectId: pid }) as any[]).map((x) => x.name.toLowerCase()));
    const made: any[] = [];
    const mk = (type: any, name: string, description = "") => {
        if (existing.has(name.toLowerCase())) return;
        const sug = assetDirector(type, name, description);
        const asset = createAsset(s, pid, { type, name, description, attributes: {}, references: [], invariants: sug.invariants, allowedVariations: sug.allowedVariations, forbiddenChanges: sug.forbiddenChanges });
        made.push(approveAsset(s, asset.id, a.user.id)); // auto-approved: users can version it later; one less step to learn
    };
    ent.characters.forEach((n) => mk("Character", n));
    ent.environments.forEach((e) => mk("Environment", e.name));
    ent.props.forEach((n) => mk("Prop", n));
    out.assets = made.map((x) => ({ id: x.id, name: x.name, type: x.type }));
    const all = s.list("assets", { projectId: pid }) as any[];
    let seq = (s.list("sequences", { projectId: pid }) as any[])[0];
    if (!seq) seq = s.insert("sequences", { project_id: pid, name: "主序列", ord: 0, script: b.script, data: {} });
    else s.update("sequences", seq.id, { script: b.script });
    const drafts = storyboardDirector(b.script, all.map((x) => ({ id: x.id, name: x.name, type: x.type })), { minShots: 8 });
    const shots = createShotsFromDrafts(s, pid, seq.id, drafts);
    out.shotIds = shots.map((x: any) => x.id);
    out.sequenceId = seq.id;
    checkSequence(s, seq.id);
    if (b.generate) out.jobs = shots.map((x: any) => generateKeyframes(s, x.id, a.user.id, { count: 2 }).job.id);
    return c.json(out);
});
