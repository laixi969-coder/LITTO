import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "@toonflow/file";
import { uploadMaxBytes } from "./upload.ts";
import { join, dirname } from "node:path";
import { config } from "./config.ts";
import { all, get, run, scoped, tx } from "./db.ts";
import { sign, verifySig } from "./crypto.ts";
import { bad, conflict, now, sha256, ulid } from "./util.ts";
import { makeDerivatives, probeBuffer } from "./media-tools.ts";

/** Storage adapter contract. Local FS is implemented; S3/MinIO plug in by implementing the same 4 methods. */
export interface StorageAdapter {
    put(key: string, data: Buffer): Promise<void>;
    /** Optional synchronous write (used by the sync prompt compiler for cached derived inputs). */
    putSync?(key: string, data: Buffer): void;
    getSync?(key: string): Buffer;
    get(key: string): Promise<Buffer>;
    delete(key: string): Promise<void>;
    signedUrl(key: string, mediaId: string, ttlSec: number): string;
}

class LocalStorage implements StorageAdapter {
    private path = (k: string) => join(config.mediaDir, k);
    async put(key: string, data: Buffer) {
        if (get("SELECT deleted_at FROM workspaces WHERE id=?", key.split("/")[0])?.deleted_at) throw conflict("工作区已注销，停止写入");
        mkdirSync(dirname(this.path(key)), { recursive: true });
        writeFileSync(this.path(key), data);
    }
    getSync(key: string) {
        return readFileSync(this.path(key));
    }
    putSync(key: string, data: Buffer) {
        if (get("SELECT deleted_at FROM workspaces WHERE id=?", key.split("/")[0])?.deleted_at) throw conflict("工作区已注销，停止写入");
        mkdirSync(dirname(this.path(key)), { recursive: true });
        writeFileSync(this.path(key), data);
    }
    async get(key: string) {
        return readFileSync(this.path(key));
    }
    async delete(key: string) {
        rmSync(this.path(key), { force: true });
    }
    signedUrl(_key: string, mediaId: string, ttlSec: number) {
        const exp = Math.floor(Date.now() / 1000) + ttlSec;
        return `/media/${mediaId}/file?exp=${exp}&sig=${sign(`${mediaId}.${exp}`)}`;
    }
}
export const storage: StorageAdapter = new LocalStorage();

export function checkSignedUrl(mediaId: string, exp: string, sig: string) {
    return Number(exp) > Date.now() / 1000 && verifySig(`${mediaId}.${exp}`, sig);
}

type Sniffed = { mime: string; width?: number; height?: number };

/** Validate by magic bytes, never by client-declared type. */
export function sniff(buf: Buffer): Sniffed | null {
    if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        for (let i = 2; i + 9 < buf.length; ) {
            if (buf[i] !== 0xff) break;
            const m = buf[i + 1];
            if (m >= 0xc0 && m <= 0xc3) return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
            i += 2 + buf.readUInt16BE(i + 2);
        }
        return { mime: "image/jpeg" };
    }
    const head = buf.subarray(0, 16).toString("latin1");
    if (head.startsWith("GIF8")) return { mime: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return { mime: "image/webp" };
    if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") return { mime: "audio/wav" };
    if (head.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg" };
    if (head.slice(4, 8) === "ftyp") return { mime: "video/mp4" };
    if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mime: "video/webm" };
    const text = buf.subarray(0, 512).toString("utf8").trimStart();
    if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return { mime: "image/svg+xml" };
    return null;
}

export function usage(workspaceId: string) {
    return get("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS files FROM media WHERE workspace_id=? AND deleted_at IS NULL", workspaceId)!;
}

export async function saveMedia(workspaceId: string, projectId: string | null, data: Buffer, opts: { source: string; mime?: string; duration?: number; allowUnsniffed?: boolean; signal?: AbortSignal }) {
    opts.signal?.throwIfAborted();
    if (data.length > uploadMaxBytes) throw bad("file too large");
    const s = sniff(data);
    if (!s && !opts.allowUnsniffed) throw bad("unsupported or unrecognised file type");
    const mime = s?.mime ?? opts.mime ?? "application/octet-stream";
    const ws = get("SELECT quota_bytes FROM workspaces WHERE id=?", workspaceId)!;
    if (usage(workspaceId).bytes + data.length > ws.quota_bytes) throw conflict("storage quota exceeded", "quota_exceeded");
    // Real video/audio: record true duration and size (needed for trim limits in the editor). Best effort, needs ffprobe.
    let probed: { duration: number | null; width: number | null; height: number | null } | null = null;
    if (/^(video|audio)\//.test(mime) && !process.env.MILIMILI_NO_PROBE) probed = await probeBuffer(data, opts.signal);
    opts.signal?.throwIfAborted();
    const id = ulid();
    const key = `${workspaceId}/${projectId ?? "_"}/${id}`;
    await storage.put(key, data);
    let row;
    try {
        opts.signal?.throwIfAborted();
        // 文件写入期间其他请求也可能完成入库；同步复核配额与记录写入之间不能再 await。
        const current = get("SELECT quota_bytes FROM workspaces WHERE id=? AND deleted_at IS NULL", workspaceId);
        if (!current || usage(workspaceId).bytes + data.length > current.quota_bytes) throw conflict("storage quota exceeded", "quota_exceeded");
        row = scoped(workspaceId).insert("media", { id, project_id: projectId, mime, size: data.length, hash: sha256(data), duration: probed?.duration ?? opts.duration ?? null, width: s?.width ?? probed?.width ?? null, height: s?.height ?? probed?.height ?? null, source: opts.source, storage_key: key });
    } catch (error) {
        await storage.delete(key);
        throw error;
    }
    if (!process.env.MILIMILI_NO_DERIVATIVES) void makeDerivatives(row as any);
    return row;
}

export const mediaView = (m: any) => {
    if (!m) return m;
    const url = storage.signedUrl(m.storageKey, m.id, 3600);
    // Derivatives are generated asynchronously; the row may not have them yet.
    const fresh = get("SELECT thumbnail_key, proxy_key FROM media WHERE id=?", m.id);
    return { id: m.id, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, source: m.source, url, thumbnailUrl: fresh?.thumbnail_key ? `${url}&variant=thumb` : null, proxyUrl: fresh?.proxy_key ? `${url}&variant=proxy` : null, createdAt: m.createdAt };
};

export async function softDeleteMedia(workspaceId: string, id: string) {
    const scope = scoped(workspaceId);
    const library = scope.list("library_assets");
    if (library.some(entry => entry.authoritativeReference === id || entry.referenceSnapshots?.some((ref: any) => ref.mediaId === id)
        || entry.references?.some((ref: string) => scope.get("refs", ref)?.mediaId === id))) {
        throw conflict("此素材正在角色资产库中使用，请先更换库中的参考", "media_in_use");
    }
    scoped(workspaceId).softDelete("media", id);
}
/** Permanent cleanup of soft-deleted media older than `olderThanMs`. */
export async function cleanupMedia(olderThanMs = 0) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = all("SELECT id, storage_key FROM media WHERE deleted_at IS NOT NULL AND deleted_at<=?", cutoff);
    for (const r of rows) {
        await storage.delete(r.storage_key);
        const d = get("SELECT thumbnail_key, proxy_key FROM media WHERE id=?", r.id);
        for (const k of [d?.thumbnail_key, d?.proxy_key]) if (k) await storage.delete(k);
        run("DELETE FROM media WHERE id=?", r.id);
    }
    return rows.length;
}

/** Workspace deletion: hard-remove every tenant row and file. */
export async function purgeWorkspace(workspaceId: string) {
    if (!/^[0-9A-Z]{26}$/.test(workspaceId) || !get("SELECT id FROM workspaces WHERE id=? AND deleted_at IS NOT NULL", workspaceId)) throw bad("只能清理已注销的工作区");
    const { settleWorkspaceJobs } = await import("./jobs.ts");
    await settleWorkspaceJobs(workspaceId);
    if (get("SELECT id FROM renders WHERE workspace_id=? AND status IN ('QUEUED','RUNNING')", workspaceId)) throw conflict("等待渲染结束后重试清理");
    await purgeTenantFiles(workspaceId);
    for (const directory of [join(config.mediaDir, workspaceId), join(config.dataDir, "uploads", workspaceId)]) rmSync(directory, { recursive: true, force: true });
    tx(() => {
      run("DELETE FROM webhook_events WHERE job_id IN (SELECT id FROM generation_jobs WHERE workspace_id=?)", workspaceId);
      run("UPDATE audit_logs SET detail=NULL WHERE workspace_id=?", workspaceId);
      const tables = all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name).filter((name) => /^[a-zA-Z0-9_]+$/.test(name) && all(`PRAGMA table_info(${name})`).some((column) => column.name === "workspace_id") && !["credit_ledger", "audit_logs", "workspaces", "workspace_purges"].includes(name));
      for (const table of tables) run(`DELETE FROM ${table} WHERE workspace_id=?`, workspaceId);
      run("UPDATE workspaces SET name='[purged]' WHERE id=?", workspaceId);
    });
}

let purgeTenantFiles: (workspaceId: string) => Promise<void> = async () => {
  if (process.env.TOONFLOW_DATA_DIR) throw new Error("租户目录清理器尚未初始化");
};
export function configureWorkspacePurge(handler: typeof purgeTenantFiles) { purgeTenantFiles = handler; }

export function queueWorkspacePurge(workspaceId: string) {
  run("INSERT OR IGNORE INTO workspace_purges(workspace_id,created_at,updated_at) VALUES(?,?,?)", workspaceId, now(), now());
}

let purging = false;
/** 删除意图与注销事务一同持久化；失败保留记录，启动与定时任务继续执行。 */
export async function sweepWorkspacePurges() {
  if (purging) return;
  purging = true;
  try {
    for (const row of all("SELECT workspace_id FROM workspace_purges WHERE status!='complete'")) {
      try {
        await purgeWorkspace(row.workspace_id);
        run("UPDATE workspace_purges SET status='complete', error=NULL, updated_at=? WHERE workspace_id=?", now(), row.workspace_id);
      } catch (error) {
        run("UPDATE workspace_purges SET status='pending', error=?, updated_at=? WHERE workspace_id=?", String(error).slice(0, 500), now(), row.workspace_id);
      }
    }
  } finally { purging = false; }
}
