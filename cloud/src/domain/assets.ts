import { all, get, run, scoped, tx, type Scope } from "../db.ts";
import { bad, conflict, notFound, now, ulid } from "../util.ts";
import { SCHEMA_VERSION, assetInput } from "./schema.ts";
import type { z } from "zod";

type AssetIn = z.infer<typeof assetInput>;

/** 气质标签只用于检索去重，不参与生成编译，也不进入锁定语义。 */
const snapshot = (a: any) => ({ name: a.name, type: a.type, description: a.description, attributes: a.attributes, ...(a.personaTags ? { personaTags: a.personaTags } : {}), references: a.references, invariants: a.invariants, allowedVariations: a.allowedVariations, forbiddenChanges: a.forbiddenChanges });

export function createAsset(s: Scope, projectId: string, input: AssetIn, parentAssetId?: string) {
    const { type, name, ...rest } = input;
    const a = s.insert("assets", { project_id: projectId, type, name, version: 1, schema_version: SCHEMA_VERSION, approval_status: "draft", parent_asset_id: parentAssetId ?? null, data: rest });
    s.insert("asset_versions", { asset_id: a.id, version: 1, snapshot: snapshot(a), approval_status: "draft" });
    return a;
}

/** Approved assets are LOCKED: edits must go through a new variant or a new version, never in place. */
export function updateAsset(s: Scope, id: string, patch: Partial<AssetIn>) {
    const a = s.get("assets", id);
    if (!a) throw notFound("asset");
    if (a.approvalStatus === "approved") throw conflict("asset is approved and locked; create a new version or variant", "asset_locked");
    const { name, type, ...rest } = patch;
    const { id: _i, workspaceId, projectId, version, schemaVersion, approvalStatus, approvedVersion, parentAssetId, createdAt, updatedAt, deletedAt, name: n0, type: t0, ...data } = a;
    const merged = { ...data, ...rest };
    const upd = s.update("assets", id, { ...(name ? { name } : {}), data: merged });
    run("UPDATE asset_versions SET snapshot=? WHERE asset_id=? AND version=? AND workspace_id=?", JSON.stringify(snapshot(upd)), id, upd.version, s.workspaceId);
    return upd;
}

export function approveAsset(s: Scope, id: string, actor: string) {
    const a = s.get("assets", id);
    if (!a) throw notFound("asset");
    if (!a.invariants?.length) throw bad("an asset needs at least one invariant before approval (what must never change?)");
    if (a.approvalStatus === "approved" && a.approvedVersion === a.version) return a;
    return tx(() => {
        run("UPDATE asset_versions SET approval_status='approved' WHERE asset_id=? AND version=? AND workspace_id=?", id, a.version, s.workspaceId);
        const u = s.update("assets", id, { approval_status: "approved", approved_version: a.version });
        event(s, a.projectId, "asset", id, "approve", actor, String(a.version));
        return u;
    });
}

/** New version of an approved asset. The previous approved version stays approved until the new one is approved. */
export function newAssetVersion(s: Scope, id: string, patch: Partial<AssetIn>) {
    const a = s.get("assets", id);
    if (!a) throw notFound("asset");
    const next = a.version + 1;
    const { id: _i, workspaceId, projectId, version, schemaVersion, approvalStatus, approvedVersion, parentAssetId, createdAt, updatedAt, deletedAt, name, type, ...data } = a;
    const merged = { ...data, ...patch };
    const u = s.update("assets", id, { version: next, approval_status: "draft", data: merged, ...(patch.name ? { name: patch.name } : {}) });
    s.insert("asset_versions", { asset_id: id, version: next, snapshot: snapshot(u), approval_status: "draft" });
    return u;
}

/** Roll back to a previously approved version: restores that snapshot as a *new* version (history is never rewritten). */
export function rollbackAsset(s: Scope, id: string, toVersion: number, actor: string) {
    const a = s.get("assets", id);
    if (!a) throw notFound("asset");
    const v = get("SELECT * FROM asset_versions WHERE asset_id=? AND version=? AND workspace_id=?", id, toVersion, s.workspaceId);
    if (!v) throw notFound("asset version");
    if (v.approval_status !== "approved") throw bad("can only roll back to an approved version");
    const snap = JSON.parse(v.snapshot);
    const next = Math.max(...all("SELECT version FROM asset_versions WHERE asset_id=?", id).map((r) => r.version)) + 1;
    const { name, type, ...data } = snap;
    return tx(() => {
        const u = s.update("assets", id, { name, version: next, approval_status: "approved", approved_version: next, data });
        s.insert("asset_versions", { asset_id: id, version: next, snapshot: snapshot(u), approval_status: "approved" });
        event(s, a.projectId, "asset", id, "rollback", actor, `to v${toVersion} as v${next}`);
        return u;
    });
}

export function createVariant(s: Scope, id: string, name: string, patch: Partial<AssetIn>) {
    const a = s.get("assets", id);
    if (!a) throw notFound("asset");
    const { id: _i, workspaceId, projectId, version, schemaVersion, approvalStatus, approvedVersion, parentAssetId, createdAt, updatedAt, deletedAt, name: n0, type, ...data } = a;
    return createAsset(s, a.projectId, { type, name, ...data, ...patch } as AssetIn, id);
}

export const assetVersions = (s: Scope, id: string) =>
    all("SELECT version, approval_status, snapshot, created_at FROM asset_versions WHERE asset_id=? AND workspace_id=? ORDER BY version", id, s.workspaceId).map((r) => ({ version: r.version, approvalStatus: r.approval_status, createdAt: r.created_at, snapshot: JSON.parse(r.snapshot) }));

export function event(s: Scope, projectId: string, entityType: string, entityId: string, action: string, actor: string | null, reason?: string, scopeId?: string) {
    s.insert("approval_events", { project_id: projectId, entity_type: entityType, entity_id: entityId, scope_id: scopeId ?? null, action, reason: reason ?? null, actor_id: actor });
}
void now; void ulid; void scoped;
