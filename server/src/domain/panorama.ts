import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type Scope } from "../db.ts";
import { storage } from "../storage.ts";
import { bad, notFound, sha256, ulid } from "../util.ts";

let ff: boolean | undefined;
export const ffmpegSync = () => (ff ??= spawnSync("ffmpeg", ["-version"]).status === 0);

export type View = { yaw: number; pitch: number; fov: number };
export const viewOf = (cam: any): View | null => (typeof cam?.viewYaw === "number" && typeof cam?.viewPitch === "number" ? { yaw: cam.viewYaw, pitch: cam.viewPitch, fov: cam.viewFov ?? 90 } : null);

/** Rectilinear perspective crop of an equirectangular image (ffmpeg v360). yaw 0 = panorama centre, + = turn right. */
export function cropPanorama(src: Buffer, v: View, w = 1280, h = 720): Buffer {
    if (!ffmpegSync()) throw Object.assign(new Error("ffmpeg is not installed on the server; panorama crops are unavailable"), { unavailable: true });
    const vfov = (2 * Math.atan(Math.tan((v.fov * Math.PI) / 360) * (h / w)) * 180) / Math.PI;
    const dir = mkdtempSync(join(tmpdir(), "ovia-pano-"));
    try {
        writeFileSync(join(dir, "in"), src);
        const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2", "-i", join(dir, "in"), "-vf", `v360=e:flat:yaw=${v.yaw}:pitch=${v.pitch}:h_fov=${v.fov}:v_fov=${vfov.toFixed(3)}:w=${w}:h=${h}`, "-frames:v", "1", "-f", "image2", "-c:v", "png", join(dir, "out.png")]);
        if (r.status !== 0) throw bad(`panorama crop failed: ${String(r.stderr).slice(-200)}`);
        return readFileSync(join(dir, "out.png"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function panoramaRef(s: Scope, refId: string) {
    const ref = s.get("refs", refId);
    if (!ref) throw notFound("reference");
    const m = ref.mediaId ? s.get("media", ref.mediaId) : null;
    if (!m || !/^image\/(png|jpeg|webp)$/.test(m.mime)) throw bad("reference is not a raster image");
    return { ref, media: m };
}

/** Cached crop as a real media row (so jobs can send it as an input). Sync because the prompt compiler is sync. Returns null (never throws) when unavailable. */
export function ensureCropMedia(s: Scope, projectId: string, refId: string, v: View): { mediaId: string | null; warning?: string } {
    try {
        if (!ffmpegSync()) return { mediaId: null, warning: "panorama crop skipped: ffmpeg not available on the server" };
        if (!storage.putSync || !storage.getSync) return { mediaId: null, warning: "panorama crop skipped: storage adapter has no sync access" };
        const { media } = panoramaRef(s, refId);
        const key = sha256(`${media.hash}|${v.yaw}|${v.pitch}|${v.fov}|1280x720`).slice(0, 32);
        const hit = get("SELECT id FROM media WHERE workspace_id=? AND source=? AND deleted_at IS NULL", s.workspaceId, `panorama-crop:${key}`);
        if (hit) return { mediaId: hit.id };
        const png = cropPanorama(storage.getSync(media.storageKey), v);
        const id = ulid(), sk = `${s.workspaceId}/${projectId}/${id}`;
        storage.putSync(sk, png);
        s.insert("media", { id, project_id: projectId, mime: "image/png", size: png.length, hash: sha256(png), width: 1280, height: 720, source: `panorama-crop:${key}`, storage_key: sk });
        return { mediaId: id };
    } catch (e) { return { mediaId: null, warning: `panorama crop skipped: ${(e as Error).message}` }; }
}
