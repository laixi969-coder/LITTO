import type { Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import { authOf, requireRole, type Role } from "./auth.ts";
import { scoped, audit } from "./db.ts";
import { bad, notFound } from "./util.ts";

export async function body<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { raw = {}; }
    const r = schema.safeParse(raw);
    if (!r.success) throw bad("validation failed", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return r.data;
}

/** Every handler obtains its repository from here: workspace comes from the authenticated session, never from the request body. */
export function ctx(c: Context, minRole: Role = "VIEWER") {
    requireRole(c, minRole);
    const a = authOf(c);
    return { a, s: scoped(a.workspaceId), audit: (action: string, target?: string, detail?: unknown) => audit(a.user.id, action, target, detail, a.workspaceId) };
}

export function project(c: Context, id: string, minRole: Role = "VIEWER") {
    const x = ctx(c, minRole);
    const p = x.s.get("projects", id);
    if (!p) throw notFound("project");
    return { ...x, p };
}
