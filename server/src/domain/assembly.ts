import { spawn } from "node:child_process";
import { crc32 } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, scoped, type Scope } from "../db.ts";
import { saveMedia, storage } from "../storage.ts";
import { bad, notFound, now } from "../util.ts";

/** Basic assembly timeline (PRD Phase 5 / P2 "基础 Timeline"): approved Take per shot, in shot order, with subtitles and audio references. */
export type Clip = { shotId: string; order: number; title: string; kind: "take" | "hero" | "missing"; mediaId: string | null; mime: string | null; start: number; duration: number; subtitle: string };
export type Timeline = { fps: number; duration: number; clips: Clip[]; subtitles: { start: number; end: number; text: string; shotId: string }[]; audio: { referenceId: string; mediaId: string | null; name: string | null; shotId: string; start: number; duration: number }[]; missing: string[]; warnings: string[] };

export function buildTimeline(s: Scope, sequenceId: string): Timeline {
    if (!s.get("sequences", sequenceId)) throw notFound("sequence");
    const shots = s.list("shots", { sequenceId }, "ord");
    const bindings = s.list("reference_bindings", { targetType: "shot" });
    let t = 0;
    const tl: Timeline = { fps: 24, duration: 0, clips: [], subtitles: [], audio: [], missing: [], warnings: [] };
    for (const sh of shots) {
        const take = sh.approvedTakeId ? s.get("takes", sh.approvedTakeId) : null;
        const hero = !take && sh.heroKeyframeId ? s.get("keyframes", sh.heroKeyframeId) : null;
        const media = take?.mediaId ?? hero?.mediaId ?? null;
        const m = media ? s.get("media", media) : null;
        const dur = Number(sh.duration ?? 4);
        if (!take) { tl.missing.push(sh.id); tl.warnings.push(`shot #${sh.ord + 1} has no Approved Take${hero ? " (Hero Frame stills used as placeholder)" : ""}`); }
        tl.clips.push({ shotId: sh.id, order: sh.ord, title: sh.title ?? "", kind: take ? "take" : hero ? "hero" : "missing", mediaId: media, mime: m?.mime ?? null, start: t, duration: dur, subtitle: sh.subtitle ?? "" });
        if (sh.subtitle) tl.subtitles.push({ start: t, end: t + dur, text: sh.subtitle, shotId: sh.id });
        for (const b of bindings.filter((x: any) => x.targetId === sh.id && x.role === "AUDIO")) {
            const ref = s.get("refs", b.referenceId);
            tl.audio.push({ referenceId: b.referenceId, mediaId: ref?.mediaId ?? null, name: ref?.name ?? null, shotId: sh.id, start: t, duration: dur });
        }
        t += dur;
    }
    tl.duration = t;
    return tl;
}

const tc = (sec: number, fps = 24) => {
    const f = Math.round(sec * fps), h = Math.floor(f / (3600 * fps)), m = Math.floor((f % (3600 * fps)) / (60 * fps)), x = Math.floor((f % (60 * fps)) / fps);
    return [h, m, x, f % fps].map((n) => String(n).padStart(2, "0")).join(":");
};
const srtTime = (sec: number) => new Date(Math.round(sec * 1000)).toISOString().slice(11, 23).replace(".", ",");

export const toSrt = (tl: Timeline) => tl.subtitles.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
/** CMX3600 EDL: opens in Premiere / Resolve / FCP. */
export const toEdl = (tl: Timeline, title: string) =>
    `TITLE: ${title}\nFCM: NON-DROP FRAME\n\n` + tl.clips.map((c, i) => `${String(i + 1).padStart(3, "0")}  AX       V     C        ${tc(0)} ${tc(c.duration)} ${tc(c.start)} ${tc(c.start + c.duration)}\n* FROM CLIP NAME: shot-${String(c.order + 1).padStart(2, "0")}${c.mediaId ? `-${c.mediaId}` : ""}\n* COMMENT: ${c.kind.toUpperCase()} ${c.title}`).join("\n\n") + "\n";

// ---- minimal ZIP writer (stored, no compression; fine for media that is already compressed) ----
function zip(files: { name: string; data: Buffer }[]) {
    const parts: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name), crc = crc32(f.data) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
        parts.push(local, name, f.data);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
        central.push(c, name);
        offset += 30 + name.length + f.data.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, end]);
}

const ext = (mime: string | null) => ({ "video/mp4": "mp4", "video/webm": "webm", "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "audio/mpeg": "mp3", "audio/wav": "wav", "image/webp": "webp", "image/gif": "gif" })[mime ?? ""] ?? "bin";

/** Interchange package: manifest + EDL + SRT + every referenced media file. */
export async function exportPackage(s: Scope, sequenceId: string) {
    const seq = s.get("sequences", sequenceId)!;
    const tl = buildTimeline(s, sequenceId);
    const files: { name: string; data: Buffer }[] = [];
    const names = new Map<string, string>();
    const put = async (mediaId: string | null, prefix: string) => {
        if (!mediaId) return null;
        if (names.has(mediaId)) return names.get(mediaId)!;
        const m = s.get("media", mediaId);
        if (!m) return null;
        const name = `media/${prefix}-${mediaId}.${ext(m.mime)}`;
        files.push({ name, data: await storage.get(m.storageKey) });
        names.set(mediaId, name);
        return name;
    };
    const clips = [];
    for (const c of tl.clips) clips.push({ ...c, file: await put(c.mediaId, `shot-${String(c.order + 1).padStart(2, "0")}`) });
    const audio = [];
    for (const a of tl.audio) audio.push({ ...a, file: await put(a.mediaId, "audio") });
    const manifest = { format: "filmflow-assembly/1", exportedAt: now(), sequence: { id: seq.id, name: seq.name }, fps: tl.fps, duration: tl.duration, clips, audio, subtitles: tl.subtitles, warnings: tl.warnings };
    files.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: "timeline.edl", data: Buffer.from(toEdl(tl, seq.name)) }, { name: "subtitles.srt", data: Buffer.from(toSrt(tl)) });
    return { zip: zip(files), timeline: tl, name: `${seq.name.replace(/[^\w-]+/g, "_") || "sequence"}.zip` };
}

// ---- optional ffmpeg render (only when every clip is a real video) ----
export const ffmpegAvailable = () => new Promise<boolean>((r) => { const p = spawn("ffmpeg", ["-version"]); p.on("error", () => r(false)); p.on("exit", (c) => r(c === 0)); });
const sh = (cmd: string, args: string[]) => new Promise<void>((res, rej) => { const p = spawn(cmd, args); let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("error", rej); p.on("exit", (c) => (c === 0 ? res() : rej(new Error(err.slice(-400))))); });

export function startRender(workspaceId: string, projectId: string, sequenceId: string, actor: string) {
    const s = scoped(workspaceId);
    const tl = buildTimeline(s, sequenceId);
    const r = s.insert("renders", { project_id: projectId, sequence_id: sequenceId, status: "RUNNING", manifest: tl, created_by: actor, updated_at: now() });
    void (async () => {
        const dir = mkdtempSync(join(tmpdir(), "ff-render-"));
        try {
            if (!(await ffmpegAvailable())) throw new Error("ffmpeg is not installed on the server; use the export package instead");
            const bad = tl.clips.find((c) => c.kind !== "take" || !c.mime?.startsWith("video/"));
            if (bad) throw new Error(`clip for shot #${bad.order + 1} is not an approved video Take (${bad.kind}${bad.mime ? ", " + bad.mime : ""}); render needs real video for every shot`);
            const list: string[] = [];
            for (const [i, c] of tl.clips.entries()) {
                const m = get("SELECT * FROM media WHERE id=?", c.mediaId)!;
                const src = join(dir, `s${i}.mp4`), out = join(dir, `n${i}.mp4`);
                writeFileSync(src, await storage.get(m.storage_key));
                // normalise every clip to the same size/fps/codec so concat is safe; add silent audio if a clip has none
                await sh("ffmpeg", ["-y", "-i", src, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(c.duration), "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-c:a", "aac", "-shortest", out]);
                list.push(`file '${out}'`);
            }
            writeFileSync(join(dir, "list.txt"), list.join("\n"));
            const args = ["-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt")];
            if (tl.subtitles.length) { writeFileSync(join(dir, "s.srt"), toSrt(tl)); args.push("-i", join(dir, "s.srt"), "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text"); } else args.push("-c", "copy");
            args.push(join(dir, "final.mp4"));
            await sh("ffmpeg", args);
            const media = await saveMedia(workspaceId, projectId, readFileSync(join(dir, "final.mp4")), { source: "render", duration: tl.duration });
            s.update("renders", r.id, { status: "SUCCEEDED", media_id: media.id });
        } catch (e) {
            s.update("renders", r.id, { status: "FAILED", error: (e as Error).message.slice(0, 500) });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    })();
    return r;
}
void bad;
