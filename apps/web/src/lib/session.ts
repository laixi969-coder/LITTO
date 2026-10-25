/** MILI MILI account session (cloud API under /cloud, HttpOnly cookie). `authDisabled` = server runs with MILIMILI_AUTH=off (single-user mode). */
export type Me = { modelAccess: { canManage: boolean; canUse: boolean }; user: { id: string; email: string; isAdmin: boolean }; workspaceId: string; role: string; workspaces: { id: string; name: string; kind: string; role: string }[] };

let me: Me | null = null;
let authDisabled = false;
let loaded = false;

export async function loadMe(force = false): Promise<Me | null> {
  if (loaded && !force) return me;
  try {
    const response = await fetch("/cloud/auth/me", { credentials: "same-origin" });
    if (response.status === 404) { authDisabled = true; me = null; }
    else me = response.ok ? await response.json() : null;
  } catch { me = null; }
  loaded = true;
  return me;
}
export const getMe = () => me;
export const isAuthDisabled = () => authDisabled;
export const canManageModels = () => authDisabled || me?.modelAccess.canManage === true;

export async function cloudRequest<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/cloud${path}`, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "x-milimili-csrf": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(data.details) ? data.details.map((item: { path: string; message: string }) => `${item.path}：${item.message}`).join("；") : "";
    throw new Error(details || data.error || `请求失败（${response.status}）`);
  }
  return data;
}
const post = (path: string, body: unknown) => cloudRequest(path, "POST", body);
export async function verifyPassword(email: string, password: string) { await post("/auth/password/login", { email, password, client: "web" }); await loadMe(true); }
export async function logout() { await post("/auth/logout", {}); me = null; location.hash = "#/login"; location.reload(); }

/** 请求绑定页面加载时的账号，其他标签页更换 Cookie 后拒绝跨账号操作并保留草稿。 */
export function registerSessionGuard() {
  const nativeFetch = window.fetch.bind(window);
  // 保留原 fetch 上的静态成员（如 preconnect），包装后的类型与 typeof fetch 一致。
  window.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const url = new URL(typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
    const applicationRequest = url.origin === location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cloud/"));
    if (applicationRequest) {
      const headers = new Headers(args[1]?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined));
      headers.set("x-milimili-csrf", "1");
      args[1] = { ...args[1], headers };
    }
    if (applicationRequest && me && (!url.pathname.startsWith("/cloud/auth/") || url.pathname === "/cloud/auth/logout")) {
      const headers = new Headers(args[1]?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined));
      headers.set("x-milimili-user", me.user.id);
      headers.set("x-workspace-id", me.workspaceId);
      args[1] = { ...args[1], headers };
    }
    // 保存失败交给调用方显示并保留输入，不能因过期会话强制刷新丢掉草稿。
    const response = await nativeFetch(...args);
    return response;
  }, window.fetch);
}
