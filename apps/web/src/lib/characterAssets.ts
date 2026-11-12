import type { StoryProject } from "@toonflow/tool-scene-list/storyProject";
import { cloudRequest } from "@/lib/session";

export type LibraryCharacter = { id: string; name: string; description: string; favorite: boolean; media: { url: string } | null; images?: { url: string }[] };
export type CharacterSelection = { libraryId: string; actorName: string; roleName: string; imageUrl: string };

export async function importCharacters(projectId: string, selections: CharacterSelection[]) {
  const cast: NonNullable<StoryProject["brief"]["cast"]> = [];
  for (const selection of selections) {
    const asset = await cloudRequest<{ id: string; name: string }>(`/projects/${encodeURIComponent(projectId)}/library/import/${encodeURIComponent(selection.libraryId)}`, "POST", { name: selection.roleName.trim() || selection.actorName });
    cast.push({ assetId: asset.id, libraryId: selection.libraryId, actorName: selection.actorName, roleName: asset.name });
  }
  return cast;
}
