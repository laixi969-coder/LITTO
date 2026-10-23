import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { all, audit, get, run, setting, tx } from "./db.ts";
import { config } from "./config.ts";
import { bad, forbidden, HttpError, now, sha256, ulid } from "./util.ts";
import { grant } from "./credits.ts";
import { purgeWorkspace } from "./storage.ts";
import { assertNotSsoEnforced } from "./sso-policy.ts";

export type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
const RANK: Record<Role, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };

export type Auth = { user: { id: string; email: string; isAdmin: boolean }; workspaceId: string; role: Role };

const SESSION_TTL_MS = 30 * 24 * 3600_000;

function accountAllowed(email: string, isAdmin: boolean) {
  const whitelist = setting("accountWhitelist", { enabled: false, emails: [] as string[] });
  return isAdmin || !whitelist.enabled || whitelist.emails.includes(email);
}

function requireAccountAccess(email: string) {
  const user = get("SELECT is_admin FROM users WHERE email=? AND deleted_at IS NULL", email);
  if (!accountAllowed(email, !!user?.is_admin)) throw forbidden("此邮箱未在账户白名单中，请联系管理员");
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** 本机初始化或重置密码；不提供未认证的远程设置入口。 */
export async function setUserPassword(userId: string, password: string) {
  if (password.length < 12 || password.length > 256) throw bad("密码长度须为 12–256 个字符");
  const salt = randomBytes(16).toString("hex");
  const key = await derivePassword(password, salt);
  tx(() => {
    const user = get("SELECT email FROM users WHERE id=? AND status='active' AND deleted_at IS NULL", userId);
    if (!user) throw bad("账号不存在或已停用");
    run("INSERT INTO user_passwords VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash, updated_at=excluded.updated_at", userId, `scrypt:${salt}:${key.toString("hex")}`, now());
    run("DELETE FROM login_codes WHERE email=?", user.email);
    run("DELETE FROM sessions WHERE user_id=?", userId);
    audit(null, "auth.password.setLocal", userId);
  });
}

// ACT: 单进程按邮箱限制每 15 分钟 10 次尝试；多实例须改为共享存储。
const passwordAttempts = new Map<string, { count: number; expiresAt: number }>();
export async function verifyPassword(email: string, password: string) {
  email = email.trim().toLowerCase();
  assertNotSsoEnforced(email);
  requireAccountAccess(email);
  const at = Date.now();
  for (const [key, attempt] of passwordAttempts) if (attempt.expiresAt <= at) passwordAttempts.delete(key);
  const attempt = passwordAttempts.get(email) ?? { count: 0, expiresAt: at + 15 * 60_000 };
  if (attempt.count >= 10 || passwordAttempts.size >= 10_000 && !passwordAttempts.has(email)) {
    throw new HttpError(429, "登录尝试过多，请 15 分钟后重试", "rate_limited");
  }
  attempt.count++;
  passwordAttempts.set(email, attempt);
  const user = get("SELECT u.id, u.status, u.deleted_at, p.password_hash FROM users u LEFT JOIN user_passwords p ON p.user_id=u.id WHERE u.email=?", email);
  const hash = String(user?.password_hash ?? "");
  const validHash = /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash);
  const [, salt, expected] = validHash ? hash.split(":") : ["scrypt", "0".repeat(32), "0".repeat(128)];
  // 未设置密码的账号也执行同样的哈希计算，不暴露账号是否存在。
  const key = await derivePassword(password, salt);
  if (!timingSafeEqual(key, Buffer.from(expected, "hex")) || !validHash || user?.status !== "active" || user?.deleted_at) {
    throw new HttpError(401, "邮箱或密码不正确", "bad_credentials");
  }
  // 异步计算期间密码或账号状态可能改变，不能使用旧凭据新建会话。
  if (get("SELECT p.password_hash FROM user_passwords p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND u.email=? AND u.status='active' AND u.deleted_at IS NULL", user.id, email)?.password_hash !== hash) {
    throw new HttpError(401, "邮箱或密码不正确", "bad_credentials");
  }
  const result = loginUser(email);
  passwordAttempts.delete(email);
  return result;
}

/** Shared by password login and OAuth: find-or-create the user (+ Personal Workspace), apply pending invites, open a session. */
export function loginUser(email: string, identity?: { provider: string; subject: string }) {
    email = email.trim().toLowerCase();
    requireAccountAccess(email);
    const user = tx(() => {
        let u = get("SELECT * FROM users WHERE email=?", email);
        if (u?.deleted_at) throw forbidden("这个账号已注销");
        if (u?.status === "disabled") throw forbidden("这个账号已被停用，请联系管理员");
        if (!u) {
            if (!setting("registrationOpen", true)) throw forbidden("暂未开放新用户注册");
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
    setCookie(c, "milimili_session", token, { httpOnly: true, sameSite: "Lax", secure: config.production, path: "/", maxAge: SESSION_TTL_MS / 1000 });
}

export function logout(c: Context) {
    const t = tokenOf(c);
    if (t) run("DELETE FROM sessions WHERE token_hash=?", sha256(t));
    deleteCookie(c, "milimili_session", { path: "/" });
    deleteCookie(c, "litto_session", { path: "/" });
}

function tokenOf(c: Context): string | null {
    const h = c.req.header("authorization");
    if (h?.startsWith("Bearer ")) return h.slice(7);
    return getCookie(c, "milimili_session") ?? getCookie(c, "litto_session") ?? null;
}

/**
 * Pure session resolution (no Hono): used by the HTTP middleware below and by the MILI MILI server's Express layer.
 * Returns null when the token is missing/invalid; throws HttpError(403) when the requested workspace is not the caller's.
 */
export function resolveSession(token: string | null | undefined, wantedWorkspace?: string | null): Auth | null {
    if (!token) return null;
    const s = get("SELECT s.user_id, s.expires_at, u.email, u.is_admin, u.status, u.deleted_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?", sha256(token));
    if (!s || s.expires_at < now() || s.deleted_at || s.status !== "active") return null;
    if (!accountAllowed(s.email, !!s.is_admin)) return null;
    const m = wantedWorkspace
        ? get("SELECT m.workspace_id, m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND w.deleted_at IS NULL", wantedWorkspace, s.user_id)
        : get("SELECT m.workspace_id, m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND w.deleted_at IS NULL ORDER BY w.created_at LIMIT 1", s.user_id);
    if (!m) throw forbidden("not a member of this workspace");
    return { user: { id: s.user_id, email: s.email, isAdmin: !!s.is_admin }, workspaceId: m.workspace_id, role: m.role };
}

/** Resolve session → user and the active workspace (header X-Workspace-Id, default: personal). Membership is verified server-side. */
export async function authenticate(c: Context, next: Next) {
    const bearer = c.req.header("authorization")?.startsWith("Bearer ");
    const token = tokenOf(c);
    if (!token) throw new HttpError(401, "not authenticated", "unauthenticated");
    // Cookie sessions require a custom header on mutations (CSRF defence; cross-site forms cannot set it).
    if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("x-milimili-csrf") !== "1") throw forbidden("csrf check failed");
    const auth = resolveSession(token, c.req.header("x-workspace-id"));
    if (!auth) throw new HttpError(401, "session invalid", "unauthenticated");
    if (c.req.header("x-milimili-user") && c.req.header("x-milimili-user") !== auth.user.id) throw new HttpError(409, "账号已在其他页面切换，请重新登录原账号后保存", "account_changed");
    c.set("auth", auth);
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
