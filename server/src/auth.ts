import { randomBytes, randomInt } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { all, audit, get, run, setting, tx } from "./db.ts";
import { config } from "./config.ts";
import { bad, forbidden, HttpError, log, now, sha256, ulid } from "./util.ts";
import { grant } from "./credits.ts";
import { purgeWorkspace } from "./storage.ts";
import { assertNotSsoEnforced } from "./sso-policy.ts";

export type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
const RANK: Record<Role, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };

export type Auth = { user: { id: string; email: string; isAdmin: boolean }; workspaceId: string; role: Role };

const CODE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 3600_000;

export function requestCode(email: string): { devCode?: string } {
    email = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("invalid email");
    assertNotSsoEnforced(email);
    const existing = get("SELECT id FROM users WHERE email=? AND deleted_at IS NULL", email);
    if (!existing && !setting("registrationOpen", true)) throw forbidden("registration closed");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    run("INSERT INTO login_codes VALUES(?,?,?,0) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0", email, sha256(email + code), new Date(Date.now() + CODE_TTL_MS).toISOString());
    // Mail transport is pluggable; without SMTP the code is printed (dev) and echoed only outside production.
    log.info(`[mail] login code for ${email}: ${config.production ? "(hidden)" : code}`);
    return config.production ? {} : { devCode: code };
}

export function verifyCode(email: string, code: string) {
    email = email.trim().toLowerCase();
    assertNotSsoEnforced(email);
    const rec = get("SELECT * FROM login_codes WHERE email=?", email);
    if (!rec || rec.expires_at < now() || rec.attempts >= 5) throw new HttpError(401, "code expired or too many attempts", "bad_code");
    if (rec.code_hash !== sha256(email + code)) {
        run("UPDATE login_codes SET attempts=attempts+1 WHERE email=?", email);
        throw new HttpError(401, "invalid code", "bad_code");
    }
    run("DELETE FROM login_codes WHERE email=?", email);
    return loginUser(email);
}

/** Shared by OTP and OAuth: find-or-create the user (+ Personal Workspace), apply pending invites, open a session. */
export function loginUser(email: string, identity?: { provider: string; subject: string }) {
    email = email.trim().toLowerCase();
    const user = tx(() => {
        let u = get("SELECT * FROM users WHERE email=?", email);
        if (u?.deleted_at) throw forbidden("account deleted");
        if (u?.status === "disabled") throw forbidden("account disabled");
        if (!u) {
            if (!setting("registrationOpen", true)) throw forbidden("registration closed");
            const id = ulid();
            const isAdmin = config.adminEmails.includes(email) ? 1 : 0;
            run("INSERT INTO users VALUES(?,?,?,?,?,?,NULL)", id, email, "active", isAdmin, now(), now());
            // Personal Workspace is created automatically (PRD §4).
            const wid = ulid();
            run("INSERT INTO workspaces(id,name,owner_id,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)", wid, `${email.split("@")[0]}'s Workspace`, id, "personal", now(), now());
            run("INSERT INTO workspace_members VALUES(?,?,?,?)", wid, id, "OWNER", now());
            run("INSERT INTO credit_accounts VALUES(?,0,0,?)", wid, now());
            run("INSERT INTO subscriptions(id,workspace_id,plan,period,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", ulid(), wid, "free", "free", "active", now(), now());
            grant(wid, setting("defaultCredits", 200), "CREDIT_GRANT", "signup grant");
            u = get("SELECT * FROM users WHERE id=?", id)!;
        }
        for (const inv of all("SELECT * FROM workspace_invites WHERE email=? AND status='pending'", email)) {
            run("INSERT OR IGNORE INTO workspace_members VALUES(?,?,?,?)", inv.workspace_id, u.id, inv.role, now());
            run("UPDATE workspace_invites SET status='accepted' WHERE id=?", inv.id);
        }
        if (identity) run("INSERT OR IGNORE INTO oauth_identities VALUES(?,?,?,?)", identity.provider, identity.subject, u.id, now());
        return u;
    });
    const token = randomBytes(32).toString("base64url");
    run("INSERT INTO sessions VALUES(?,?,?,?,?)", ulid(), user.id, sha256(token), new Date(Date.now() + SESSION_TTL_MS).toISOString(), now());
    audit(user.id, "auth.login", user.id, identity ? { via: identity.provider } : undefined);
    return { token, user: { id: user.id, email: user.email, isAdmin: !!user.is_admin } };
}

export function setSessionCookie(c: Context, token: string) {
    setCookie(c, "ff_session", token, { httpOnly: true, sameSite: "Lax", secure: config.production, path: "/", maxAge: SESSION_TTL_MS / 1000 });
}

export function logout(c: Context) {
    const t = tokenOf(c);
    if (t) run("DELETE FROM sessions WHERE token_hash=?", sha256(t));
    deleteCookie(c, "ff_session", { path: "/" });
}

function tokenOf(c: Context): string | null {
    const h = c.req.header("authorization");
    if (h?.startsWith("Bearer ")) return h.slice(7);
    return getCookie(c, "ff_session") ?? null;
}

/** Resolve session → user and the active workspace (header X-Workspace-Id, default: personal). Membership is verified server-side. */
export async function authenticate(c: Context, next: Next) {
    const bearer = c.req.header("authorization")?.startsWith("Bearer ");
    const token = tokenOf(c);
    if (!token) throw new HttpError(401, "not authenticated", "unauthenticated");
    // Cookie sessions require a custom header on mutations (CSRF defence; cross-site forms cannot set it).
    if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("x-filmflow-csrf") !== "1") throw forbidden("csrf check failed");
    const s = get("SELECT s.user_id, s.expires_at, u.email, u.is_admin, u.status, u.deleted_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?", sha256(token));
    if (!s || s.expires_at < now() || s.deleted_at || s.status !== "active") throw new HttpError(401, "session invalid", "unauthenticated");
    const wanted = c.req.header("x-workspace-id");
    const m = wanted
        ? get("SELECT m.workspace_id, m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND w.deleted_at IS NULL", wanted, s.user_id)
        : get("SELECT m.workspace_id, m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND w.deleted_at IS NULL ORDER BY w.created_at LIMIT 1", s.user_id);
    if (!m) throw forbidden("not a member of this workspace");
    c.set("auth", { user: { id: s.user_id, email: s.email, isAdmin: !!s.is_admin }, workspaceId: m.workspace_id, role: m.role } satisfies Auth);
    await next();
}

export const authOf = (c: Context): Auth => c.get("auth");

export function requireRole(c: Context, min: Role) {
    if (RANK[authOf(c).role] < RANK[min]) throw forbidden(`requires ${min}`);
}
export const requireAdmin = async (c: Context, next: Next) => {
    if (!authOf(c).user.isAdmin) throw forbidden("admin only");
    await next();
};

/** Account deletion: soft-deletes the user and queues async hard purge of owned workspaces (PRD §21). */
export function deleteAccount(userId: string) {
    const ws = all("SELECT id FROM workspaces WHERE owner_id=? AND deleted_at IS NULL", userId);
    tx(() => {
        run("UPDATE users SET deleted_at=?, status='deleted', email=email||'#deleted#'||id WHERE id=?", now(), userId);
        run("DELETE FROM sessions WHERE user_id=?", userId);
        for (const w of ws) run("UPDATE workspaces SET deleted_at=? WHERE id=?", now(), w.id);
    });
    audit(userId, "account.delete", userId, { workspaces: ws.map((w) => w.id) });
    setTimeout(() => ws.forEach((w) => purgeWorkspace(w.id)), 0);
}
