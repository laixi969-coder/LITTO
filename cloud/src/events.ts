/** In-process event bus + presence for real-time collaboration. Standalone (no db import) so db.ts can publish from scoped(). */
export type ChangeEvent = { type: "change"; table: string; id: string; projectId: string | null; workspaceId: string; at: string };
export type PresenceEntry = { userId: string; email: string; color: string; shotId: string | null; assetId: string | null; cursor: unknown; at: number };
type Listener = (e: { type: "change" | "presence"; data: unknown }) => void;

export const TRACKED = new Set(["assets", "shots", "keyframes", "takes", "refs", "reference_bindings", "sequences", "scenes", "looks", "worlds", "continuity_issues", "qc_reports", "generation_jobs", "shot_states", "approval_events", "timelines", "renders", "projects"]);
const PRESENCE_TTL = 45_000;
const key = (ws: string, pid: string) => `${ws}|${pid}`;
const listeners = new Map<string, Set<Listener>>();
const presence = new Map<string, Map<string, PresenceEntry>>();

export function publishChange(table: string, id: string, workspaceId: string, projectId: string | null) {
    try {
        if (!TRACKED.has(table)) return;
        const pid = table === "projects" ? id : projectId;
        if (!pid) return;
        const set = listeners.get(key(workspaceId, pid));
        if (!set?.size) return;
        const data: ChangeEvent = { type: "change", table, id, projectId: pid, workspaceId, at: new Date().toISOString() };
        for (const l of set) { try { l({ type: "change", data }); } catch { /* a bad subscriber must not affect writers */ } }
    } catch { /* never throw into the write path */ }
}

export function subscribe(ws: string, pid: string, l: Listener) {
    const k = key(ws, pid);
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k)!.add(l);
    return () => { listeners.get(k)?.delete(l); if (!listeners.get(k)?.size) listeners.delete(k); };
}

export const colorOf = (userId: string) => { let h = 0; for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 70% 50%)`; };

export function listPresence(ws: string, pid: string): PresenceEntry[] {
    const m = presence.get(key(ws, pid));
    if (!m) return [];
    const cut = Date.now() - PRESENCE_TTL;
    for (const [u, e] of m) if (e.at < cut) m.delete(u);
    return [...m.values()];
}
const emitPresence = (ws: string, pid: string) => { const s = listeners.get(key(ws, pid)); if (s) for (const l of s) { try { l({ type: "presence", data: listPresence(ws, pid) }); } catch { /* ignore */ } } };

export function setPresence(ws: string, pid: string, user: { id: string; email: string }, p: { shotId?: string | null; assetId?: string | null; cursor?: unknown }) {
    const k = key(ws, pid);
    if (!presence.has(k)) presence.set(k, new Map());
    const prev = presence.get(k)!.get(user.id);
    const entry: PresenceEntry = { userId: user.id, email: user.email, color: colorOf(user.id), shotId: p.shotId ?? null, assetId: p.assetId ?? null, cursor: p.cursor ?? null, at: Date.now() };
    presence.get(k)!.set(user.id, entry);
    // Heartbeats with no change stay quiet; only real changes (or a new collaborator) are pushed.
    if (!prev || prev.shotId !== entry.shotId || prev.assetId !== entry.assetId) emitPresence(ws, pid);
    return listPresence(ws, pid);
}
export function removePresence(ws: string, pid: string, userId: string) {
    if (presence.get(key(ws, pid))?.delete(userId)) emitPresence(ws, pid);
}
