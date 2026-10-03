import { spawn } from "node:child_process";
import { crc32 } from "node:zlib";
import { get, scoped, type Scope } from "../db.ts";
import { saveMedia, storage } from "../storage.ts";
import { bad, notFound, now } from "../util.ts";
import { end as clipEnd, getEdit, hasEdit, resolveClip } from "./nle.ts";
import { startNleRender } from "./nle-render.ts";

/** Basic assembly timeline (PRD Phase 5 / P2 "基础 Timeline"): approved Take per shot, in shot order, with subtitles and audio references. */
export type Clip = { shotId: string; order: number; title: string; kind: "take" | "hero" | "missing"; mediaId: string | null; mime: string | null; start: number; duration: number; subtitle: string; clipId?: string; srcIn?: number; srcOut?: number; speed?: number; transition?: { type: string; duration: number } };
export type Timeline = { edited?: boolean; fps: number; duration: number; clips: Clip[]; subtitles: { start: number; end: number; text: string; shotId: string }[]; audio: { referenceId: string; mediaId: string | null; name: string | null; shotId: string; start: number; duration: number }[]; missing: string[]; warnings: string[] };

/** Once an editable timeline exists, the public timeline is derived from it (V1 = clips, audio tracks = audio, shot subtitles follow their clips). */
function fromEdit(s: Scope, sequenceId: string): Timeline {
    const e = getEdit(s, sequenceId, false);
    const tl: Timeline = { edited: true, fps: e.fps, duration: 0, clips: [], subtitles: [], audio: [], missing: [], warnings: [] };
    const track = new Map(e.tracks.map((t) => [t.id, t]));
    const v1 = e.clips.filter((c) => track.get(c.trackId)?.kind === "video").sort((a, b) => a.start - b.start);
    for (const [i, c] of v1.entries()) {
        const r = resolveClip(s, c);
        const sh = c.shotId ? s.get("shots", c.shotId) : null;
        const kind = r.kind === "media" ? (r.mime?.startsWith("video/") ? "take" : r.mediaId ? "hero" : "missing") : r.kind;
        if (kind !== "take") { tl.missing.push(c.shotId ?? c.id); tl.warnings.push(`${sh ? `shot #${sh.ord + 1}` : `clip ${c.label || c.id}`} has no Approved Take${kind === "hero" ? " (Hero Frame stills used as placeholder)" : ""}`); }
        tl.clips.push({ shotId: c.shotId ?? "", clipId: c.id, order: sh?.ord ?? i, title: c.label || sh?.title || "", kind, mediaId: r.mediaId, mime: r.mime, start: c.start, duration: c.duration, subtitle: sh?.subtitle ?? "", srcIn: c.in, srcOut: c.in + c.duration * c.speed, speed: c.speed, transition: c.transition });
        if (sh?.subtitle) tl.subtitles.push({ start: c.start, end: c.start + c.duration, text: sh.subtitle, shotId: sh.id });
    }
    for (const c of e.clips.filter((x) => track.get(x.trackId)?.kind === "audio").sort((a, b) => a.start - b.start)) {
        const r = resolveClip(s, c);
        tl.audio.push({ referenceId: c.refId ?? c.id, mediaId: r.mediaId, name: c.label || null, shotId: c.shotId ?? c.refId?.split(":")[0] ?? "", start: c.start, duration: c.duration });
    }
    tl.duration = Math.max(0, ...e.clips.map(clipEnd));
    return tl;
}

export function buildTimeline(s: Scope, sequenceId: string): Timeline {
    if (!s.get("sequences", sequenceId)) throw notFound("sequence");
    if (hasEdit(s, sequenceId)) return fromEdit(s, sequenceId);
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
/** CMX3600 EDL: opens in Premiere / Resolve / FCP. Source in/out reflect trims & speed; dissolves are written as `D <frames>` events. */
export const toEdl = (tl: Timeline, title: string) => {
    const fps = tl.fps || 24;
    return `TITLE: ${title}\nFCM: NON-DROP FRAME\n\n` + tl.clips.map((c, i) => {
        const sIn = c.srcIn ?? 0, sOut = c.srcOut ?? c.duration;
        const d = c.transition?.type === "dissolve" ? c.transition.duration : 0;
        const kind = d > 0 ? `D    ${String(Math.round(d * fps)).padStart(3, "0")}` : "C       ";
        return `${String(i + 1).padStart(3, "0")}  AX       V     ${kind} ${tc(sIn, fps)} ${tc(sOut, fps)} ${tc(c.start, fps)} ${tc(c.start + c.duration, fps)}\n* FROM CLIP NAME: shot-${String(c.order + 1).padStart(2, "0")}${c.mediaId ? `-${c.mediaId}` : ""}\n* COMMENT: ${c.kind.toUpperCase()} ${c.title}${c.transition && c.transition.type === "fade_black" ? ` [FADE THROUGH BLACK ${c.transition.duration}s]` : ""}${c.speed && c.speed !== 1 ? ` [SPEED ${Math.round(c.speed * 100)}%]` : ""}`;
    }).join("\n\n") + "\n";
};

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
    const edit = hasEdit(s, sequenceId) ? getEdit(s, sequenceId, false) : null;
    if (edit) {
        const { history, future, ...pub } = edit;
        files.push({ name: "timeline-edit.json", data: Buffer.from(JSON.stringify({ ...pub, grade: pub.grade ? { ...pub.grade, lutCube: pub.grade.lutCube ? "grades/sequence.cube" : undefined } : null }, null, 2)) });
        if (edit.grade) { files.push({ name: "grades/sequence.json", data: Buffer.from(JSON.stringify({ ...edit.grade, lutCube: edit.grade.lutCube ? "grades/sequence.cube" : undefined }, null, 2)) }); if (edit.grade.lutCube) files.push({ name: "grades/sequence.cube", data: Buffer.from(edit.grade.lutCube) }); }
    }
    for (const c of tl.clips) {
        const sh = c.shotId ? s.get("shots", c.shotId) : null;
        if (!sh?.grade) continue;
        const n = String(sh.ord + 1).padStart(2, "0");
        files.push({ name: `grades/shot-${n}.json`, data: Buffer.from(JSON.stringify({ ...sh.grade, lutCube: sh.grade.lutCube ? `grades/shot-${n}.cube` : undefined }, null, 2)) });
        if (sh.grade.lutCube) files.push({ name: `grades/shot-${n}.cube`, data: Buffer.from(sh.grade.lutCube) });
    }
    const manifest = { format: "filmflow-assembly/1", exportedAt: now(), sequence: { id: seq.id, name: seq.name }, fps: tl.fps, duration: tl.duration, clips, audio, subtitles: tl.subtitles, warnings: tl.warnings };
    files.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: "timeline.edl", data: Buffer.from(toEdl(tl, seq.name)) }, { name: "subtitles.srt", data: Buffer.from(toSrt(tl)) });
    return { zip: zip(files), timeline: tl, name: `${seq.name.replace(/[^\w-]+/g, "_") || "sequence"}.zip` };
}

// ---- optional ffmpeg render (see nle-render.ts) ----
export const ffmpegAvailable = () => new Promise<boolean>((r) => { const p = spawn("ffmpeg", ["-version"]); p.on("error", () => r(false)); p.on("exit", (c) => r(c === 0)); });

export function startRender(workspaceId: string, projectId: string, sequenceId: string, actor: string, opts: { normalizeAudio?: boolean; targetLufs?: number; burnSubtitles?: boolean } = {}) {
    const s = scoped(workspaceId);
    const tl = buildTimeline(s, sequenceId);
    const r = s.insert("renders", { project_id: projectId, sequence_id: sequenceId, status: "RUNNING", manifest: { ...tl, options: opts }, created_by: actor, updated_at: now() });
    void startNleRender(workspaceId, projectId, sequenceId, r.id, opts);
    return r;
}
void bad;
