import { readFile } from "@toonflow/file";
import { fileURLToPath } from "node:url";
import presets from "../../assets/characterPresets/characters.json" with { type: "json" };
import { superAdminEmail } from "../config.ts";
import { get, setting, setSetting, tx, type Scope } from "../db.ts";
import { saveMedia } from "../storage.ts";
import { HttpError, sha256 } from "../util.ts";

const installing = new Map<string, Promise<void>>();

async function installPresets(s: Scope, key: string, installed: string[]) {
  const directory = import.meta.url.endsWith(".ts") ? "../../assets/characterPresets/" : "./characterPresets/";
  for (const { file, hash, name, ...data } of presets) {
    if (installed.includes(hash)) continue;
    // 同一张定妆图已随本地角色收藏时，保留原角色的编号、收藏和删除状态。
    const existing = get(`SELECT 1 FROM library_assets l JOIN media m
      ON m.workspace_id=l.workspace_id AND m.id=json_extract(l.data,'$.authoritativeReference')
      WHERE l.workspace_id=? AND l.type='Character' AND l.name=? AND m.hash=?`, s.workspaceId, name, hash);
    let mediaId: string | undefined;
    if (!existing) {
      const bytes = await readFile(fileURLToPath(new URL(directory + file, import.meta.url)));
      if (sha256(bytes) !== hash) throw new Error(`预置定妆图校验失败：${file}`);
      try {
        mediaId = (await saveMedia(s.workspaceId, null, bytes, { source: "library" })).id;
      } catch (error) {
        // 空间不足时仍可打开原有角色库，下次读取时从已完成的角色继续。
        if (error instanceof HttpError && error.code === "quota_exceeded") return;
        throw error;
      }
    }
    try {
      tx(() => {
        if (mediaId) s.insert("library_assets", { type: "Character", name, data: {
          ...data, authoritativeReference: mediaId, referenceSnapshots: [], favorite: true,
        } });
        setSetting(key, [...installed, hash]);
      });
      installed.push(hash);
    } catch (error) {
      if (mediaId) s.softDelete("media", mediaId);
      throw error;
    }
  }
}

export async function ensureCharacterPresets(s: Scope) {
  if (process.env.toonflowDesktop === "1") return;
  const owner = get(`SELECT u.email FROM workspaces w JOIN users u ON u.id=w.owner_id
    WHERE w.id=? AND w.kind='personal' AND w.deleted_at IS NULL AND u.deleted_at IS NULL`, s.workspaceId);
  if (owner?.email !== superAdminEmail) return;
  const key = `webCharacterPresets/${s.workspaceId}`;
  const installed = setting<string[]>(key, []);
  if (presets.every(preset => installed.includes(preset.hash))) return;
  let pending = installing.get(key);
  if (!pending) {
    pending = installPresets(s, key, installed).finally(() => installing.delete(key));
    installing.set(key, pending);
  }
  await pending;
}
