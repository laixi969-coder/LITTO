import { z } from "zod";
import type { Scope } from "../db.ts";
import { assetInput, bindingInput, shotInput, worldSchema, lookSchema } from "./schema.ts";
import { createAsset } from "./assets.ts";
import { bindReference, createShot, updateShot, shotPartial } from "./shots.ts";
import { bad, conflict, notFound } from "../util.ts";

/** Agent writes drafts only. Human output review and approval remain explicit UI operations. */
export function workspaceProduction(s: Scope, projectId: string, operation: string, data: Record<string, unknown>) {
  if (!s.get("projects", projectId)) throw notFound("project");
  const shots = s.list("shots", { projectId }, "sequence_id, ord");
  if (operation === "read") return {
    projectId, world: s.list("worlds", { projectId }), looks: s.list("looks", { projectId }), assets: s.list("assets", { projectId }),
    sequences: s.list("sequences", { projectId }), shots, references: s.list("refs", { projectId }), bindings: s.list("reference_bindings", { projectId }),
    keyframes: s.list("keyframes", { projectId }), takes: s.list("takes", { projectId }), qc: s.list("qc_reports", { projectId }),
  };
  if (operation === "world" || operation === "look") {
    if (shots.some(shot => shot.heroKeyframeId || shot.approvedTakeId)) throw conflict("已有采用镜头，请用户在镜头制作面板修改世界或影调", "approved_world");
    const table = operation === "world" ? "worlds" : "looks";
    const current = s.list(table, { projectId }).find(item => operation === "world" || item.scope === "project");
    if (!current) throw notFound(table);
    const schema = operation === "world" ? worldSchema : lookSchema;
    return s.update(table, current.id, { data: schema.parse({ ...current, ...data }) });
  }
  if (operation === "asset") {
    const parsed = assetInput.parse(data);
    for (const id of parsed.references) if (s.get("refs", id)?.projectId !== projectId) throw notFound("project reference");
    return createAsset(s, projectId, parsed);
  }
  if (operation === "sequence") {
    const parsed = z.object({ name: z.string().min(1).max(120), script: z.string().max(100000).default("") }).parse(data);
    return s.insert("sequences", { project_id: projectId, ...parsed, ord: s.list("sequences", { projectId }).length, data: {} });
  }
  if (operation === "shot") return createShot(s, projectId, shotInput.parse(data));
  const shot = typeof data.shotId === "string" && s.get("shots", data.shotId);
  if (!shot || shot.projectId !== projectId) throw notFound("project shot");
  if (operation === "updateShot") return updateShot(s, shot.id, shotPartial.parse(data));
  if (operation === "binding") return bindReference(s, projectId, { type: "shot", id: shot.id }, bindingInput.parse(data));
  throw bad("未知制片操作");
}
