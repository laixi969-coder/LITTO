import { all, get, run, tx, type Scope } from "../db.ts";
import { bad, conflict, notFound } from "../util.ts";
import { audit } from "../db.ts";
import { personaTagSchema, type PersonaTags } from "./schema.ts";
import { createAsset, event } from "./assets.ts";
import { mediaView } from "../storage.ts";

/**
 * 租户级资产库（跨项目复用）。
 *
 * 项目级资产只能保证「本项目内同脸一致」，换项目就要重新捏脸——这正是
 * AI 角色跨作品崩脸的根因。角色库把已采用且有权威参考图的资产提升到租户维度，
 * 新项目引用后即拥有同一定妆基准，复用次数越高，资产越经得起考验。
 */

const LIBRARY_TYPES = ["Character", "Wardrobe", "Environment", "Prop", "Product", "Vehicle", "Creature", "Custom"] as const;

/** 入池前必须已有权威参考图，否则等于把「未确认的脸」当成可复用资产。 */
export function publishToLibrary(s: Scope, assetId: string, actor: string, personaTags?: PersonaTags) {
    const asset = s.get("assets", assetId);
    if (!asset) throw notFound("asset");
    if (asset.approvalStatus !== "approved") throw conflict("资产须先采用才能进入角色库", "asset_not_approved");
    const authoritative = asset.attributes?.authoritativeReference;
    if (!authoritative) throw bad("该资产还没有权威参考图，请先用候选池选出定妆图再入池", "no_authoritative_reference");
    const existing = all("SELECT * FROM library_assets WHERE workspace_id=? AND source_asset_id=? AND deleted_at IS NULL", s.workspaceId, assetId)[0];
    if (existing) throw conflict("该资产已在角色库中", "already_published");
    const tags = personaTags ? personaTagSchema.parse(personaTags) : (asset.personaTags ?? {});
    return tx(() => {
        const entry = s.insert("library_assets", {
            source_asset_id: asset.id, type: asset.type, name: asset.name,
            // ACT: assets.data 会被 hydrate 摊平到顶层，因此按顶层字段取，不能再读 asset.data.xxx。
            data: {
                description: asset.description ?? "", attributes: asset.attributes ?? {}, references: asset.references ?? [],
                invariants: asset.invariants ?? [], allowedVariations: asset.allowedVariations ?? [], forbiddenChanges: asset.forbiddenChanges ?? [],
                authoritativeReference: authoritative, sourceProjectId: asset.projectId,
            },
            persona_tags: tags,
        });
        event(s, asset.projectId, "library_asset", entry.id, "publish", actor, `from asset ${asset.id}`);
        audit(actor, "library.publish", entry.id, { assetId: asset.id, type: asset.type }, s.workspaceId);
        return entry;
    });
}

/** 按类型与气质标签检索角色库；不指定标签时列出该租户全部资产。 */
export function searchLibrary(s: Scope, input: { type?: string; tags?: PersonaTags; excludeName?: string; limit?: number } = {}) {
    const rows = all("SELECT * FROM library_assets WHERE workspace_id=? AND deleted_at IS NULL ORDER BY reuse_count DESC, created_at", s.workspaceId);
    const wanted = input.tags ? Object.entries(input.tags).filter(([, v]) => v).map(([k, v]) => [k, v] as const) : [];
    return rows.filter((r: any) => {
        if (input.type && r.type !== input.type) return false;
        if (input.excludeName && r.name === input.excludeName) return false;
        const tags = JSON.parse(r.persona_tags || "{}");
        return wanted.every(([axis, pole]) => tags[axis] === pole);
    }).slice(0, input.limit ?? 50).map((r: any) => {
        const data = JSON.parse(r.data);
        return {
            id: r.id, name: r.name, type: r.type, personaTags: JSON.parse(r.persona_tags || "{}"),
            reuseCount: r.reuse_count, authoritativeReference: data.authoritativeReference, sourceAssetId: r.source_asset_id,
            description: data.description, invariants: data.invariants ?? [], attributes: data.attributes ?? {},
            references: data.references ?? [], media: mediaOf(s.workspaceId, data.authoritativeReference),
            createdAt: r.created_at,
        };
    });
}

/**
 * 引用到当前项目：复制为项目资产并继承权威参考图。
 * 复用不是共享同一条记录——项目资产仍是本项目的唯一事实来源，可独立迭代版本。
 */
export function importFromLibrary(s: Scope, libraryId: string, projectId: string, actor: string, overrides: { name?: string; invariants?: string[] } = {}) {
    const entry = s.get("library_assets", libraryId);
    if (!entry) throw notFound("library asset");
    if (!s.get("projects", projectId)) throw notFound("project");
    if (!(LIBRARY_TYPES as readonly string[]).includes(entry.type)) throw bad("资产类型不受支持");
    // ACT: library_assets.data 同样被 hydrate 摊平，资产字段位于顶层。
    const data = entry;
    const references = [...(data.references ?? [])];
    if (data.authoritativeReference && !references.includes(data.authoritativeReference)) references.push(data.authoritativeReference);
    return tx(() => {
        const created = createAsset(s, projectId, {
            type: entry.type, name: overrides.name ?? entry.name, description: data.description ?? "",
            attributes: { ...(data.attributes ?? {}), authoritativeReference: data.authoritativeReference, importedFrom: libraryId },
            references,
            invariants: overrides.invariants ?? data.invariants ?? [],
            allowedVariations: data.allowedVariations ?? [],
            forbiddenChanges: data.forbiddenChanges ?? [],
        });
        // 角色库条目里的气质标签带进项目资产，便于后续再检索与去重。
        if (entry.personaTags && Object.keys(entry.personaTags).length) {
            s.update("assets", created.id, { data: { ...stripRow(created), personaTags: entry.personaTags } });
        }
        run("UPDATE library_assets SET reuse_count=reuse_count+1, updated_at=? WHERE id=?", new Date().toISOString(), libraryId);
        event(s, projectId, "asset", created.id, "import_from_library", actor, `library ${libraryId}`);
        return s.get("assets", created.id)!;
    });
}

/** 角色库内直接迭代：给库资产追加新的权威参考图，用于角色长期演进。 */
export function updateLibraryReference(s: Scope, libraryId: string, mediaId: string, actor: string) {
    const entry = s.get("library_assets", libraryId);
    if (!entry) throw notFound("library asset");
    const media = s.get("media", mediaId);
    if (!media) throw notFound("media");
    if (media.projectId && !s.get("projects", media.projectId)) throw bad("参考图所属项目不可用");
    return tx(() => {
        const references = [...new Set([...(entry.references ?? []), mediaId])];
        s.update("library_assets", libraryId, { data: { ...entry, references, authoritativeReference: mediaId } });
        event(s, media.projectId ?? entry.source_asset_id ?? "", "library_asset", libraryId, "update_reference", actor, `media ${mediaId}`);
        return s.get("library_assets", libraryId)!;
    });
}

function mediaOf(ws: string, id: string | null) {
    if (!id) return null;
    const m = get("SELECT * FROM media WHERE id=? AND workspace_id=?", id, ws);
    return m ? mediaView({ ...m, storageKey: m.storage_key, createdAt: m.created_at }) : null;
}

/** 把资产行还原成 assetInput 形状（去掉仓储元数据）。 */
function stripRow(a: any) {
    const { id, workspaceId, projectId, version, schemaVersion, approvalStatus, approvedVersion, parentAssetId, createdAt, updatedAt, deletedAt, ...rest } = a;
    return rest;
}
