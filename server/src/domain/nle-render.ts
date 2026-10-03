import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoped, type Scope } from "../db.ts";
import { probeFile, runCmd } from "../media-tools.ts";
import { saveMedia, storage } from "../storage.ts";
import { bad, conflict, now } from "../util.ts";
import { gradeFilters, isNeutral } from "./grade.ts";
import { end, getEdit, resolveClip, type EClip } from "./nle.ts";

const W = 1280, H = 720;
const r3 = (n: number) => Number(n.toFixed(3));
const ext = (mime: string | null) => ({ "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "image/png": "png", "image/jpeg": "jpg" })[mime ?? ""] ?? "bin";
const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** atempo only accepts 0.5..2 per instance. */
const atempo = (sp: number) => { const out: string[] = []; let x = sp; while (x > 2) { out.push("atempo=2"); x /= 2; } while (x < 0.5) { out.push("atempo=0.5"); x /= 0.5; } if (Math.abs(x - 1) > 1e-6 || !out.length) out.push(`atempo=${x.toFixed(4)}`); return sp === 1 ? [] : out; };

type RenderOpts = { normalizeAudio?: boolean; targetLufs?: number; burnSubtitles?: boolean };

export async function startNleRender(workspaceId: string, projectId: string, sequenceId: string, renderId: string, opts: RenderOpts) {
    const s = scoped(workspaceId);
    const dir = mkdtempSync(join(tmpdir(), "ovia-nle-"));
    try {
        const media = await renderTimeline(s, sequenceId, dir, opts);
        const saved = await saveMedia(workspaceId, projectId, readFileSync(media.file), { source: "render", duration: media.duration });
        s.update("renders", renderId, { status: "SUCCEEDED", media_id: saved.id });
    } catch (e) {
        s.update("renders", renderId, { status: "FAILED", error: (e as Error).message.slice(0, 600) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function renderTimeline(s: Scope, sequenceId: string, dir: string, opts: RenderOpts) {
    const ff = await runCmd("ffmpeg", ["-version"]);
    if (ff.code !== 0) throw new Error("ffmpeg is not installed on the server; use the export package instead");
    const e = getEdit(s, sequenceId, false);
    const tracks = new Map(e.tracks.map((t) => [t.id, t]));
    const video = e.clips.filter((c) => tracks.get(c.trackId)?.kind === "video" && !tracks.get(c.trackId)!.muted);
    const mainTrack = e.tracks.find((t) => t.kind === "video");
    const main = video.filter((c) => c.trackId === mainTrack?.id).sort((a, b) => a.start - b.start);
    const overlays = video.filter((c) => c.trackId !== mainTrack?.id).sort((a, b) => a.start - b.start);
    if (!main.length) throw new Error("the timeline has no video clips");

    // ---- inputs
    const inputs: string[][] = [];
    const info: { hasAudio: boolean; image: boolean }[] = [];
    let lut = 0;
    const addInput = async (c: EClip, needVideoOnly = false) => {
        const r = resolveClip(s, c);
        const sh = c.shotId ? s.get("shots", c.shotId) : null;
        if (!r.mediaId) throw new Error(`clip for ${sh ? `shot #${sh.ord + 1}` : `"${c.label || c.id}"`} is not an approved video Take (${r.kind}); render needs real video for every shot`);
        const isVideo = r.mime?.startsWith("video/"), isImage = r.mime?.startsWith("image/") && c.type === "media";
        if (!isVideo && !isImage && !(needVideoOnly === false && r.mime?.startsWith("audio/")))
            throw new Error(`clip for ${sh ? `shot #${sh.ord + 1}` : `"${c.label || c.id}"`} is not an approved video Take (${r.kind}, ${r.mime ?? "no media"}); render needs real video for every shot`);
        const m = s.get("media", r.mediaId)!;
        const file = join(dir, `in${inputs.length}.${ext(m.mime)}`);
        writeFileSync(file, await storage.get(m.storageKey));
        const p = await probeFile(file);
        if (!p) throw new Error(`media ${m.id} could not be read by ffprobe (${m.mime})`);
        if ((isVideo) && !p.hasVideo) throw new Error(`media ${m.id} has no video stream`);
        inputs.push(isImage ? ["-loop", "1", "-framerate", String(e.fps), "-t", String(c.duration), "-i", file] : ["-i", file]);
        info.push({ hasAudio: p.hasAudio, image: !!isImage });
        return inputs.length - 1;
    };
    const lutFor = (cube?: string) => { if (!cube) return undefined; const f = join(dir, `lut${lut++}.cube`); writeFileSync(f, cube); return f; };

    const g: string[] = [];
    const fps = e.fps;
    const clipChain = (c: EClip, k: number, extra: string, startShift = false) => {
        const sp = c.speed, inn = c.in, out = c.in + c.duration * sp;
        const head = info[k].image ? `[${k}:v]` : `[${k}:v]trim=start=${r3(inn)}:end=${r3(out)},`;
        return `${head}setpts=(PTS-STARTPTS)/${sp}${startShift ? `+${r3(c.start)}/TB` : ""},settb=AVTB,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p${extra ? "," + extra : ""}`;
    };

    // ---- V1 layout: black gaps, cuts (concat), dissolves (xfade), dip-to-black (fades)
    type Seg = { label: string; dur: number; dissolve: number };
    const segs: Seg[] = [];
    let pos = 0;
    const audioItems: { k: number; c: EClip; track: string; role: string; embedded: boolean }[] = [];
    for (const [i, c] of main.entries()) {
        const k = await addInput(c, true);
        const sh = c.shotId ? s.get("shots", c.shotId) : null;
        const gr = sh?.grade && !isNeutral(sh.grade) ? gradeFilters(sh.grade, lutFor(sh.grade.lutCube)) : "";
        const next = main[i + 1], dipOut = next?.transition.type === "fade_black" ? next.transition.duration / 2 : 0;
        const dipIn = c.transition.type === "fade_black" && i > 0 ? c.transition.duration / 2 : 0;
        const fades = [dipIn ? `fade=t=in:st=0:d=${r3(dipIn)}` : "", dipOut ? `fade=t=out:st=${r3(c.duration - dipOut)}:d=${r3(dipOut)}` : ""].filter(Boolean).join(",");
        const label = `v${i}`;
        g.push(`${clipChain(c, k, [gr, gr ? "format=yuv420p" : "", fades].filter(Boolean).join(","))}[${label}]`);
        const overlap = i > 0 ? Math.max(0, pos - c.start) : 0;
        if (c.start > pos + 0.002) { const gl = `gap${i}`; g.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${r3(c.start - pos)},format=yuv420p,setsar=1,settb=AVTB[${gl}]`); segs.push({ label: gl, dur: c.start - pos, dissolve: 0 }); pos = c.start; }
        segs.push({ label, dur: c.duration, dissolve: overlap > 0.002 && c.transition.type === "dissolve" ? Math.min(overlap, c.transition.duration) : 0 });
        pos = end(c);
        if (info[k].hasAudio && !tracks.get(c.trackId)!.muted) audioItems.push({ k, c, track: c.trackId, role: "dialogue", embedded: true });
    }
    let cur = segs[0].label, curLen = segs[0].dur;
    for (const [i, sg] of segs.slice(1).entries()) {
        const o = `m${i}`;
        if (sg.dissolve > 0) { g.push(`[${cur}][${sg.label}]xfade=transition=fade:duration=${r3(sg.dissolve)}:offset=${r3(curLen - sg.dissolve)}[${o}]`); curLen += sg.dur - sg.dissolve; }
        else { g.push(`[${cur}][${sg.label}]concat=n=2:v=1:a=0[${o}]`); curLen += sg.dur; }
        cur = o;
    }
    let total = Math.max(curLen, ...e.clips.filter((c) => tracks.get(c.trackId)?.kind === "audio" && !tracks.get(c.trackId)!.muted).map(end));
    total = r3(Math.max(curLen, 0.1));
    // ---- overlay video tracks
    for (const [i, c] of overlays.entries()) {
        const k = await addInput(c, true);
        g.push(`${clipChain(c, k, "", true)}[ov${i}]`);
        g.push(`[${cur}][ov${i}]overlay=enable='between(t,${r3(c.start)},${r3(end(c))})':eof_action=pass[o${i}]`);
        cur = `o${i}`;
        if (info[k].hasAudio) audioItems.push({ k, c, track: c.trackId, role: "dialogue", embedded: true });
    }
    // ---- sequence grade + optional burned subtitles
    const post: string[] = [];
    if (e.grade && !isNeutral(e.grade)) post.push(gradeFilters(e.grade, lutFor(e.grade.lutCube)), "format=yuv420p");
    const subs = main.map((c) => ({ c, sh: c.shotId ? s.get("shots", c.shotId) : null })).filter((x) => x.sh?.subtitle);
    const srt = subs.map((x, i) => { const t = (n: number) => new Date(Math.round(n * 1000)).toISOString().slice(11, 23).replace(".", ","); return `${i + 1}\n${t(x.c.start)} --> ${t(end(x.c))}\n${x.sh!.subtitle}\n`; }).join("\n");
    if (opts.burnSubtitles && srt) {
        const filters = await runCmd("ffmpeg", ["-hide_banner", "-filters"]);
        if (!/\bsubtitles\b/.test(filters.out)) throw new Error("burn-in subtitles need an ffmpeg build with libass; use soft subtitles instead");
        const sf = join(dir, "burn.srt"); writeFileSync(sf, srt);
        post.push(`subtitles='${esc(sf)}'`);
    }
    g.push(`[${cur}]${post.length ? post.join(",") : "null"}[vout]`);

    // ---- audio: every audio clip + embedded audio of video clips, mixed per role bus
    for (const c of e.clips) {
        const tk = tracks.get(c.trackId)!;
        if (tk.kind !== "audio" || tk.muted) continue;
        const k = await addInput(c, false);
        if (!info[k].hasAudio) throw new Error(`audio clip "${c.label || c.id}" has no audio stream`);
        audioItems.push({ k, c, track: c.trackId, role: tk.role ?? "sfx", embedded: false });
    }
    const buses = new Map<string, string[]>();
    audioItems.forEach((a, i) => {
        const tk = tracks.get(a.track)!, c = a.c;
        const gain = c.gainDb + tk.gainDb, sp = c.speed, ms = Math.max(0, Math.round(c.start * 1000));
        const out = c.in + c.duration * sp;
        const f = [`atrim=start=${r3(c.in)}:end=${r3(out)}`, "asetpts=PTS-STARTPTS", ...atempo(sp), "aformat=sample_rates=48000:channel_layouts=stereo", gain ? `volume=${gain}dB` : "", c.fadeIn > 0 ? `afade=t=in:st=0:d=${r3(c.fadeIn)}` : "", c.fadeOut > 0 ? `afade=t=out:st=${r3(Math.max(0, c.duration - c.fadeOut))}:d=${r3(c.fadeOut)}` : "", `adelay=${ms}|${ms}`].filter(Boolean).join(",");
        g.push(`[${a.k}:a]${f}[a${i}]`);
        buses.set(a.role, [...(buses.get(a.role) ?? []), `a${i}`]);
    });
    let hasAudio = false;
    if (audioItems.length) {
        hasAudio = true;
        const bus = new Map<string, string>();
        for (const [role, ls] of buses) {
            const name = `bus_${role}`;
            g.push(ls.length > 1 ? `${ls.map((x) => `[${x}]`).join("")}amix=inputs=${ls.length}:normalize=0:duration=longest[${name}]` : `[${ls[0]}]anull[${name}]`);
            bus.set(role, name);
        }
        if (e.duck && bus.has(e.duck.underRole) && [...bus.keys()].some((r) => r !== e.duck!.underRole)) {
            // sidechain ducking: every other bus is compressed whenever the key bus (e.g. dialogue) is present
            const keyBus = bus.get(e.duck.underRole)!;
            const others = [...bus.keys()].filter((r) => r !== e.duck!.underRole);
            const ratio = Math.max(2, Math.min(20, Math.round(Math.abs(e.duck.amountDb) / 1.5)));
            g.push(`[${keyBus}]asplit=${others.length + 1}[${keyBus}_mix]${others.map((_, i) => `[${keyBus}_k${i}]`).join("")}`);
            bus.set(e.duck.underRole, `${keyBus}_mix`);
            others.forEach((r, i) => { const n = `${bus.get(r)}_duck`; g.push(`[${bus.get(r)}][${keyBus}_k${i}]sidechaincompress=threshold=0.04:ratio=${ratio}:attack=20:release=350:makeup=1[${n}]`); bus.set(r, n); });
        }
        const names = [...bus.values()];
        const norm = opts.normalizeAudio !== false ? `,loudnorm=I=${opts.targetLufs ?? -16}:TP=-1.5:LRA=11` : "";
        g.push(`${names.map((n) => `[${n}]`).join("")}amix=inputs=${names.length}:normalize=0:duration=longest,atrim=0:${total},asetpts=PTS-STARTPTS${norm},aformat=sample_rates=48000:channel_layouts=stereo[aout]`);
    }

    const args = ["-y", "-hide_banner", "-loglevel", "error", ...inputs.flat()];
    if (srt && !opts.burnSubtitles) { writeFileSync(join(dir, "soft.srt"), srt); args.push("-i", join(dir, "soft.srt")); }
    args.push("-filter_complex", g.join(";"), "-map", "[vout]"); // inline: -filter_complex_script was removed in ffmpeg 7
    if (hasAudio) args.push("-map", "[aout]");
    if (srt && !opts.burnSubtitles) args.push("-map", `${inputs.length}:0`, "-c:s", "mov_text");
    args.push("-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p", ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []), "-t", String(total), "-movflags", "+faststart", join(dir, "out.mp4"));
    const r = await runCmd("ffmpeg", args);
    if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.err.trim().split("\n").slice(-3).join(" | ").slice(-500)}`);
    return { file: join(dir, "out.mp4"), duration: total };
}

/** Integrated loudness / true peak / LRA of the most recent successful render (EBU R128 via loudnorm analysis). */
export async function audioReport(s: Scope, sequenceId: string) {
    const render = s.list("renders", { sequenceId }, "created_at DESC").find((r: any) => r.status === "SUCCEEDED" && r.mediaId) as any;
    if (!render) throw conflict("render the sequence first", "no_render");
    const m = s.get("media", render.mediaId);
    if (!m) throw conflict("render media is gone", "no_render");
    const dir = mkdtempSync(join(tmpdir(), "ovia-rep-"));
    try {
        const f = join(dir, "r.mp4");
        writeFileSync(f, await storage.get(m.storageKey));
        const p = await probeFile(f);
        if (!p?.hasAudio) throw conflict("the render has no audio track", "no_audio");
        const r = await runCmd("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
        const i = r.err.lastIndexOf("{"), k = r.err.lastIndexOf("}");
        if (i < 0 || k < i) throw bad("loudness analysis failed");
        const j = JSON.parse(r.err.slice(i, k + 1));
        return { renderId: render.id, integratedLufs: Number(j.input_i), truePeakDb: Number(j.input_tp), lra: Number(j.input_lra), thresholdDb: Number(j.input_thresh), duration: p.duration };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
void now;
