import { all, run, scoped, tx, type Scope } from "../db.ts";
import { storage } from "../storage.ts";
import { notFound, ulid } from "../util.ts";
import { createProject } from "../routes/platform.ts";
import { recomputeStates } from "./state.ts";

const strip = (o: any) => {
    const { id, workspaceId, projectId, createdAt, updatedAt, deletedAt, ...rest } = o;
    return rest;
};

/** Copies the *production definition* (world, look, assets, references, sequences, shots). Generations/takes are history and are not copied. */
export function duplicateProject(s: Scope, id: string, name: string, actor: string) {
    const src = s.get("projects", id);
    if (!src) throw notFound("project");
    return tx(() => {
        const dst = createProject(s, name);
        const w = s.list("worlds", { projectId: id })[0];
        const dw = s.list("worlds", { projectId: dst.id })[0];
        s.update("worlds", dw.id, { data: strip(w) });
        const idMap = new Map<string, string>();
        function remapAssetIds(value: any): any {
            if (typeof value === "string") return idMap.get(value) ?? value;
            if (Array.isArray(value)) return value.map(remapAssetIds);
            // ACT: 只重映射精确 ID 的键和值，不替换对白、位置说明或提示词中的文本片段。
            if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [idMap.get(key) ?? key, remapAssetIds(item)]));
            return value;
        }
        for (const l of s.list("looks", { projectId: id })) if (l.scope === "project") { const dl = s.list("looks", { projectId: dst.id })[0]; const { scope, scopeId, schemaVersion, ...d } = strip(l); s.update("looks", dl.id, { data: d }); }
        const refMap = new Map<string, string>();
        for (const r of s.list("refs", { projectId: id })) { const n = s.insert("refs", { project_id: dst.id, kind: r.kind, name: r.name, media_id: r.mediaId, text: r.text, source: r.source, source_ref: r.sourceRef }); refMap.set(r.id, n.id); }
        for (const a of s.list("assets", { projectId: id }) as any[]) {
            const { type, name: an, version, schemaVersion, approvalStatus, approvedVersion, parentAssetId, ...data } = strip(a);
            const n = s.insert("assets", { project_id: dst.id, type, name: an, version: 1, schema_version: schemaVersion, approval_status: approvalStatus, approved_version: approvalStatus === "approved" ? 1 : null, data: { ...data, references: (data.references ?? []).map((x: string) => refMap.get(x) ?? x) } });
            s.insert("asset_versions", { asset_id: n.id, version: 1, snapshot: { name: an, type, ...data }, approval_status: approvalStatus });
            idMap.set(a.id, n.id);
        }
        // 全部资产 ID 就绪后再修正服装归属等相互引用，同时保持初始版本快照一致。
        for (const assetId of idMap.values()) {
            const asset = s.get("assets", assetId)!;
            const { type, name, version, schemaVersion, approvalStatus, approvedVersion, ...data } = strip(asset);
            s.update("assets", assetId, { data: remapAssetIds(data) });
            const initial = s.list("asset_versions", { assetId })[0];
            if (initial) s.update("asset_versions", initial.id, { snapshot: { ...remapAssetIds(initial.snapshot), references: data.references } });
        }
        for (const sq of s.list("sequences", { projectId: id }, "ord") as any[]) {
            const ns = s.insert("sequences", { project_id: dst.id, name: sq.name, ord: sq.ord, script: sq.script, data: { kind: sq.kind, episodeNumber: sq.episodeNumber, storyRevisionId: sq.storyRevisionId } });
            const sceneMap = new Map<string, string>();
            for (const sc of s.list("scenes", { sequenceId: sq.id }, "ord") as any[]) sceneMap.set(sc.id, s.insert("scenes", { project_id: dst.id, sequence_id: ns.id, name: sc.name, ord: sc.ord, data: {} }).id);
            for (const sh of s.list("shots", { sequenceId: sq.id }, "ord") as any[]) {
                const { sequenceId, sceneId, ord, schemaVersion, status, heroKeyframeId, approvedTakeId, ...data } = strip(sh);
                const n = s.insert("shots", { project_id: dst.id, sequence_id: ns.id, scene_id: sceneMap.get(sh.sceneId) ?? null, ord, schema_version: schemaVersion, status: "planned", data: remapAssetIds(data) });
                idMap.set(sh.id, n.id);
                for (const b of s.list("reference_bindings", { targetType: "shot", targetId: sh.id }) as any[]) s.insert("reference_bindings", { project_id: dst.id, target_type: "shot", target_id: n.id, reference_id: refMap.get(b.referenceId) ?? b.referenceId, role: b.role, weight: b.weight, lock_level: b.lockLevel, crop: b.crop ?? null, notes: b.notes ?? null });
            }
            recomputeStates(s, ns.id);
        }
        void actor;
        return s.get("projects", dst.id)!;
    });
}

/** Permanent removal of a project and all its rows + media files. */
export async function purgeProject(workspaceId: string, projectId: string) {
    const scope = scoped(workspaceId);
    // 兼容旧库的共享媒体：删项目前把引用快照留在库中，仍被其他作品使用的文件转为租户持有。
    // 新入库/导入已经复制文件；这里只迁移旧记录，不改变已采用角色的媒体 ID。
    tx(() => {
        const retained = new Set<string>();
        for (const entry of scope.list("library_assets")) {
            const refs = entry.referenceSnapshots ?? (entry.references ?? []).map((id: string) => scope.get("refs", id)).filter(Boolean)
                .map((ref: any) => ({ kind: ref.kind, name: ref.name, mediaId: ref.mediaId, text: ref.text }));
            if (!entry.referenceSnapshots) run("UPDATE library_assets SET data=json_set(data,'$.referenceSnapshots',json(?),'$.references',json('[]')) WHERE id=? AND workspace_id=?", JSON.stringify(refs), entry.id, workspaceId);
            if (entry.authoritativeReference) retained.add(entry.authoritativeReference);
            for (const ref of refs) if (ref.mediaId) retained.add(ref.mediaId);
        }
        for (const ref of scope.list("refs")) if (ref.projectId !== projectId && ref.mediaId) retained.add(ref.mediaId);
        for (const asset of scope.list("assets")) if (asset.projectId !== projectId && asset.attributes?.authoritativeReference) retained.add(asset.attributes.authoritativeReference);
        for (const id of retained) run("UPDATE media SET project_id=NULL WHERE id=? AND workspace_id=? AND project_id=?", id, workspaceId, projectId);
    });
    for (const m of all("SELECT storage_key FROM media WHERE workspace_id=? AND project_id=?", workspaceId, projectId)) await storage.delete(m.storage_key).catch(() => {});
    const tables = all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name).filter((n) => all(`PRAGMA table_info(${n})`).some((c) => c.name === "project_id") && all(`PRAGMA table_info(${n})`).some((c) => c.name === "workspace_id"));
    tx(() => {
        // asset_versions / generation_outputs hang off parents; remove by parent id first.
        run("DELETE FROM asset_versions WHERE workspace_id=? AND asset_id IN (SELECT id FROM assets WHERE project_id=? AND workspace_id=?)", workspaceId, projectId, workspaceId);
        run("DELETE FROM generation_outputs WHERE workspace_id=? AND job_id IN (SELECT id FROM generation_jobs WHERE project_id=? AND workspace_id=?)", workspaceId, projectId, workspaceId);
        for (const t of tables) run(`DELETE FROM ${t} WHERE workspace_id=? AND project_id=?`, workspaceId, projectId);
        run("DELETE FROM projects WHERE id=? AND workspace_id=?", projectId, workspaceId);
    });
}
void scoped; void ulid;
