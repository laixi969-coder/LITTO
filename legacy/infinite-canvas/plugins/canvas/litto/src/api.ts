// LITTO API client for the plugin. Canvas nodes only store { littoProjectId, littoKind, littoId };
// every real value is read from / written to the LITTO server (domain tables are the source of truth).
const BASE = "/litto-api";

export class NeedLogin extends Error {}

export async function ff<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(BASE + path, {
        method,
        credentials: "include",
        headers: { "x-litto-csrf": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.status === 401) throw new NeedLogin("请先登录 LITTO");
    if (!res.ok) throw Object.assign(new Error(json.error ?? res.statusText), { code: json.code, details: json.details, status: res.status });
    return json as T;
}
export const get = <T = any>(p: string) => ff<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => ff<T>("POST", p, b);
export const put = <T = any>(p: string, b: unknown = {}) => ff<T>("PUT", p, b);
export const patch = <T = any>(p: string, b: unknown = {}) => ff<T>("PATCH", p, b);
export const mediaUrl = (u?: string | null) => (u ? BASE + u : "");

export async function uploadBlob(blob: Blob, projectId: string) {
    const res = await fetch(`${BASE}/media?projectId=${projectId}`, { method: "POST", credentials: "include", headers: { "x-litto-csrf": "1" }, body: blob });
    const json: any = await res.json();
    if (!res.ok) throw new Error(json.error ?? "upload failed");
    return json as { id: string };
}
