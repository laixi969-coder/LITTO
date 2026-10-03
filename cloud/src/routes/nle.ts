import { Hono } from "hono";
import { z } from "zod";
import { body, ctx } from "../http.ts";
import { conform, editView, getEdit, applyOps, undoRedo } from "../domain/nle.ts";
import { audioReport } from "../domain/nle-render.ts";
import { parseGrade } from "../domain/grade.ts";
import { notFound } from "../util.ts";
import { authOf } from "../auth.ts";

/** Advanced NLE + colour + sound endpoints. Everything is workspace-scoped through ctx(); mutations need EDITOR. */
export const nle = new Hono();

const view = (c: any, s: any, id: string, persist: boolean) => editView(s, getEdit(s, id, persist));
const canWrite = (c: any) => ["EDITOR", "ADMIN", "OWNER"].includes(authOf(c).role);

nle.get("/sequences/:id/edit", (c) => {
    const { s } = ctx(c);
    // a VIEWER sees the conformed timeline but never causes a write
    return c.json(view(c, s, c.req.param("id"), canWrite(c)));
});
nle.post("/sequences/:id/timeline/conform", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ reset: z.boolean().default(false) }));
    return c.json(editView(s, conform(s, c.req.param("id"), b.reset)));
});
nle.post("/sequences/:id/edit/ops", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ expectedVersion: z.number().int().optional(), ops: z.array(z.any()).min(1).max(200) }));
    return c.json(editView(s, applyOps(s, c.req.param("id"), b.ops, b.expectedVersion)));
});
nle.post("/sequences/:id/edit/undo", (c) => { const { s } = ctx(c, "EDITOR"); return c.json(editView(s, undoRedo(s, c.req.param("id"), "undo"))); });
nle.post("/sequences/:id/edit/redo", (c) => { const { s } = ctx(c, "EDITOR"); return c.json(editView(s, undoRedo(s, c.req.param("id"), "redo"))); });

// ---- colour
const stripLut = (g: any) => (g ? { ...g, lutCube: undefined, hasLut: !!g.lutCube } : null);
nle.get("/shots/:id/grade", (c) => { const { s } = ctx(c); const sh = s.get("shots", c.req.param("id")); if (!sh) throw notFound("shot"); return c.json(stripLut(sh.grade)); });
nle.put("/shots/:id/grade", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const sh = s.get("shots", c.req.param("id"));
    if (!sh) throw notFound("shot");
    const b = await body(c, z.object({ grade: z.any().nullable(), keepLut: z.boolean().default(false) }));
    let grade = b.grade === null ? null : parseGrade(b.grade);
    if (grade && !grade.lutCube && b.keepLut && sh.grade?.lutCube) grade = { ...grade, lutCube: sh.grade.lutCube };
    const { id, workspaceId, projectId, sequenceId, sceneId, ord, schemaVersion, status, heroKeyframeId, approvedTakeId, createdAt, updatedAt, deletedAt, ...data } = sh;
    s.update("shots", sh.id, { data: { ...data, grade } });
    return c.json(stripLut(grade));
});
nle.get("/sequences/:id/grade", (c) => { const { s } = ctx(c); return c.json(stripLut(getEdit(s, c.req.param("id"), false).grade)); });
nle.put("/sequences/:id/grade", async (c) => {
    const { s } = ctx(c, "EDITOR");
    const b = await body(c, z.object({ grade: z.any().nullable(), expectedVersion: z.number().int().optional(), keepLut: z.boolean().default(false) }));
    const cur = getEdit(s, c.req.param("id"), true);
    let grade = b.grade === null ? null : parseGrade(b.grade);
    if (grade && !grade.lutCube && b.keepLut && cur.grade?.lutCube) grade = { ...grade, lutCube: cur.grade.lutCube };
    const row = applyOps(s, c.req.param("id"), [{ type: "set_sequence_grade", grade }], b.expectedVersion ?? cur.version);
    return c.json(stripLut(row.grade));
});

// ---- sound
nle.get("/sequences/:id/audio-report", async (c) => { const { s } = ctx(c); if (!s.get("sequences", c.req.param("id"))) throw notFound("sequence"); return c.json(await audioReport(s, c.req.param("id"))); });
