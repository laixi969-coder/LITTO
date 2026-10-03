import type { Express, NextFunction, Request, Response } from "express";
import { join } from "node:path";
import { error } from "@/lib/responseFormat";
import { authEnabled, tenantStore, type Tenant } from "@/utils/tenant";

/**
 * LITTO cloud layer (accounts, workspaces, credit ledger, admin, domain APIs) lives in /cloud and is mounted into this Express app:
 *   /cloud/*  → the cloud HTTP API (its own auth: OTP login, sessions, workspaces)
 *   /api/*    → Toonflow's engine, now behind the cloud session (tenant = the caller's workspace)
 */
type Embed = typeof import("../../../../cloud/src/embed");
let embed: Embed | null = null;
export const cloud = () => embed;

export async function mountCloud(app: Express) {
  if (!authEnabled()) return;
  // The cloud keeps its own data under data/cloud unless told otherwise.
  process.env.LITTO_DATA_DIR ??= join(process.env.TOONFLOW_DATA_DIR as string, "cloud");
  embed = await import("../../../../cloud/src/embed");
  embed.initCloud();
  // Hono handler expects a raw request stream: mount before any body parser.
  app.use("/cloud", (req, res) => void embed!.cloudRequestListener(req, res));
}

function tenantOf(req: Request): Tenant | null {
  const auth = embed!.resolveSession(embed!.tokenFromHeaders({ authorization: req.get("authorization"), cookie: req.get("cookie") }), req.get("x-workspace-id"));
  return auth && { userId: auth.user.id, email: auth.user.email, isAdmin: auth.user.isAdmin, workspaceId: auth.workspaceId, role: auth.role };
}

/** Everything under /api needs a valid cloud session; the request then runs inside the caller's tenant context. */
export function requireSession(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled() || !embed) return next();
  let tenant: Tenant | null;
  try { tenant = tenantOf(req); } catch { return res.status(403).json(error("无权访问该工作区", null, 403)); }
  if (!tenant) return res.status(401).json(error("请先登录", null, 401));
  (req as Request & { tenant?: Tenant }).tenant = tenant;
  tenantStore.run(tenant, next);
}

/** Routes that install or execute third-party code, or mutate platform-wide assets, are for platform admins only. */
const ADMIN_ONLY = /^\/(nodes|tools|providers|plugins|agents|skills)\/(?!get|list|read|models|test|files|renderers|client|export)/;
export function requireAdminForPlugins(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled() || req.method === "GET" || req.method === "HEAD") return next();
  const tenant = (req as Request & { tenant?: Tenant }).tenant;
  if (ADMIN_ONLY.test(req.path) && !tenant?.isAdmin) return res.status(403).json(error("仅平台管理员可以安装或修改插件与供应商", null, 403));
  next();
}
