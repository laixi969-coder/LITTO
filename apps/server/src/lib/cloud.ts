import type { Express, NextFunction, Request, Response } from "express";
import { join } from "node:path";
import { rm } from "@toonflow/file";
import { error } from "@/lib/responseFormat";
import { authEnabled, tenantDir, tenantStore, type Tenant } from "@/utils/tenant";

/**
 * MILI MILI cloud layer (accounts, workspaces, credit ledger, admin, domain APIs) lives in /cloud and is mounted into this Express app:
 *   /cloud/*  → the cloud HTTP API (its own auth: OTP login, sessions, workspaces)
 *   /api/*    → Toonflow's engine, now behind the cloud session (tenant = the caller's workspace)
 */
export type { GenRequest, GenResult } from "../../../../cloud/src/embed";
type Embed = typeof import("../../../../cloud/src/embed");
let embed: Embed | null = null;
export const cloud = () => embed;
const activeRequests = new Map<string, number>();

export async function mountCloud(app: Express) {
  if (!authEnabled()) return;
  // The cloud keeps its own data under data/cloud unless told otherwise.
  // 宁可启动失败也不能静默连到 cwd 下的空库：数据目录缺失会让所有账号"消失"，表现为密码不对。
  if (!process.env.MILIMILI_DATA_DIR) {
    const root = process.env.TOONFLOW_DATA_DIR;
    if (!root) throw new Error("缺少数据目录环境变量（TOONFLOW_DATA_DIR 或 MILIMILI_DATA_DIR），拒绝以空数据库启动");
    process.env.MILIMILI_DATA_DIR = join(root, "cloud");
  }
  embed = await import("../../../../cloud/src/embed");
  const { executeMediaJob } = await import("@/utils/media/jobs");
  embed.configureWorkspaceMedia(executeMediaJob);
  const { inspectFrames } = await import("@/utils/media/vision");
  embed.configureWorkspaceVision(inspectFrames);
  embed.configureWorkspacePurge(async workspaceId => {
    const { abortDirectorySessions } = await import("@/agent/runtime/sessions");
    const directory = tenantDir(workspaceId);
    await abortDirectorySessions(directory);
    if (activeRequests.get(workspaceId)) throw new Error("等待工作区请求结束后重试清理");
    await rm(directory, { recursive: true, force: true });
  });
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
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !embed.validMutationSource({ authorization: req.get("authorization"), origin: req.get("origin"), referer: req.get("referer"), marker: req.get("x-milimili-csrf") }, `${req.protocol}://${req.get("host")}`)) {
    return res.status(403).json(error("页面来源校验失败，请从应用页面重试", null, 403));
  }
  if (req.get("x-milimili-user") && req.get("x-milimili-user") !== tenant.userId) return res.status(409).json(error("账号已在其他页面切换，当前编辑仍保留，请重新登录原账号后保存", null, 409));
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  const readOnlyPost = req.method === "POST" && (["/ai/media/estimate", "/ai/media/preflight"].includes(path)
    || path === "/ai/media/blocking" && req.body?.save === false);
  if (tenant.role === "VIEWER" && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !readOnlyPost) {
    return res.status(403).json(error("只读成员不能修改工作区或执行任务", null, 403));
  }
  (req as Request & { tenant?: Tenant }).tenant = tenant;
  const workspaceId = tenant.workspaceId;
  activeRequests.set(workspaceId, (activeRequests.get(workspaceId) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const remaining = (activeRequests.get(workspaceId) ?? 1) - 1;
    if (remaining) activeRequests.set(workspaceId, remaining); else activeRequests.delete(workspaceId);
  };
  res.once("finish", release);
  res.once("close", release);
  tenantStore.run(tenant, next);
}

/** Routes that install or execute third-party code, or mutate platform-wide assets, are for platform admins only. */
const pluginPath = /^\/(nodes|tools|providers|plugins|agents|skills)(?:\/|$)/i;
const memberProviderPath = /^\/providers\/(models|test|reenable)\/?$/i;
export function requireAdminForPlugins(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled() || req.method === "GET" || req.method === "HEAD") return next();
  const tenant = (req as Request & { tenant?: Tenant }).tenant;
  // 与 Express 的大小写匹配规则一致；普通成员仅能调用明确允许的供应商操作。
  const memberOperation = req.method === "POST" && memberProviderPath.test(req.path);
  if (pluginPath.test(req.path) && !memberOperation && !tenant?.isAdmin) return res.status(403).json(error("仅平台管理员可以安装或修改插件与供应商", null, 403));
  next();
}
