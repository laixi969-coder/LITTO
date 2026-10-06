import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { config } from "./config.ts";
import { all, get, run, scoped } from "./db.ts";
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
        mkdirSync(dirname(this.path(key)), { recursive: true });
        writeFileSync(this.path(key), data);
    }
    getSync(key: string) {
        return readFileSync(this.path(key));
    }
    putSync(key: string, data: Buffer) {
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

const MAX_BYTES = 200 * 1024 * 1024;
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

export async function saveMedia(workspaceId: string, projectId: string | null, data: Buffer, opts: { source: string; mime?: string; duration?: number; allowUnsniffed?: boolean }) {
    if (data.length > MAX_BYTES) throw bad("file too large");
    const s = sniff(data);
    if (!s && !opts.allowUnsniffed) throw bad("unsupported or unrecognised file type");
    const mime = s?.mime ?? opts.mime ?? "application/octet-stream";
    const ws = get("SELECT quota_bytes FROM workspaces WHERE id=?", workspaceId)!;
    if (usage(workspaceId).bytes + data.length > ws.quota_bytes) throw conflict("storage quota exceeded", "quota_exceeded");
    // Real video/audio: record true duration and size (needed for trim limits in the editor). Best effort, needs ffprobe.
    let probed: { duration: number | null; width: number | null; height: number | null } | null = null;
    if (/^(video|audio)\//.test(mime) && !process.env.LITTO_NO_PROBE) probed = await probeBuffer(data);
    const id = ulid();
    const key = `${workspaceId}/${projectId ?? "_"}/${id}`;
    await storage.put(key, data);
    const row = scoped(workspaceId).insert("media", { id, project_id: projectId, mime, size: data.length, hash: sha256(data), duration: probed?.duration ?? opts.duration ?? null, width: s?.width ?? probed?.width ?? null, height: s?.height ?? probed?.height ?? null, source: opts.source, storage_key: key });
    if (!process.env.LITTO_NO_DERIVATIVES) void makeDerivatives(row as any);
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
    for (const m of all("SELECT storage_key FROM media WHERE workspace_id=?", workspaceId)) await storage.delete(m.storage_key).catch(() => {});
    const tables = all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name).filter((n) => all(`PRAGMA table_info(${n})`).some((c) => c.name === "workspace_id") && !["credit_ledger", "audit_logs", "workspaces"].includes(n));
    for (const t of tables) run(`DELETE FROM ${t} WHERE workspace_id=?`, workspaceId);
    run("UPDATE workspaces SET name='[purged]' WHERE id=?", workspaceId);
    if (existsSync(join(config.mediaDir, workspaceId))) rmSync(join(config.mediaDir, workspaceId), { recursive: true, force: true });
    void now;
}
