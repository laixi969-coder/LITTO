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
    const dir = mkdtempSync(join(tmpdir(), "ff-media-"));
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
