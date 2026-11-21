import { mkdir } from "@toonflow/file";
import { dirname } from "node:path";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { workspaceProject } from "@/utils/media/jobs";

const pendingReferences = new Map<string, Promise<void>>();

function saveReference(path: string, data: Buffer) {
  const pending = pendingReferences.get(path);
  if (pending) return pending;
  const release = lockWorkspaceFiles([path]);
  const write = mkdir(dirname(path), { recursive: true }).then(() => writeWorkspaceFile(path, data)).finally(() => {
    pendingReferences.delete(path);
    release();
  });
  pendingReferences.set(path, write);
  return write;
}

export function listProjectCharacters(directory: string) {
  const api = cloud(), tenant = currentTenant();
  const projectId = workspaceProject(directory, false);
  if (!api || !tenant || !projectId) return [];
  const scope = api.scoped(tenant.workspaceId);
  const entries = scope.list("library_assets", { type: "Character" });
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const bySource = new Map(entries.filter(entry => entry.sourceAssetId).map(entry => [entry.sourceAssetId, entry]));
  return scope.list("assets", { projectId, type: "Character" }).map(asset => {
    const attributes = asset.attributes ?? {};
    const entry = byId.get(attributes.importedFrom) ?? bySource.get(asset.id);
    const media = attributes.authoritativeReference && scope.get("media", attributes.authoritativeReference);
    return { id: String(asset.id), name: String(asset.name), description: asset.description, characterDirection: attributes.characterDirection, casting: attributes.casting,
      wardrobe: typeof attributes.styling?.costume === "string" ? attributes.styling.costume : undefined, fourView: attributes.fourView === true,
      libraryId: attributes.importedFrom ?? entry?.id, actorName: attributes.libraryActorName ?? entry?.name,
      referenceMediaId: media?.projectId === projectId && media.mime.startsWith("image/") ? String(media.id) : undefined,
      approved: asset.approvalStatus === "approved" };
  });
}

export async function readProjectAsset(directory: string, input: Record<string, unknown>, signal?: AbortSignal) {
  const api = cloud(), tenant = currentTenant();
  const projectId = workspaceProject(directory, false);
  if (!api || !tenant || !projectId || tenant.role === "VIEWER") throw Object.assign(new Error("当前工作区无法读取项目制作参考"), { status: 403 });
  const { asset, images } = await api.readWorkspaceAsset(api.scoped(tenant.workspaceId), projectId, input);
  const referenceImages = [];
  for (const image of images) {
    signal?.throwIfAborted();
    const path = `assets/characters/${asset.id}/reference${image.mediaId}`;
    const target = await resolveWorkspacePath(directory, path, true);
    await saveReference(target.path, image.data);
    signal?.throwIfAborted();
    referenceImages.push({ mediaId: image.mediaId, path, mimeType: image.mimeType });
  }
  return { ...asset, referenceImages };
}

export async function readCastingReference(directory: string, assetId: string, referenceMediaId?: string) {
  const asset = await readProjectAsset(directory, { assetId });
  const images: { mediaId: string; path: string; mimeType: string }[] = asset.referenceImages;
  const reference = images.find(image => image.mediaId === referenceMediaId);
  if (asset.approvalStatus !== "approved" || !reference || asset.attributes?.authoritativeReference !== referenceMediaId)
    throw Object.assign(new Error(`「${asset.name}」缺少可用的已采用定妆图，请在项目资产中核对`), { status: 409 });
  return reference;
}
