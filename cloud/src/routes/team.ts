import { Hono } from "hono";
import { z } from "zod";
import { authOf, requireRole, type Role } from "../auth.ts";
import { all, audit, get, run, tx } from "../db.ts";
import { body, ctx } from "../http.ts";
import { grant } from "../credits.ts";
import { setting } from "../db.ts";
import { bad, conflict, forbidden, notFound, now, ulid } from "../util.ts";

/** P2: team workspaces + full RBAC. Roles: OWNER > ADMIN > EDITOR > VIEWER (enforced server-side by requireRole in every handler). */
export const team = new Hono();
const ASSIGNABLE = z.enum(["ADMIN", "EDITOR", "VIEWER"]);

team.post("/workspaces", async (c) => {
    const a = authOf(c);
    const b = await body(c, z.object({ name: z.string().min(1).max(80) }));
    const id = ulid();
    tx(() => {
        run("INSERT INTO workspaces(id,name,owner_id,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, b.name, a.user.id, "team", now(), now());
        run("INSERT INTO workspace_members VALUES(?,?,?,?)", id, a.user.id, "OWNER", now());
        run("INSERT INTO credit_accounts VALUES(?,0,0,?)", id, now());
        run("INSERT INTO subscriptions(id,workspace_id,plan,period,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", ulid(), id, "free", "free", "active", now(), now());
        grant(id, setting("defaultCredits", 200), "CREDIT_GRANT", "team workspace grant");
    });
    audit(a.user.id, "workspace.create", id, { name: b.name }, id);
    return c.json({ id, name: b.name, kind: "team", role: "OWNER" }, 201);
});

team.get("/workspaces/current/members", (c) => {
    const { a } = ctx(c);
    const members = all("SELECT u.id, u.email, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.deleted_at IS NULL ORDER BY m.created_at", a.workspaceId);
    const invites = a.role === "OWNER" || a.role === "ADMIN" ? all("SELECT id, email, role, status, created_at FROM workspace_invites WHERE workspace_id=? AND status='pending'", a.workspaceId) : [];
    return c.json({ members, invites });
});

team.post("/workspaces/current/members", async (c) => {
    const { a, audit: au } = ctx(c, "ADMIN");
    const w = get("SELECT kind FROM workspaces WHERE id=?", a.workspaceId)!;
    if (w.kind === "personal") throw bad("personal workspaces cannot have members; create a team workspace");
    const b = await body(c, z.object({ email: z.string().email(), role: ASSIGNABLE.default("EDITOR") }));
    const email = b.email.toLowerCase();
    if (a.role === "ADMIN" && b.role === "ADMIN") throw forbidden("only the owner can add admins");
    const u = get("SELECT id FROM users WHERE email=? AND deleted_at IS NULL", email);
    if (u) {
        if (get("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?", a.workspaceId, u.id)) throw conflict("already a member");
        run("INSERT INTO workspace_members VALUES(?,?,?,?)", a.workspaceId, u.id, b.role, now());
        au("member.add", u.id, { role: b.role });
        return c.json({ status: "added", email, role: b.role }, 201);
    }
    // Unknown email: invitation is applied on their first login.
    run("INSERT INTO workspace_invites VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,email) DO UPDATE SET role=excluded.role, status='pending'", ulid(), a.workspaceId, email, b.role, a.user.id, "pending", now());
    au("member.invite", email, { role: b.role });
    return c.json({ status: "invited", email, role: b.role }, 201);
});

const targetMember = (c: any, minRole: Role) => {
    const { a, audit: au } = ctx(c, minRole);
    const m = get("SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?", a.workspaceId, c.req.param("userId"));
    if (!m) throw notFound("member");
    return { a, au, m };
};
team.patch("/workspaces/current/members/:userId", async (c) => {
    const { a, au, m } = targetMember(c, "ADMIN");
    const b = await body(c, z.object({ role: ASSIGNABLE }));
    if (m.role === "OWNER") throw forbidden("the owner's role cannot be changed");
    if (a.role === "ADMIN" && (m.role === "ADMIN" || b.role === "ADMIN")) throw forbidden("only the owner can manage admins");
    run("UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?", b.role, a.workspaceId, m.user_id);
    au("member.role", m.user_id, b);
    return c.json({ ok: true });
});
team.delete("/workspaces/current/members/:userId", (c) => {
    const { a, au, m } = targetMember(c, "ADMIN");
    if (m.role === "OWNER") throw forbidden("the owner cannot be removed");
    if (a.role === "ADMIN" && m.role === "ADMIN") throw forbidden("only the owner can remove admins");
    run("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?", a.workspaceId, m.user_id);
    au("member.remove", m.user_id);
    return c.json({ ok: true });
});
team.delete("/workspaces/current/invites/:id", (c) => {
    const { a } = ctx(c, "ADMIN");
    run("DELETE FROM workspace_invites WHERE id=? AND workspace_id=?", c.req.param("id"), a.workspaceId);
    return c.json({ ok: true });
});
team.post("/workspaces/current/leave", (c) => {
    const { a } = ctx(c);
    if (a.role === "OWNER") throw conflict("the owner cannot leave; delete the workspace or transfer ownership");
    run("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?", a.workspaceId, a.user.id);
    return c.json({ ok: true });
});
team.post("/workspaces/current/transfer", async (c) => {
    const { a, audit: au } = ctx(c, "OWNER");
    const b = await body(c, z.object({ userId: z.string() }));
    if (!get("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?", a.workspaceId, b.userId)) throw notFound("member");
    tx(() => {
        run("UPDATE workspace_members SET role='ADMIN' WHERE workspace_id=? AND user_id=?", a.workspaceId, a.user.id);
        run("UPDATE workspace_members SET role='OWNER' WHERE workspace_id=? AND user_id=?", a.workspaceId, b.userId);
        run("UPDATE workspaces SET owner_id=? WHERE id=?", b.userId, a.workspaceId);
    });
    au("workspace.transfer", b.userId);
    return c.json({ ok: true });
});
team.delete("/workspaces/current", async (c) => {
    const { a, audit: au } = ctx(c, "OWNER");
    const w = get("SELECT kind FROM workspaces WHERE id=?", a.workspaceId)!;
    if (w.kind === "personal") throw bad("delete your account to remove a personal workspace");
    await body(c, z.object({ confirm: z.literal("DELETE") }));
    run("UPDATE workspaces SET deleted_at=? WHERE id=?", now(), a.workspaceId);
    au("workspace.delete", a.workspaceId);
    const { purgeWorkspace } = await import("../storage.ts");
    setTimeout(() => void purgeWorkspace(a.workspaceId), 0); // async thorough cleanup
    return c.json({ ok: true });
});
void requireRole;
