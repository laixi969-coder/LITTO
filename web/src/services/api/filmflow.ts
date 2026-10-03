// FilmFlow platform API client. Auth is an HttpOnly cookie; mutations carry a CSRF marker header.
// The browser never sees provider API keys: BYOK secrets are sent once and only masked values come back.
export const FF_BASE = import.meta.env.VITE_FILMFLOW_API || "/ff-api";

export class FFError extends Error {
    constructor(
        public status: number,
        message: string,
        public code?: string,
        public details?: any,
    ) {
        super(message);
    }
}

let workspaceId: string | null = null;
export const setWorkspace = (id: string | null) => (workspaceId = id);

export async function ff<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(FF_BASE + path, {
        method,
        credentials: "include",
        headers: { "x-filmflow-csrf": "1", ...(workspaceId ? { "x-workspace-id": workspaceId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new FFError(res.status, json.error ?? res.statusText, json.code, json.details);
    return json as T;
}
export const api = {
    get: <T = any>(p: string) => ff<T>("GET", p),
    post: <T = any>(p: string, b?: unknown, h?: Record<string, string>) => ff<T>("POST", p, b ?? {}, h),
    put: <T = any>(p: string, b?: unknown) => ff<T>("PUT", p, b ?? {}),
    patch: <T = any>(p: string, b?: unknown) => ff<T>("PATCH", p, b ?? {}),
    del: <T = any>(p: string) => ff<T>("DELETE", p),
};

export async function uploadMedia(file: Blob, projectId?: string) {
    const res = await fetch(`${FF_BASE}/media${projectId ? `?projectId=${projectId}` : ""}`, { method: "POST", credentials: "include", headers: { "x-filmflow-csrf": "1", ...(workspaceId ? { "x-workspace-id": workspaceId } : {}) }, body: file });
    const json = await res.json();
    if (!res.ok) throw new FFError(res.status, json.error);
    return json as { id: string; url: string; mime: string };
}
export const mediaSrc = (url?: string | null) => (url ? FF_BASE + url : "");
