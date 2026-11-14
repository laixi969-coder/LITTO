import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, run } from "./db.ts";
import { storage, reserveWorkspaceStorage } from "./storage.ts";
import { log } from "./util.ts";

let derivativeJobs = 0;
async function saveDerivative(mediaId: string, workspaceId: string, key: string, data: Buffer, column: "thumbnail_key" | "proxy_key") {
    const available = () => get("SELECT m.id FROM media m JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN projects p ON p.id=m.project_id WHERE m.id=? AND m.workspace_id=? AND m.deleted_at IS NULL AND w.deleted_at IS NULL AND (m.project_id IS NULL OR p.id IS NOT NULL AND p.deleted_at IS NULL)", mediaId, workspaceId);
    if (!available()) throw new Error("素材或项目已删除，停止生成衍生素材");
    const release = reserveWorkspaceStorage(workspaceId, data.length);
    try {
        await storage.put(key, data);
        if (!available()) { await storage.delete(key); throw new Error("素材已删除，衍生素材已清理"); }
        run(`UPDATE media SET ${column}=? WHERE id=? AND workspace_id=?`, key, mediaId, workspaceId);
    } finally { release(); }
}

const exec = (args: string[]) => new Promise<void>((res, rej) => { const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { timeout: 120000, killSignal: "SIGKILL" }); let e = ""; p.stderr.on("data", (d) => (e = (e + d).slice(-4096))); p.on("error", rej); p.on("close", (c) => (c === 0 ? res() : rej(new Error(e.slice(-300))))); });

/**
 * Best-effort derivatives (PRD §17/P2): JPEG thumbnail for images/videos and a 480p proxy for videos.
 * Needs ffmpeg on the server; silently skipped otherwise (SVG mock output has no derivatives).
 */
export async function makeDerivatives(media: { id: string; workspaceId: string; projectId: string | null; mime: string; storageKey: string }) {
    if (!/^(video\/(mp4|webm)|image\/(png|jpeg|webp|gif))$/.test(media.mime)) return;
    // ACT: 衍生素材为可选优化，最多两个后台任务；忙时保留原片播放，不无限排队。
    if (derivativeJobs >= 2) return;
    const dir = mkdtempSync(join(tmpdir(), "milimili-media-"));
    derivativeJobs++;
    try {
        const src = join(dir, "src");
        writeFileSync(src, await storage.get(media.storageKey));
        const thumb = join(dir, "t.jpg");
        await exec(["-i", src, "-frames:v", "1", "-vf", "scale=320:-2", thumb]);
        const tKey = `${media.storageKey}.thumb.jpg`;
        await saveDerivative(media.id, media.workspaceId, tKey, readFileSync(thumb), "thumbnail_key");
        if (media.mime.startsWith("video/")) {
            const proxy = join(dir, "p.mp4");
            await exec(["-i", src, "-vf", "scale=-2:480", "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", "-an", proxy]);
            const pKey = `${media.storageKey}.proxy.mp4`;
            await saveDerivative(media.id, media.workspaceId, pKey, readFileSync(proxy), "proxy_key");
        }
    } catch (e) {
        log.info("derivatives skipped:", (e as Error).message.slice(0, 120));
    } finally { derivativeJobs--; rmSync(dir, { recursive: true, force: true }); }
}

export type Probe = {
  duration: number | null; width: number | null; height: number | null; hasVideo: boolean; hasAudio: boolean;
  video: {
    codec: string | null; pixelFormat: string | null; bitsPerRawSample: number | null;
    colorRange: string | null; colorSpace: string | null; colorTransfer: string | null; colorPrimaries: string | null;
  } | null;
};
const run2 = (cmd: string, args: string[], signal?: AbortSignal) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
  const process = spawn(cmd, args, { signal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", failed = false;
  process.stdout.on("data", data => (out += data));
  process.stderr.on("data", data => (err += data));
  process.on("error", error => { failed = true; err += error.message; });
  // 等待管道关闭后再返回，避免丢失末尾检测统计或在取消的进程退出前清理临时目录。
  process.on("close", code => resolve({ code: failed ? -1 : code ?? -1, out, err }));
});

/** ffprobe a file on disk; null when ffprobe is unavailable or the file is unreadable. */
export async function probeFile(path: string, signal?: AbortSignal): Promise<Probe | null> {
    const r = await run2("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], signal);
    if (r.code !== 0) return null;
    try {
        const j = JSON.parse(r.out);
        const v = (j.streams ?? []).find((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
        const d = Number(j.format?.duration ?? v?.duration);
        const bits = Number(v?.bits_per_raw_sample);
        const tag = (value: unknown) => typeof value === "string" && value !== "unknown" && value !== "unspecified" ? value : null;
        return { duration: Number.isFinite(d) ? d : null, width: v?.width ?? null, height: v?.height ?? null, hasVideo: !!v, hasAudio: (j.streams ?? []).some((s: any) => s.codec_type === "audio"),
          // ACT: 只保留源文件声明；缺标记不猜BT.709，raw sample位数不等于有效影像精度。
          video: v ? { codec: tag(v.codec_name), pixelFormat: tag(v.pix_fmt), bitsPerRawSample: Number.isInteger(bits) && bits > 0 ? bits : null,
            colorRange: tag(v.color_range), colorSpace: tag(v.color_space), colorTransfer: tag(v.color_transfer), colorPrimaries: tag(v.color_primaries) } : null };
    } catch { return null; }
}
export async function probeBuffer(data: Buffer, signal?: AbortSignal): Promise<Probe | null> {
    const dir = mkdtempSync(join(tmpdir(), "milimili-probe-"));
    try { writeFileSync(join(dir, "m"), data); return await probeFile(join(dir, "m"), signal); } finally { rmSync(dir, { recursive: true, force: true }); }
}
export { run2 as runCmd };
