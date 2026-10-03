import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { body, project } from "../http.ts";
import { listPresence, removePresence, setPresence, subscribe } from "../events.ts";

/** Real-time collaboration: SSE change feed + presence per project (workspace-scoped; VIEWER may subscribe). */
export const collab = new Hono();

collab.get("/projects/:pid/events", (c) => {
    const { a, p } = project(c, c.req.param("pid"));
    const pid = p.id, ws = a.workspaceId, user = a.user;
    return streamSSE(c, async (stream) => {
        let pending = new Map<string, unknown>(); // coalesce duplicate (table,id) changes within ~50ms
        let timer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => { timer = null; const items = [...pending.values()]; pending = new Map(); for (const d of items) void stream.writeSSE({ event: "change", data: JSON.stringify(d) }); };
        const off = subscribe(ws, pid, (e) => {
            if (e.type === "presence") return void stream.writeSSE({ event: "presence", data: JSON.stringify(e.data) });
            const d = e.data as { table: string; id: string };
            pending.set(`${d.table}:${d.id}`, d);
            timer ??= setTimeout(flush, 50);
        });
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ presence: listPresence(ws, pid) }) });
        let closed = false;
        stream.onAbort(() => { closed = true; });
        let beats = 0;
        while (!closed) {
            await stream.sleep(1000);
            if (++beats % 15 === 0) await stream.write(": heartbeat\n\n");
        }
        off();
        if (timer) clearTimeout(timer);
        removePresence(ws, pid, user.id);
    });
});

collab.post("/projects/:pid/presence", async (c) => {
    const { a, p } = project(c, c.req.param("pid"));
    const b = await body(c, z.object({ shotId: z.string().nullable().optional(), assetId: z.string().nullable().optional(), cursor: z.any().optional() }));
    return c.json(setPresence(a.workspaceId, p.id, a.user, b));
});
collab.get("/projects/:pid/presence", (c) => { const { a, p } = project(c, c.req.param("pid")); return c.json(listPresence(a.workspaceId, p.id)); });
