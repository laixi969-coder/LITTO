import { Hono } from "hono";
import { z } from "zod";
import { authOf, deleteAccount, logout, requestCode, requireRole, setSessionCookie, verifyCode, verifyPassword } from "../auth.ts";
import { all, audit, get, run, scoped } from "../db.ts";
import { body, ctx, project } from "../http.ts";
import { accountOf, grant } from "../credits.ts";
import { addCredential, credentialView, listModels, listProviders, testProvider } from "../providers/registry.ts";
import { resolvePolicy, route } from "../providers/router.ts";
import { cancelJob, jobView, retryJob } from "../jobs.ts";
import { checkSignedUrl, mediaView, saveMedia, softDeleteMedia, storage, usage } from "../storage.ts";
import { bad, forbidden, notFound, now } from "../util.ts";
import { ROLES } from "../domain/schema.ts";

export const platform = new Hono();

// ---- /auth (public part is mounted in app.ts) ----
export const authPublic = new Hono();
authPublic.post("/request-code", async (c) => c.json(requestCode((await body(c, z.object({ email: z.string() }))).email)));
authPublic.post("/verify", async (c) => {
    const b = await body(c, z.object({ email: z.string(), code: z.string(), client: z.enum(["web", "api"]).default("web") }));
    const r = verifyCode(b.email, b.code);
    if (b.client === "web") setSessionCookie(c, r.token);
    return c.json({ user: r.user, ...(b.client === "api" ? { token: r.token } : {}) });
});
authPublic.post("/password/login", async (c) => {
  const b = await body(c, z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256), client: z.enum(["web", "api"]).default("web") }));
  const r = await verifyPassword(b.email, b.password);
  if (b.client === "web") setSessionCookie(c, r.token);
  return c.json({ user: r.user, ...(b.client === "api" ? { token: r.token } : {}) });
});

platform.get("/auth/me", (c) => {
    const a = authOf(c);
    const ws = all("SELECT w.id, w.name, w.kind, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? AND w.deleted_at IS NULL", a.user.id);
    return c.json({ user: a.user, workspaceId: a.workspaceId, role: a.role, workspaces: ws });
});
platform.post("/auth/logout", (c) => (logout(c), c.json({ ok: true })));
platform.delete("/auth/account", async (c) => {
    await body(c, z.object({ confirm: z.literal("DELETE") }));
    deleteAccount(authOf(c).user.id);
    return c.json({ ok: true });
});

// ---- /workspaces ----
platform.get("/workspaces/current", (c) => {
    const { a } = ctx(c);
    const w = get("SELECT * FROM workspaces WHERE id=?", a.workspaceId)!;
    const u = usage(a.workspaceId);
    return c.json({ id: w.id, name: w.name, kind: w.kind, role: a.role, credits: accountOf(a.workspaceId), storage: { ...u, quotaBytes: w.quota_bytes } });
});
platform.patch("/workspaces/current", async (c) => {
    const { a } = ctx(c, "ADMIN");
    const b = await body(c, z.object({ name: z.string().min(1).max(80) }));
    run("UPDATE workspaces SET name=?, updated_at=? WHERE id=?", b.name, now(), a.workspaceId);
    return c.json({ ok: true });
});
platform.put("/workspaces/current/model-policy", async (c) => {
    const { a } = ctx(c, "ADMIN");
    const b = await body(c, z.object({ optimize: z.enum(["quality", "cost", "latency", "balanced"]).optional(), imageModelId: z.string().nullable().optional(), videoModelId: z.string().nullable().optional(), disabledModelIds: z.array(z.string()).optional(), allowFallback: z.boolean().optional() }));
    run("INSERT INTO workspace_model_policies VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", a.workspaceId, JSON.stringify(b), now());
    return c.json({ ok: true });
});

// ---- /providers & /models (read-only for users; admin writes live under /admin) ----
platform.get("/providers", (c) => (ctx(c), c.json(listProviders().filter((p) => p.status === "active").map(({ baseUrl, ...p }) => p))));
platform.get("/models", (c) => { const { a } = ctx(c); return c.json(listModels(true).filter(m => !m.limits.workspaceExecution && (!m.limits.workspaceId || m.limits.workspaceId === a.workspaceId))); });
platform.post("/models/route-preview", async (c) => {
    const { a } = ctx(c);
    const b = await body(c, z.object({ kind: z.enum(["image", "video"]), roles: z.array(z.string()).default([]), projectId: z.string().nullable().default(null), policy: z.any().optional() }));
    return c.json(route({ kind: b.kind, workspaceId: a.workspaceId, projectId: b.projectId, roles: b.roles, policy: resolvePolicy(a.workspaceId, b.projectId, b.policy) }));
});

// ---- BYOK credentials (workspace / project scope). Plaintext is never returned or logged. ----
platform.get("/credentials", (c) => {
    const { a } = ctx(c, "ADMIN");
    return c.json(all("SELECT * FROM api_credentials WHERE workspace_id=? AND deleted_at IS NULL ORDER BY created_at", a.workspaceId).map(credentialView));
});
platform.post("/credentials", async (c) => {
    const { a, audit: au } = ctx(c, "ADMIN");
    const b = await body(c, z.object({ providerId: z.string(), secret: z.string(), label: z.string().optional(), projectId: z.string().optional() }));
    if (b.projectId && !scoped(a.workspaceId).get("projects", b.projectId)) throw notFound("project");
    const v = addCredential(b.projectId ? "project" : "workspace", a.workspaceId, b);
    au("credential.add", v.id, { providerId: b.providerId, scope: v.scope });
    return c.json(v, 201);
});
platform.patch("/credentials/:id", async (c) => {
    const { a, audit: au } = ctx(c, "ADMIN");
    const b = await body(c, z.object({ enabled: z.boolean() }));
    const r = run("UPDATE api_credentials SET enabled=?, updated_at=? WHERE id=? AND workspace_id=?", b.enabled ? 1 : 0, now(), c.req.param("id"), a.workspaceId);
    if (!r.changes) throw notFound("credential");
    au("credential.toggle", c.req.param("id"), b);
    return c.json({ ok: true });
});
platform.delete("/credentials/:id", (c) => {
    const { a, audit: au } = ctx(c, "ADMIN");
    const r = run("UPDATE api_credentials SET deleted_at=?, enabled=0, cipher='', iv='', tag='' WHERE id=? AND workspace_id=?", now(), c.req.param("id"), a.workspaceId);
    if (!r.changes) throw notFound("credential");
    au("credential.delete", c.req.param("id"));
    return c.json({ ok: true });
});
platform.post("/credentials/test", async (c) => {
    const { a } = ctx(c, "ADMIN");
    const b = await body(c, z.object({ providerId: z.string(), projectId: z.string().nullable().default(null) }));
    return c.json(await testProvider(b.providerId, a.workspaceId, b.projectId));
});

// ---- /credits ----
platform.get("/credits", (c) => {
    const { a } = ctx(c);
    return c.json({ ...accountOf(a.workspaceId), ledger: all("SELECT id,type,amount,held_delta,balance_after,job_id,note,created_at FROM credit_ledger WHERE workspace_id=? ORDER BY id DESC LIMIT 200", a.workspaceId) });
});

// ---- /generations ----
platform.get("/generations", (c) => {
    const { s } = ctx(c);
    const q = c.req.query();
    const where: Record<string, any> = {};
    if (q.projectId) where.projectId = q.projectId;
    if (q.status) where.status = q.status;
    if (q.targetId) where.targetId = q.targetId;
    return c.json(s.list("generation_jobs", where, "created_at DESC").slice(0, 200).map(jobView));
});
platform.get("/generations/:id", (c) => {
    const { s } = ctx(c);
    const j = s.get("generation_jobs", c.req.param("id"), true);
    if (!j) throw notFound("job");
    return c.json(jobView(j));
});
platform.post("/generations/:id/cancel", (c) => {
    const { a } = ctx(c, "EDITOR");
    cancelJob(a.workspaceId, c.req.param("id"), a.user.id);
    return c.json({ ok: true });
});
platform.post("/generations/:id/retry", (c) => {
    const { a } = ctx(c, "EDITOR");
    return c.json(retryJob(a.workspaceId, c.req.param("id"), a.user.id), 201);
});

// ---- /media ----
platform.post("/media", async (c) => {
    const { a, s } = ctx(c, "EDITOR");
    const projectId = c.req.query("projectId") ?? null;
    if (projectId && !s.get("projects", projectId)) throw notFound("project");
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length) throw bad("empty body");
    const m = await saveMedia(a.workspaceId, projectId, buf, { source: "upload" });
    return c.json(mediaView(m), 201);
});
platform.get("/media/:id", (c) => {
    const { s } = ctx(c);
    const m = s.get("media", c.req.param("id"));
    if (!m) throw notFound("media");
    return c.json(mediaView(m));
});
platform.delete("/media/:id", async (c) => {
    const { a } = ctx(c, "EDITOR");
    if (!scoped(a.workspaceId).get("media", c.req.param("id"))) throw notFound("media");
    await softDeleteMedia(a.workspaceId, c.req.param("id"));
    return c.json({ ok: true });
});

// ---- /projects ----
platform.get("/projects", (c) => {
    const { s } = ctx(c);
    const archived = c.req.query("archived") === "1";
    return c.json(s.list("projects", {}, "updated_at DESC").filter((p: any) => (p.status === "archived") === archived).map(({ canvas, ...p }: any) => p));
});
platform.get("/projects/trash", (c) => {
    const { a } = ctx(c);
    return c.json(all("SELECT id,name,deleted_at FROM projects WHERE workspace_id=? AND deleted_at IS NOT NULL", a.workspaceId));
});
export const PROJECT_DEFAULTS = { world: { era: "", physics: "real-world", realism: "photographic" }, look: {} };
platform.post("/projects", async (c) => {
    const { s, audit: au } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ name: z.string().min(1).max(120) }));
    const p = createProject(s, b.name);
    au("project.create", p.id);
    return c.json(p, 201);
});
export function createProject(s: ReturnType<typeof scoped>, name: string) {
    const p = s.insert("projects", { name, status: "active", updated_at: now() });
    s.insert("worlds", { project_id: p.id, data: { era: "", locationLogic: "", architecture: "", culture: "", weather: "", time: "", material: "", physics: "real-world", realism: "photographic", environmentalConstraints: [] }, updated_at: now() });
    s.insert("looks", { project_id: p.id, scope: "project", data: { contrast: "", saturation: "", palette: [], skinTone: "", blackLevel: "", highlightRolloff: "", shadowBehavior: "", grain: "", halation: "", bloom: "", lensCharacter: "", texture: "", sharpnessPhilosophy: "", colorReferenceIds: [] }, updated_at: now() });
    return p;
}
platform.get("/projects/:id", (c) => {
    const { p } = project(c, c.req.param("id"));
    return c.json(p);
});
platform.patch("/projects/:id", async (c) => {
    const { p, s } = project(c, c.req.param("id"), "EDITOR");
    const b = await body(c, z.object({ name: z.string().min(1).max(120).optional(), status: z.enum(["active", "archived"]).optional() }));
    return c.json(s.update("projects", p.id, b));
});
platform.post("/projects/:id/duplicate", async (c) => {
    const { p, s, a } = project(c, c.req.param("id"), "EDITOR");
    const { duplicateProject } = await import("../domain/project-copy.ts");
    return c.json(duplicateProject(s, p.id, `${p.name} (copy)`, a.user.id), 201);
});
platform.delete("/projects/:id", (c) => {
    const { p, s, audit: au } = project(c, c.req.param("id"), "EDITOR");
    s.softDelete("projects", p.id);
    au("project.delete", p.id);
    return c.json({ ok: true });
});
platform.post("/projects/:id/restore", (c) => {
    const { a } = ctx(c, "EDITOR");
    const r = run("UPDATE projects SET deleted_at=NULL WHERE id=? AND workspace_id=? AND deleted_at IS NOT NULL", c.req.param("id"), a.workspaceId);
    if (!r.changes) throw notFound("project in trash");
    return c.json({ ok: true });
});
platform.delete("/projects/:id/permanent", async (c) => {
    const { a } = ctx(c, "OWNER");
    const p = scoped(a.workspaceId).get("projects", c.req.param("id"), true);
    if (!p) throw notFound("project");
    if (!p.deletedAt) throw forbidden("move the project to trash first");
    const { purgeProject } = await import("../domain/project-copy.ts");
    await purgeProject(a.workspaceId, p.id);
    audit(a.user.id, "project.purge", p.id, null, a.workspaceId);
    return c.json({ ok: true });
});
void ROLES; void grant;
