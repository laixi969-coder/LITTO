import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin, authOf } from "../auth.ts";
import { audit, get, run } from "../db.ts";
import { body, ctx } from "../http.ts";
import { runText, parseJson } from "../llm.ts";
import { allSkillsAdmin, buildContext, builtinById, catalog, checkPatch, patchesFor, publish, rateLimit, renderPrompt, sampleOutput, setInstalled, skillById, validateValue, type Manifest } from "../domain/market.ts";
import { updateAsset } from "../domain/assets.ts";
import { updateShot } from "../domain/shots.ts";
import { cropPanorama, ffmpegSync, panoramaRef } from "../domain/panorama.ts";
import { storage } from "../storage.ts";
import { bad, HttpError, notFound } from "../util.ts";

export const market = new Hono();
export const marketAdmin = new Hono();
marketAdmin.use("*", requireAdmin);

// ---- panorama perspective crop (360° → rectilinear still) ----
market.get("/references/:id/panorama-view", async (c) => {
    const { s } = ctx(c);
    const q = z.object({ yaw: z.coerce.number().min(-180).max(180).default(0), pitch: z.coerce.number().min(-90).max(90).default(0), fov: z.coerce.number().min(10).max(140).default(90), w: z.coerce.number().int().min(64).max(2048).default(1280), h: z.coerce.number().int().min(64).max(2048).default(720) }).safeParse(c.req.query());
    if (!q.success) throw bad("invalid view parameters", q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    const { media } = panoramaRef(s, c.req.param("id"));
    if (!ffmpegSync()) return c.json({ error: "ffmpeg is not installed on the server; panorama crops are unavailable", code: "unavailable" }, 501);
    const png = cropPanorama(await storage.get(media.storageKey), { yaw: q.data.yaw, pitch: q.data.pitch, fov: q.data.fov }, q.data.w, q.data.h);
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
});

// ---- catalog ----
market.get("/skills", (c) => { const { a } = ctx(c); return c.json(catalog(a.workspaceId)); });
market.get("/skills/:id", (c) => { const { a } = ctx(c); return c.json(skillById(a.workspaceId, c.req.param("id")).view); });
market.post("/skills/:id/install", (c) => { const { a, audit: au } = ctx(c, "ADMIN"); setInstalled(a.workspaceId, c.req.param("id"), true, a.user.id); au("skill.install", c.req.param("id")); return c.json({ ok: true }); });
market.delete("/skills/:id/install", (c) => { const { a, audit: au } = ctx(c, "ADMIN"); setInstalled(a.workspaceId, c.req.param("id"), false, a.user.id); au("skill.uninstall", c.req.param("id")); return c.json({ ok: true }); });

const target = z.object({ shotId: z.string().optional(), assetId: z.string().optional(), sequenceId: z.string().optional(), projectId: z.string().optional() });

function installedOrThrow(ws: string, id: string) {
    if (!get("SELECT 1 FROM skill_installs WHERE workspace_id=? AND skill_id=? AND enabled=1", ws, id)) throw new HttpError(403, "install this skill in the workspace first", "not_installed");
}

market.post("/skills/:id/run", async (c) => {
    const { a, s } = ctx(c, "EDITOR");
    const id = c.req.param("id");
    const b = await body(c, target.extend({ input: z.record(z.any()).default({}) }));
    rateLimit(a.workspaceId);
    const sk = skillById(a.workspaceId, id);

    if ("builtin" in sk && sk.builtin) {
        const bi = sk.builtin;
        if (!bi.run) throw bad(`${bi.name} has no direct run endpoint: ${bi.description}`);
        const errs = validateValue(bi.inputSchema, b.input);
        if (errs.length) throw new HttpError(422, "invalid input", "invalid_input", errs);
        const { ctx: cx } = buildContext(s, bi, b);
        const output = bi.run(b.input, cx);
        return c.json({ output, patches: bi.apply ? patchesFor(bi.apply, output) : [], builtin: true });
    }

    installedOrThrow(a.workspaceId, id);
    const m = sk.manifest as Manifest;
    const inputErrs = validateValue(m.inputSchema, b.input);
    if (inputErrs.length) throw new HttpError(422, "invalid input", "invalid_input", inputErrs);
    const { ctx: cx, projectId } = buildContext(s, m, b); // only this workspace's rows, only whitelisted fields
    const prompt = renderPrompt(m, b.input, cx);
    if (prompt.length > 8000) throw bad("rendered prompt exceeds 8000 characters");
    const r = await runText({ workspaceId: a.workspaceId, projectId, actor: a.user.id, system: m.systemPrompt, prompt, json: true, label: `skill:${m.slug}`, mockEcho: JSON.stringify(sampleOutput(m.outputSchema)) });
    if (!r) throw new HttpError(409, "no usable text model is configured", "no_text_model");
    let output: unknown;
    try { output = parseJson(r.text); } catch (e) { throw new HttpError(422, "the model reply was not valid JSON; nothing was applied", "invalid_output", [(e as Error).message]); }
    const errs = validateValue(m.outputSchema, output);
    if (errs.length) throw new HttpError(422, "the model reply does not match the skill's output schema; nothing was applied", "invalid_output", errs);
    return c.json({ output, patches: patchesFor(m.apply, output), model: r.modelId, jobId: r.jobId }); // patches are a PREVIEW; nothing is written here
});

/** Applies user-approved patches through the normal domain services, so approval locks and the core-intent confirm gate still hold. */
market.post("/skills/:id/apply", async (c) => {
    const { a, s, audit: au } = ctx(c, "EDITOR");
    const id = c.req.param("id");
    const b = await body(c, z.object({ patches: z.array(z.object({ to: z.string(), value: z.any() })).min(1).max(10), shotId: z.string().optional(), assetId: z.string().optional(), confirm: z.boolean().default(false) }));
    const sk = skillById(a.workspaceId, id);
    const allowed = new Set((("builtin" in sk && sk.builtin ? sk.builtin.apply : (sk.manifest as Manifest).apply) ?? []).map((x) => x.to));
    if (!("builtin" in sk && sk.builtin)) installedOrThrow(a.workspaceId, id);
    const patches = b.patches.map((p) => { if (!allowed.has(p.to as any)) throw bad(`this skill cannot apply to ${p.to}`); return { to: p.to, value: checkPatch(p.to, p.value) }; });
    const kinds = new Set(patches.map((p) => p.to.split(".")[0]));
    if (kinds.size !== 1) throw bad("patches must all target the same object kind");
    if (kinds.has("shot")) {
        const sh = b.shotId ? s.get("shots", b.shotId) : null;
        if (!sh) throw notFound("shot");
        const patch: any = {};
        for (const p of patches) { const f = p.to.slice(5); patch[f] = f === "action" ? p.value : { ...(sh[f] ?? {}), ...(p.value as object) }; }
        const out = updateShot(s, sh.id, patch, b.confirm);
        au("skill.apply", id, { shotId: sh.id, fields: patches.map((p) => p.to) });
        return c.json(out);
    }
    const asset = b.assetId ? s.get("assets", b.assetId) : null;
    if (!asset) throw notFound("asset");
    const patch: any = {};
    for (const p of patches) patch[p.to.slice(6)] = p.value;
    const out = updateAsset(s, asset.id, patch); // throws 409 asset_locked for approved assets
    au("skill.apply", id, { assetId: asset.id, fields: patches.map((p) => p.to) });
    return c.json(out);
});

// ---- admin: publish / manage ----
marketAdmin.get("/skills", (c) => c.json(allSkillsAdmin()));
marketAdmin.post("/skills", async (c) => {
    const b = await body(c, z.object({ manifest: z.any(), status: z.enum(["published", "draft"]).default("published") }));
    const r = publish(b.manifest, authOf(c).user.id, b.status);
    audit(authOf(c).user.id, "skill.publish", r.id, { slug: r.slug, version: r.version, status: r.status });
    return c.json({ id: r.id, slug: r.slug, version: r.version, status: r.status }, 201);
});
marketAdmin.patch("/skills/:id", async (c) => {
    const b = await body(c, z.object({ status: z.enum(["published", "draft"]) }));
    if (!run("UPDATE skills SET status=? WHERE id=?", b.status, c.req.param("id")).changes) throw notFound("skill");
    audit(authOf(c).user.id, "skill.status", c.req.param("id"), b);
    return c.json({ ok: true });
});
marketAdmin.delete("/skills/:id", (c) => {
    if (!run("DELETE FROM skills WHERE id=?", c.req.param("id")).changes) throw notFound("skill");
    run("DELETE FROM skill_installs WHERE skill_id=?", c.req.param("id"));
    audit(authOf(c).user.id, "skill.delete", c.req.param("id"));
    return c.json({ ok: true });
});
void builtinById;
