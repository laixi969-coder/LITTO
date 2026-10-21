import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

/** The authenticated caller for the current request (set by the auth middleware, read anywhere via AsyncLocalStorage). */
export type Tenant = { userId: string; email: string; isAdmin: boolean; workspaceId: string; role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" };
export const tenantStore = new AsyncLocalStorage<Tenant>();
export const currentTenant = () => tenantStore.getStore();

/** MILIMILI_AUTH=off keeps the original single-user behaviour (local desktop / quick trials). Default: on. */
export const authEnabled = () => process.env.MILIMILI_AUTH !== "off";

export const dataDir = () => process.env.TOONFLOW_DATA_DIR as string;
/** Per-workspace private area: settings.json (provider keys), workspaces/<project dirs>. */
export const tenantDir = (workspaceId: string) => join(dataDir(), "tenants", workspaceId);

export function privateDataDirectory() {
  if (!authEnabled()) return dataDir();
  const tenant = currentTenant();
  if (!tenant) throw Object.assign(new Error("缺少工作区身份，不能访问私有数据"), { status: 403 });
  return tenantDir(tenant.workspaceId);
}
/** Where projects live for the *current* caller (global data/workspaces when auth is off or outside a request). */
export function workspacesRoot() {
  const t = currentTenant();
  return t && authEnabled() ? join(tenantDir(t.workspaceId), "workspaces") : join(dataDir(), "workspaces");
}
