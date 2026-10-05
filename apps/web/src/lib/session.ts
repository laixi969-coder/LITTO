/** LITTO account session (cloud API under /cloud, HttpOnly cookie). `authDisabled` = server runs with LITTO_AUTH=off (single-user mode). */
export type Me = { user: { id: string; email: string; isAdmin: boolean }; workspaceId: string; role: string; workspaces: { id: string; name: string; kind: string; role: string }[] };

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

export async function cloudRequest<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/cloud${path}`, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "x-litto-csrf": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(data.details) ? data.details.map((item: { path: string; message: string }) => `${item.path}：${item.message}`).join("；") : "";
    throw new Error(details || data.error || `请求失败（${response.status}）`);
  }
  return data;
}
const post = (path: string, body: unknown) => cloudRequest(path, "POST", body);
export const requestCode = (email: string) => post("/auth/request-code", { email }) as Promise<{ devCode?: string }>;
export async function verifyCode(email: string, code: string) { await post("/auth/verify", { email, code, client: "web" }); await loadMe(true); }
export async function verifyPassword(email: string, password: string) { await post("/auth/password/login", { email, password, client: "web" }); await loadMe(true); }
export async function logout() { await post("/auth/logout", {}).catch(() => {}); me = null; location.hash = "#/login"; location.reload(); }

/** Any 401 from the engine API means the session ended: go back to the login page. */
export function registerSessionGuard() {
  const nativeFetch = window.fetch.bind(window);
  // 保留原 fetch 上的静态成员（如 preconnect），包装后的类型与 typeof fetch 一致。
  window.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args);
    const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
    if (response.status === 401 && url.includes("/api/") && !authDisabled) { location.hash = "#/login"; location.reload(); }
    return response;
  }, window.fetch);
}
