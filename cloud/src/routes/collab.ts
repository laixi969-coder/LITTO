import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { resolveSession, tokenOf } from "../auth.ts";
import { scoped } from "../db.ts";
import { body, project } from "../http.ts";
import { listPresence, removePresence, setPresence, subscribe } from "../events.ts";

/** Real-time collaboration: SSE change feed + presence per project (workspace-scoped; VIEWER may subscribe). */
export const collab = new Hono();

collab.get("/projects/:pid/events", (c) => {
    const { a, p } = project(c, c.req.param("pid"));
    const pid = p.id, ws = a.workspaceId, user = a.user;
    const token = tokenOf(c);
    return streamSSE(c, async (stream) => {
        let pending = new Map<string, unknown>();
        let timer: ReturnType<typeof setTimeout> | null = null;
        let closed = false;
        const close = () => { closed = true; pending.clear(); stream.abort(); };
        const authorized = () => {
            if (closed) return false;
            try {
                const current = resolveSession(token, ws);
                if (current?.user.id === user.id && scoped(ws).get("projects", pid)) return true;
            } catch { /* 成员移除或工作区删除后终止流。 */ }
            close();
            return false;
        };
        const send = (event: string, data: unknown) => {
            if (authorized()) void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(close);
        };
        const flush = () => {
            timer = null;
            const items = [...pending.values()];
            pending = new Map();
            for (const item of items) send("change", item);
        };
        const off = subscribe(ws, pid, (e) => {
            if (!authorized()) return;
            if (e.type === "presence") return send("presence", e.data);
            const d = e.data as { table: string; id: string };
            pending.set(`${d.table}:${d.id}`, d);
            timer ??= setTimeout(flush, 50);
        });
        stream.onAbort(() => { closed = true; });
        try {
            send("hello", { presence: listPresence(ws, pid) });
            let beats = 0;
            while (authorized()) {
                await stream.sleep(1000);
                if (++beats % 15 === 0 && authorized()) await stream.write(": heartbeat\n\n");
            }
        } finally {
            closed = true;
            off();
            if (timer) clearTimeout(timer);
            pending.clear();
            removePresence(ws, pid, user.id);
        }
    });
});

collab.post("/projects/:pid/presence", async (c) => {
    const { a, p } = project(c, c.req.param("pid"));
    const b = await body(c, z.object({ shotId: z.string().nullable().optional(), assetId: z.string().nullable().optional(), cursor: z.any().optional() }));
    return c.json(setPresence(a.workspaceId, p.id, a.user, b));
});
collab.get("/projects/:pid/presence", (c) => { const { a, p } = project(c, c.req.param("pid")); return c.json(listPresence(a.workspaceId, p.id)); });
