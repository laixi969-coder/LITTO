import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./db.ts";
import { storage } from "./storage.ts";
import { log } from "./util.ts";

const exec = (args: string[]) => new Promise<void>((res, rej) => { const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args]); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("error", rej); p.on("exit", (c) => (c === 0 ? res() : rej(new Error(e.slice(-300))))); });

/**
 * Best-effort derivatives (PRD §17/P2): JPEG thumbnail for images/videos and a 480p proxy for videos.
 * Needs ffmpeg on the server; silently skipped otherwise (SVG mock output has no derivatives).
 */
export async function makeDerivatives(media: { id: string; workspaceId: string; projectId: string | null; mime: string; storageKey: string }) {
    if (!/^(video\/(mp4|webm)|image\/(png|jpeg|webp|gif))$/.test(media.mime)) return;
    const dir = mkdtempSync(join(tmpdir(), "ovia-media-"));
    try {
        const src = join(dir, "src");
        writeFileSync(src, await storage.get(media.storageKey));
        const thumb = join(dir, "t.jpg");
        await exec(["-i", src, "-frames:v", "1", "-vf", "scale=320:-2", thumb]);
        const tKey = `${media.storageKey}.thumb.jpg`;
        await storage.put(tKey, readFileSync(thumb));
        run("UPDATE media SET thumbnail_key=? WHERE id=?", tKey, media.id);
        if (media.mime.startsWith("video/")) {
            const proxy = join(dir, "p.mp4");
            await exec(["-i", src, "-vf", "scale=-2:480", "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", "-an", proxy]);
            const pKey = `${media.storageKey}.proxy.mp4`;
            await storage.put(pKey, readFileSync(proxy));
            run("UPDATE media SET proxy_key=? WHERE id=?", pKey, media.id);
        }
    } catch (e) {
        log.info("derivatives skipped:", (e as Error).message.slice(0, 120));
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

export type Probe = { duration: number | null; width: number | null; height: number | null; hasVideo: boolean; hasAudio: boolean };
const run2 = (cmd: string, args: string[]) => new Promise<{ code: number; out: string; err: string }>((res) => { const p = spawn(cmd, args); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("error", () => res({ code: -1, out, err })); p.on("exit", (code) => res({ code: code ?? -1, out, err })); });

/** ffprobe a file on disk; null when ffprobe is unavailable or the file is unreadable. */
export async function probeFile(path: string): Promise<Probe | null> {
    const r = await run2("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
    if (r.code !== 0) return null;
    try {
        const j = JSON.parse(r.out);
        const v = (j.streams ?? []).find((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
        const d = Number(j.format?.duration ?? v?.duration);
        return { duration: Number.isFinite(d) ? d : null, width: v?.width ?? null, height: v?.height ?? null, hasVideo: !!v, hasAudio: (j.streams ?? []).some((s: any) => s.codec_type === "audio") };
    } catch { return null; }
}
export async function probeBuffer(data: Buffer): Promise<Probe | null> {
    const dir = mkdtempSync(join(tmpdir(), "ovia-probe-"));
    try { writeFileSync(join(dir, "m"), data); return await probeFile(join(dir, "m")); } finally { rmSync(dir, { recursive: true, force: true }); }
}
export { run2 as runCmd };
