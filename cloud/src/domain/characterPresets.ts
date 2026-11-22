import { fileURLToPath } from "node:url";
import presets from "../../assets/characterPresets/characters.json" with { type: "json" };
import { get, setting, setSetting, tx, type Scope } from "../db.ts";

const directory = import.meta.url.endsWith(".ts") ? "../../assets/characterPresets/" : "./characterPresets/";
const publicFiles = new Map(presets.map(preset => [`characterPresets/${preset.hash}`, fileURLToPath(new URL(directory + preset.file, import.meta.url))]));

export function characterPresetPath(key: string) {
  return publicFiles.get(key);
}

export function ensureCharacterPresets(s: Scope) {
  if (process.env.toonflowDesktop === "1") return;
  const key = `webCharacterPresets/${s.workspaceId}`;
  const installed = setting<string[]>(key, []);
  const missing = presets.filter(preset => !installed.includes(preset.hash));
  if (!missing.length) return;
  tx(() => {
    for (const { file, hash, name, mime, size, width, height, ...data } of missing) {
      // 升级时沿用既有收藏的 ID 与删除状态，保持旧项目引用有效。
      const existing = get(`SELECT 1 FROM library_assets l JOIN media m
        ON m.workspace_id=l.workspace_id AND m.id=json_extract(l.data,'$.authoritativeReference')
        WHERE l.workspace_id=? AND l.type='Character' AND l.name=? AND m.hash=?`, s.workspaceId, name, hash);
      if (existing) continue;
      const media = s.insert("media", { project_id: null, mime, size, width, height, hash, source: "characterPreset", storage_key: `characterPresets/${hash}` });
      s.insert("library_assets", { type: "Character", name, data: {
        ...data, authoritativeReference: media.id, referenceSnapshots: [], favorite: true,
      } });
    }
    setSetting(key, presets.map(preset => preset.hash));
  });
}
