import { z } from "zod";
import { run, tx, audit, type Scope, type Row } from "../db.ts";
import { bad, conflict, notFound } from "../util.ts";
import { assetInput, personaTagSchema, type PersonaTags } from "./schema.ts";
import { createAsset, approveAsset, event } from "./assets.ts";
import { mediaView, saveMedia, storage } from "../storage.ts";

export const librarySearchSchema = z.object({
  type: assetInput.shape.type.optional(), tags: personaTagSchema.optional(),
  q: z.string().trim().max(120).optional(), favorite: z.boolean().optional(),
  excludeName: z.string().max(120).optional(), limit: z.number().int().min(1).max(500).default(100),
});

// 演员自身的习惯可以复用，项目人物关系、配音记录和来源标记不能成为下一部作品的事实。
function reusableAttributes(attributes: Record<string, any> = {}) {
  const { importedFrom, authoritativeReference, authoritativePromotedAt, voice, voiceId, characterDirection, ...rest } = attributes;
  return { ...rest, ...(characterDirection ? { characterDirection: { speech: characterDirection.speech ?? "", behavior: characterDirection.behavior ?? "", relationships: "" } } : {}) };
}

function referenceSnapshots(s: Scope, entry: Row): Row[] {
  return entry.referenceSnapshots ?? (entry.references ?? []).map((id: string) => {
    const ref = s.get("refs", id);
    if (!ref) throw bad("原参考已不存在，请重新选择参考图后收藏");
    return { kind: ref.kind, name: ref.name, mediaId: ref.mediaId, text: ref.text };
  });
}

// 库与项目分别保存媒体副本。失败副本交给现有回收流程，不占用有效素材配额。
async function copyMedia<T>(s: Scope, ids: string[], projectId: string | null, commit: (copies: Map<string, string>) => T): Promise<T> {
  const copies = new Map<string, string>();
  try {
    for (const id of new Set(ids.filter(Boolean))) {
      const media = s.get("media", id);
      if (!media) throw notFound("reference media");
      const copy = await saveMedia(s.workspaceId, projectId, await storage.get(media.storageKey), { source: "library", duration: media.duration });
      copies.set(id, copy.id);
    }
    for (const id of copies.keys()) if (!s.get("media", id)) throw conflict("复制期间参考图已删除，请重新选择", "stale");
    return tx(() => commit(copies));
  } catch (error) {
    for (const id of copies.values()) s.update("media", id, { deleted_at: new Date().toISOString() });
    throw error;
  }
}

export function libraryContent(entry: Row | null | undefined) {
  if (!entry) return null;
  const { favorite, reuseCount, updatedAt, ...content } = entry;
  return content;
}

function unchanged(s: Scope, table: string, entry: Row) {
  const current = s.get(table, entry.id);
  const content = table === "library_assets" ? libraryContent : (value: Row | undefined) => value;
  if (JSON.stringify(content(current)) !== JSON.stringify(content(entry))) throw conflict("复制期间资产已改变，请重新读取", "stale");
}

export async function publishToLibrary(s: Scope, assetId: string, actor: string, personaTags?: PersonaTags, beforeWrite?: () => void) {
  const asset = s.get("assets", assetId);
  if (!asset) throw notFound("asset");
  const existing = s.list("library_assets", { sourceAssetId: assetId })[0];
  if (existing?.sourceVersion === asset.version) { beforeWrite?.(); return setLibraryFavorite(s, existing.id, true, actor); }
  if (asset.approvalStatus !== "approved") throw conflict("资产须先采用才能收藏到角色库", "asset_not_approved");
  const authoritative = asset.attributes?.authoritativeReference;
  if (!authoritative || !s.get("media", authoritative)?.mime.startsWith("image/")) throw bad("请先选择可用的定妆参考图", "no_authoritative_reference");
  const references = referenceSnapshots(s, asset);
  const tags = personaTags ? personaTagSchema.parse(personaTags) : asset.personaTags ?? {};
  return copyMedia(s, [authoritative, ...references.map(ref => ref.mediaId)], null, copies => {
    beforeWrite?.(); unchanged(s, "assets", asset);
    if (!s.get("projects", asset.projectId)) throw notFound("project");
    const published = s.list("library_assets", { sourceAssetId: assetId })[0];
    if (published?.sourceVersion === asset.version) {
      for (const id of copies.values()) s.softDelete("media", id);
      return setLibraryFavorite(s, published.id, true, actor);
    }
    if (existing) unchanged(s, "library_assets", existing);
    else if (published) throw conflict("复制期间角色库已改变，请重新读取", "stale");
    const values = {
      source_asset_id: asset.id, type: asset.type, name: asset.name, persona_tags: tags,
      data: {
        description: asset.description ?? "", attributes: reusableAttributes(asset.attributes), references: [],
        invariants: asset.invariants ?? [], allowedVariations: asset.allowedVariations ?? [], forbiddenChanges: asset.forbiddenChanges ?? [],
        authoritativeReference: copies.get(authoritative), sourceProjectId: asset.projectId, sourceVersion: asset.version, favorite: true,
        referenceSnapshots: references.map(ref => ({ ...ref, mediaId: ref.mediaId ? copies.get(ref.mediaId) : null })),
      },
    };
    const entry = existing ? s.update("library_assets", existing.id, values) : s.insert("library_assets", values);
    event(s, asset.projectId, "library_asset", entry.id, "publish", actor, `from asset ${asset.id}`);
    audit(actor, "library.publish", entry.id, { assetId }, s.workspaceId);
    return entry;
  });
}

export function searchLibrary(s: Scope, input: z.input<typeof librarySearchSchema> = {}) {
  const parsed = librarySearchSchema.safeParse(input);
  if (!parsed.success) throw bad("角色库筛选参数无效", parsed.error.issues);
  const query = parsed.data;
  const wanted = Object.entries(query.tags ?? {}).filter(([, value]) => value);
  return s.list("library_assets", {}, "reuse_count DESC, created_at DESC").filter(entry => {
    return (!query.type || entry.type === query.type) && (!query.excludeName || entry.name !== query.excludeName)
      && (query.favorite === undefined || Boolean(entry.favorite) === query.favorite)
      && (!query.q || `${entry.name} ${entry.description ?? ""}`.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))
      && wanted.every(([axis, value]) => entry.personaTags?.[axis] === value);
  }).slice(0, query.limit).map(entry => ({
    id: entry.id, name: entry.name, type: entry.type, personaTags: entry.personaTags ?? {}, favorite: Boolean(entry.favorite),
    reuseCount: entry.reuseCount, sourceAssetId: entry.sourceAssetId, sourceVersion: entry.sourceVersion, authoritativeReference: entry.authoritativeReference,
    description: entry.description, invariants: entry.invariants ?? [], attributes: reusableAttributes(entry.attributes),
    media: entry.authoritativeReference ? mediaView(s.get("media", entry.authoritativeReference)) : null,
    images: [...new Set([entry.authoritativeReference, ...(entry.referenceSnapshots ?? (entry.references ?? []).map((id: string) => s.get("refs", id)).filter(Boolean)).map((ref: Row) => ref.mediaId)])].filter(Boolean).map(id => s.get("media", id)).filter(media => media?.mime.startsWith("image/")).map(media => mediaView(media)), createdAt: entry.createdAt,
  }));
}

export function setLibraryFavorite(s: Scope, libraryId: string, favorite: boolean, actor: string) {
  if (!s.get("library_assets", libraryId)) throw notFound("library asset");
  run("UPDATE library_assets SET data=json_set(data,'$.favorite',json(?)), updated_at=? WHERE id=? AND workspace_id=?", JSON.stringify(favorite), new Date().toISOString(), libraryId, s.workspaceId);
  audit(actor, "library.favorite", libraryId, { favorite }, s.workspaceId);
  return s.get("library_assets", libraryId)!;
}

export function findLibraryAsset(s: Scope, entry: Row, projectId: string) {
  const source = s.get("assets", entry.sourceAssetId);
  if (source?.projectId === projectId) return source;
  return s.list("assets", { projectId }).find(asset => asset.attributes?.importedFrom === entry.id);
}

export async function importFromLibrary(s: Scope, libraryId: string, projectId: string, actor: string, overrides: { name?: string; invariants?: string[] } = {}, beforeWrite?: () => void) {
  const entry = s.get("library_assets", libraryId);
  if (!entry) throw notFound("library asset");
  if (!s.get("projects", projectId)) throw notFound("project");
  const previous = findLibraryAsset(s, entry, projectId);
  if (previous) { beforeWrite?.(); return previous; }
  const authoritative = entry.authoritativeReference;
  if (!authoritative || !s.get("media", authoritative)?.mime.startsWith("image/")) throw bad("角色库定妆图不可用，请重新设置");
  const references = referenceSnapshots(s, entry);
  return copyMedia(s, [authoritative, ...references.map(ref => ref.mediaId)], projectId, copies => {
    beforeWrite?.(); unchanged(s, "library_assets", entry);
    if (!s.get("projects", projectId)) throw notFound("project");
    const imported = findLibraryAsset(s, entry, projectId);
    if (imported) {
      for (const id of copies.values()) s.softDelete("media", id);
      return imported;
    }
    const localReferences = references.map(ref => s.insert("refs", {
      project_id: projectId, kind: ref.kind, name: ref.name, media_id: ref.mediaId ? copies.get(ref.mediaId) : null,
      text: ref.text ?? null, source: "library", source_ref: libraryId,
    }).id);
    if (!references.some(ref => ref.mediaId === authoritative)) localReferences.push(s.insert("refs", {
      project_id: projectId, kind: "image", name: entry.name, media_id: copies.get(authoritative), source: "library", source_ref: libraryId,
    }).id);
    const created = createAsset(s, projectId, assetInput.parse({
      type: entry.type, name: overrides.name ?? entry.name, description: entry.description ?? "",
      attributes: { ...reusableAttributes(entry.attributes), authoritativeReference: copies.get(authoritative), importedFrom: libraryId },
      references: localReferences, invariants: overrides.invariants ?? entry.invariants ?? [],
      allowedVariations: entry.allowedVariations ?? [], forbiddenChanges: entry.forbiddenChanges ?? [], personaTags: entry.personaTags,
    }));
    run("UPDATE library_assets SET reuse_count=reuse_count+1, updated_at=? WHERE id=? AND workspace_id=?", new Date().toISOString(), libraryId, s.workspaceId);
    event(s, projectId, "asset", created.id, "import_from_library", actor, `library ${libraryId}`);
    // 原样复用库中已采用的身份不再重复审批；改写固定特征则保留草稿。
    return created.invariants.length && overrides.invariants === undefined ? approveAsset(s, created.id, actor) : created;
  });
}

export async function updateLibraryReference(s: Scope, libraryId: string, mediaId: string, actor: string, beforeWrite?: () => void) {
  const entry = s.get("library_assets", libraryId);
  if (!entry) throw notFound("library asset");
  if (!s.get("media", mediaId)?.mime.startsWith("image/")) throw bad("权威参考须是可用图像");
  const references = referenceSnapshots(s, entry).map(ref => ref.mediaId === entry.authoritativeReference ? { ...ref, mediaId } : ref);
  return copyMedia(s, [mediaId, ...references.map(ref => ref.mediaId)], null, copies => {
    beforeWrite?.(); unchanged(s, "library_assets", entry);
    const { type, name, ...data } = assetInput.parse(entry);
    const result = s.update("library_assets", libraryId, { data: {
      ...data, attributes: reusableAttributes(data.attributes), references: [], favorite: Boolean(s.get("library_assets", libraryId)!.favorite),
      authoritativeReference: copies.get(mediaId), sourceProjectId: entry.sourceProjectId,
      referenceSnapshots: references.map(ref => ({ ...ref, mediaId: ref.mediaId ? copies.get(ref.mediaId) : null })),
    } });
    audit(actor, "library.reference", libraryId, { mediaId }, s.workspaceId);
    return result;
  });
}
