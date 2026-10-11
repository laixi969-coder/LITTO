import { z } from "zod";
import { all, get, run, tx, type Scope } from "../db.ts";
import { bad, conflict, forbidden, j, notFound, now, ulid } from "../util.ts";
import { mediaView } from "../storage.ts";
import { parseGrade, type Grade } from "./grade.ts";

/**
 * Editable multi-track timeline (PRD P3 "高级 NLE"). Persisted in `timelines.data`; derived `buildTimeline` (assembly.ts) stays the fallback.
 * Times are seconds. A clip occupies [start, start+duration) on the timeline and plays source [in, in+duration*speed).
 * An incoming `dissolve` of d seconds is the only way two clips on one track may overlap (by d). `fade_black` dips without overlap.
 */
export type Transition = { type: "cut" | "dissolve" | "fade_black"; duration: number };
export type Track = { id: string; kind: "video" | "audio"; name: string; role?: "dialogue" | "music" | "sfx"; muted: boolean; locked: boolean; gainDb: number };
export type EClip = { id: string; trackId: string; type: "shot" | "media"; shotId?: string; mediaId?: string; refId?: string; start: number; duration: number; in: number; speed: number; transition: Transition; gainDb: number; fadeIn: number; fadeOut: number; label: string; auto?: boolean; linkedClipId?: string; audioDetached?: boolean };
export type Marker = { id: string; t: number; label: string };
export type Duck = { underRole: "dialogue" | "music" | "sfx"; amountDb: number };
export type Body = { fps: number; tracks: Track[]; clips: EClip[]; markers: Marker[]; grade: Grade | null; duck: Duck | null };
export type EditRow = Body & { version: number; history: string[]; future: string[] };

const EPS = 1e-3, MIN_DUR = 0.1;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const body = (t: Body): Body => ({ fps: t.fps, tracks: t.tracks, clips: t.clips, markers: t.markers, grade: t.grade ?? null, duck: t.duck ?? null });
export const end = (c: EClip) => c.start + c.duration;

// ---------------------------------------------------------------- source resolution
export type Resolved = { kind: "take" | "hero" | "missing" | "media"; mediaId: string | null; mime: string | null; srcDuration: number | null; hasAudio?: boolean };
export function resolveClip(s: Scope, c: EClip): Resolved {
    if (c.type === "media") {
        const m = c.mediaId ? s.get("media", c.mediaId) : null;
        return { kind: "media", mediaId: m?.id ?? null, mime: m?.mime ?? null, srcDuration: m?.duration ?? null };
    }
    const sh = c.shotId ? s.get("shots", c.shotId) : null;
    const take = sh?.approvedTakeId ? s.get("takes", sh.approvedTakeId) : null;
    const hero = !take && sh?.heroKeyframeId ? s.get("keyframes", sh.heroKeyframeId) : null;
    const mid = c.mediaId ?? take?.mediaId ?? hero?.mediaId ?? null;
    const m = mid ? s.get("media", mid) : null;
    return { kind: c.mediaId && m ? "media" : take ? "take" : hero ? "hero" : "missing", mediaId: mid, mime: m?.mime ?? null, srcDuration: m?.duration ?? null };
}

// ---------------------------------------------------------------- conform
const defaultTracks = (): Track[] => [
    { id: "V1", kind: "video", name: "V1", muted: false, locked: false, gainDb: 0 },
    { id: "A1", kind: "audio", name: "A1 对白/现场", role: "dialogue", muted: false, locked: false, gainDb: 0 },
    { id: "A2", kind: "audio", name: "A2 音乐", role: "music", muted: false, locked: false, gainDb: 0 },
    { id: "A3", kind: "audio", name: "A3 音效", role: "sfx", muted: false, locked: false, gainDb: 0 },
];
const newClip = (p: Partial<EClip> & Pick<EClip, "trackId" | "type" | "start" | "duration">): EClip => ({ id: ulid(), in: 0, speed: 1, transition: { type: "cut", duration: 0 }, gainDb: 0, fadeIn: 0, fadeOut: 0, label: "", ...p });

/** Build / refresh the timeline from the production data. Manual edits survive unless `reset`. */
export function conformBody(s: Scope, sequenceId: string, prev: Body | null, reset: boolean): Body {
    const shots = s.list("shots", { sequenceId }, "ord");
    const bindings = s.list("reference_bindings", { targetType: "shot" }).filter((b: any) => b.role === "AUDIO");
    const base: Body = !prev || reset ? { fps: 24, tracks: defaultTracks(), clips: [], markers: [], grade: prev && !reset ? prev.grade : null, duck: null } : structuredClone(prev);
    const have = new Set(base.clips.filter((c) => c.shotId).map((c) => c.shotId));
    const live = new Set(shots.map((x) => x.id));
    // drop clips of deleted shots; drop auto audio whose binding disappeared
    base.clips = base.clips.filter((c) => (c.type === "shot" ? live.has(c.shotId!) : !(c.auto && c.refId && !bindings.some((b: any) => `${b.targetId}:${b.referenceId}` === c.refId))));
    const manualV1 = base.clips.some((c) => c.trackId === "V1" && !c.auto);
    const v1 = (id: string) => base.clips.find((c) => c.type === "shot" && c.shotId === id);
    let t = reset || !manualV1 ? 0 : Math.max(0, ...base.clips.filter((c) => c.trackId === "V1").map(end));
    if (!manualV1) base.clips = base.clips.filter((c) => c.type !== "shot"); // pure-auto timeline: re-lay everything in shot order
    for (const sh of shots) {
        if (!manualV1 || !have.has(sh.id)) {
            const dur = Number(sh.duration ?? 4);
            base.clips.push(newClip({ trackId: "V1", type: "shot", shotId: sh.id, start: r3(t), duration: dur, label: sh.title ?? "", auto: true }));
            t += dur;
        }
    }
    // A1 from AUDIO-role bindings, aligned to the shot clip
    for (const b of bindings) {
        const key = `${b.targetId}:${b.referenceId}`;
        const sc = v1(b.targetId) ?? base.clips.find((c) => c.type === "shot" && c.shotId === b.targetId);
        const ref = s.get("refs", b.referenceId);
        if (!sc || !ref?.mediaId || base.clips.some((c) => c.refId === key)) continue;
        const m = s.get("media", ref.mediaId);
        base.clips.push(newClip({ trackId: "A1", type: "media", mediaId: ref.mediaId, refId: key, start: sc.start, duration: Math.min(sc.duration, m?.duration ?? sc.duration), label: ref.name ?? "audio", auto: true }));
    }
    return base;
}

// ---------------------------------------------------------------- persistence
const rowOf = (s: Scope, sequenceId: string): EditRow | null => {
    const r: any = s.list("timelines", { sequenceId })[0];
    if (!r) return null;
    return { fps: r.fps, tracks: r.tracks, clips: r.clips, markers: r.markers ?? [], grade: r.grade ?? null, duck: r.duck ?? null, history: r.history ?? [], future: r.future ?? [], version: r.version };
};
export const hasEdit = (s: Scope, sequenceId: string) => !!rowOf(s, sequenceId);

function save(s: Scope, seq: any, row: EditRow, create: boolean) {
    const data = { ...body(row), history: row.history, future: row.future };
    if (create) s.insert("timelines", { project_id: seq.projectId, sequence_id: seq.id, data, version: row.version, updated_at: now() });
    else run("UPDATE timelines SET data=?, version=?, updated_at=? WHERE sequence_id=? AND workspace_id=?", j(data), row.version, now(), seq.id, s.workspaceId);
}

/** Read the editable timeline. Without a stored one it is conformed on the fly; `persist` stores it (EDITOR+). */
export function getEdit(s: Scope, sequenceId: string, persist: boolean): EditRow {
    const seq = s.get("sequences", sequenceId);
    if (!seq) throw notFound("sequence");
    const ex = rowOf(s, sequenceId);
    if (ex) return ex;
    const row: EditRow = { ...conformBody(s, sequenceId, null, true), version: persist ? 1 : 0, history: [], future: [] };
    if (persist) save(s, seq, row, true);
    return row;
}

export function conform(s: Scope, sequenceId: string, reset: boolean) {
    const seq = s.get("sequences", sequenceId);
    if (!seq) throw notFound("sequence");
    const ex = rowOf(s, sequenceId);
    const next: EditRow = ex ? { ...conformBody(s, sequenceId, body(ex), reset), version: ex.version + 1, history: [...ex.history, JSON.stringify(body(ex))].slice(-50), future: [] } : { ...conformBody(s, sequenceId, null, true), version: 1, history: [], future: [] };
    return tx(() => (save(s, seq, next, !ex), next));
}

// ---------------------------------------------------------------- ops
const num = z.number().finite();
const tr = z.object({ type: z.enum(["cut", "dissolve", "fade_black"]), duration: num.min(0).max(10) });
const clipIn = z.object({ trackId: z.string(), type: z.enum(["shot", "media"]), shotId: z.string().optional(), mediaId: z.string().optional(), start: num.min(0), duration: num.optional(), in: num.min(0).default(0), speed: num.min(0.25).max(4).default(1), transition: tr.optional(), gainDb: num.min(-60).max(24).default(0), fadeIn: num.min(0).default(0), fadeOut: num.min(0).default(0), label: z.string().default("") });
export const opSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("set_cut"), leftId: z.string(), rightId: z.string(), sourceOut: num.nonnegative(), sourceIn: num.nonnegative(), leftMediaId: z.string().optional(), rightMediaId: z.string().optional() }),
    z.object({ type: z.literal("bridge_audio"), leftId: z.string(), rightId: z.string(), mode: z.enum(["jCut", "lCut", "crossfade", "none"]), duration: num.min(0).max(3) }),
    z.object({ type: z.literal("map_segments"), mediaId: z.string(), segments: z.array(z.object({ shotId: z.string(), in: num.nonnegative(), out: num.positive() })).min(1).max(100) }),
    z.object({ type: z.literal("add_clip"), clip: clipIn }),
    z.object({ type: z.literal("move_clip"), id: z.string(), start: num.min(0).optional(), trackId: z.string().optional() }),
    z.object({ type: z.literal("trim_clip"), id: z.string(), in: num.min(0).optional(), out: num.optional(), start: num.min(0).optional(), duration: num.optional(), ripple: z.boolean().default(false) }),
    z.object({ type: z.literal("split_clip"), id: z.string(), at: num }),
    z.object({ type: z.literal("delete_clip"), id: z.string(), ripple: z.boolean().default(false) }),
    z.object({ type: z.literal("set_transition"), id: z.string(), transition: tr }),
    z.object({ type: z.literal("set_gain"), id: z.string(), gainDb: num.min(-60).max(24).optional(), fadeIn: num.min(0).optional(), fadeOut: num.min(0).optional() }),
    z.object({ type: z.literal("set_speed"), id: z.string(), speed: num.min(0.25).max(4) }),
    z.object({ type: z.literal("add_track"), kind: z.enum(["video", "audio"]), name: z.string().optional(), role: z.enum(["dialogue", "music", "sfx"]).optional() }),
    z.object({ type: z.literal("update_track"), id: z.string(), name: z.string().optional(), role: z.enum(["dialogue", "music", "sfx"]).optional(), muted: z.boolean().optional(), locked: z.boolean().optional(), gainDb: num.min(-60).max(24).optional() }),
    z.object({ type: z.literal("add_marker"), t: num.min(0), label: z.string().default("") }),
    z.object({ type: z.literal("remove_marker"), id: z.string() }),
    z.object({ type: z.literal("reorder"), shotIdA: z.string(), shotIdB: z.string() }),
    z.object({ type: z.literal("set_duck"), duck: z.object({ underRole: z.enum(["dialogue", "music", "sfx"]), amountDb: num.min(-40).max(-1) }).nullable() }),
    z.object({ type: z.literal("set_sequence_grade"), grade: z.any().nullable() }),
]);
export type Op = z.infer<typeof opSchema>;

const sameTrack = (t: Body, c: EClip) => t.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id).sort((a, b) => a.start - b.start);
const findClip = (t: Body, id: string) => { const c = t.clips.find((x) => x.id === id); if (!c) throw notFound(`clip ${id}`); return c; };
const findTrack = (t: Body, id: string) => { const x = t.tracks.find((y) => y.id === id); if (!x) throw notFound(`track ${id}`); return x; };
const unlocked = (t: Body, trackId: string) => { if (findTrack(t, trackId).locked) throw forbidden(`track ${trackId} is locked`); };
const shiftLater = (t: Body, c: EClip, delta: number, from = end(c)) => { for (const x of t.clips) if (x.trackId === c.trackId && x.id !== c.id && x.start >= from - EPS) x.start = r3(Math.max(0, x.start + delta)); };

/** Re-derive start so that a clip overlaps its predecessor by exactly the transition (dissolve) duration; later clips on the track follow. */
function applyTransition(t: Body, c: EClip, tr0: Transition) {
    const prev = sameTrack(t, c).filter((x) => x.start < c.start - EPS).pop();
    if (tr0.type !== "cut" && !prev) throw bad("a transition needs a previous clip on the same track");
    const oldOverlap = prev ? Math.max(0, end(prev) - c.start) : 0;
    const maxD = prev ? Math.min(prev.duration, c.duration) - EPS : 0;
    if (tr0.type !== "cut" && tr0.duration > maxD) throw bad(`transition duration ${tr0.duration}s exceeds the shorter neighbouring clip`);
    const newOverlap = tr0.type === "dissolve" ? tr0.duration : 0;
    const delta = r3(oldOverlap - newOverlap); // positive: move right
    const oldEnd = end(c);
    c.transition = { type: tr0.type, duration: tr0.type === "cut" ? 0 : r3(tr0.duration) };
    if (prev && Math.abs(delta) > EPS) { c.start = r3(c.start + delta); shiftLater(t, c, delta, oldEnd - EPS); }
}

function validate(s: Scope, t: Body) {
    for (const c of t.clips) {
        const tk = t.tracks.find((x) => x.id === c.trackId);
        if (!tk) throw bad(`clip ${c.id} is on a missing track`);
        if (c.duration < MIN_DUR - EPS) throw bad(`clip duration must be ≥ ${MIN_DUR}s`);
        if (!Number.isFinite(c.in) || c.in < 0) throw bad("素材入点不能小于零");
        if (c.start < -EPS) throw bad("clip cannot start before 0");
        const src = resolveClip(s, c);
        if (tk.kind === "video" && c.type === "media" && src.mime && !src.mime.startsWith("video/") && !src.mime.startsWith("image/")) throw bad(`clip ${c.id}: ${src.mime} cannot go on a video track`);
        if (tk.kind === "audio" && (c.type !== "media" || (src.mime && !/^(audio|video)\//.test(src.mime)))) throw bad(`clip ${c.id}: only audio media can go on an audio track`);
        if (src.srcDuration != null && c.in + c.duration * c.speed > src.srcDuration + 0.05) throw bad(`clip ${c.id}: trim exceeds the source duration (${src.srcDuration.toFixed(2)}s)`, { max: src.srcDuration });
    }
    for (const tk of t.tracks) {
        const list = t.clips.filter((c) => c.trackId === tk.id).sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i++) {
            const overlap = end(list[i - 1]) - list[i].start;
            if (overlap > EPS) {
                const tr0 = list[i].transition;
                if (tk.kind === "video" && tr0.type === "dissolve" && overlap <= tr0.duration + EPS) continue;
                if (tk.kind === "audio") continue; // audio may layer on a track (crossfades are done with fades)
                throw conflict(`clips overlap on track ${tk.id} (${list[i - 1].label || list[i - 1].id} / ${list[i].label || list[i].id}) without a dissolve`, "overlap");
            }
        }
    }
}

export function adjacentClips(t: Body, leftId: string, rightId: string) {
    const left = findClip(t, leftId), right = findClip(t, rightId);
    const track = findTrack(t, left.trackId);
    if (track.kind !== "video" || right.trackId !== left.trackId) throw bad("请选择同一视频轨的相邻片段");
    const list = t.clips.filter(c => c.trackId === left.trackId).sort((a, b) => a.start - b.start);
    if (list[list.indexOf(left) + 1]?.id !== right.id) throw bad("片段不相邻，请刷新时间线");
    return { left, right };
}

function detachAudio(s: Scope, t: Body, clip: EClip) {
    const source = resolveClip(s, clip);
    if (!source.mediaId || !source.mime?.startsWith("video/")) throw bad("片段没有可用的视频音轨");
    let track = t.tracks.find(item => item.kind === "audio" && item.role === "dialogue" && !item.locked);
    if (!track) { track = { id: ulid(), kind: "audio", name: "对白与现场声", role: "dialogue", muted: false, locked: false, gainDb: 0 }; t.tracks.push(track); }
    const existing = t.clips.find(item => item.linkedClipId === clip.id);
    if (existing) { unlocked(t, existing.trackId); t.clips = t.clips.filter(item => item.id !== existing.id); }
    const audio = newClip({ trackId: track.id, type: "media", mediaId: source.mediaId, linkedClipId: clip.id, start: clip.start, duration: clip.duration, in: clip.in, speed: clip.speed, label: clip.label, gainDb: clip.gainDb, auto: false });
    clip.mediaId = source.mediaId; clip.audioDetached = true; clip.auto = false; t.clips.push(audio);
    return audio;
}

function apply(s: Scope, t: Body, op: Op) {
    switch (op.type) {
        case "set_cut": {
            const { left, right } = adjacentClips(t, op.leftId, op.rightId);
            unlocked(t, left.trackId);
            if (right.transition.type !== "cut" || Math.abs(end(left) - right.start) > EPS) throw bad("先将相邻片段设为连续硬切，再调整剪点");
            if ((op.leftMediaId && resolveClip(s, left).mediaId !== op.leftMediaId) || (op.rightMediaId && resolveClip(s, right).mediaId !== op.rightMediaId)) throw conflict("源素材已更换，请刷新剪点候选", "stale");
            const oldEnd = end(right);
            const rightOut = right.in + right.duration * right.speed;
            left.duration = r3((op.sourceOut - left.in) / left.speed);
            right.in = r3(op.sourceIn); right.duration = r3((rightOut - right.in) / right.speed);
            right.start = r3(end(left)); left.auto = false; right.auto = false;
            shiftLater(t, right, r3(end(right) - oldEnd), oldEnd - EPS);
            return;
        }
        case "bridge_audio": {
            const { left, right } = adjacentClips(t, op.leftId, op.rightId);
            unlocked(t, left.trackId);
            if (right.transition.type !== "cut" || Math.abs(end(left) - right.start) > EPS) throw bad("声音桥要求连续硬切；溶解可在独立音轨手动淡化");
            const a = detachAudio(s, t, left), b = detachAudio(s, t, right);
            const d = op.mode === "none" ? 0 : op.duration;
            if (d >= Math.min(a.duration, b.duration) - MIN_DUR) throw bad("声音桥超过相邻片段可用时长");
            if (op.mode === "jCut" || op.mode === "crossfade") {
                b.start = r3(b.start - d); b.in = r3(b.in - d * b.speed); b.duration = r3(b.duration + d);
                if (op.mode === "jCut") a.duration = r3(a.duration - d);
            }
            if (op.mode === "lCut") {
                a.duration = r3(a.duration + d); b.start = r3(b.start + d); b.in = r3(b.in + d * b.speed); b.duration = r3(b.duration - d);
            }
            a.fadeOut = op.mode === "crossfade" ? d : Math.min(0.01, a.duration / 2);
            b.fadeIn = op.mode === "crossfade" ? d : Math.min(0.01, b.duration / 2);
            return;
        }
        case "map_segments": {
            const media = s.get("media", op.mediaId);
            if (!media?.mime.startsWith("video/") || !media.duration) throw bad("请选择有真实时长的视频素材");
            const track = t.tracks.find(item => item.kind === "video");
            if (!track) throw bad("缺少视频轨");
            unlocked(t, track.id);
            const replaced = new Set(t.clips.filter(c => c.trackId === track.id).map(c => c.id));
            const removed = t.clips.filter(c => replaced.has(c.id) || (c.linkedClipId && replaced.has(c.linkedClipId)) || (c.auto && c.refId));
            for (const c of removed) unlocked(t, c.trackId);
            t.clips = t.clips.filter(c => !removed.includes(c));
            let start = 0;
            for (const segment of op.segments) {
                if (segment.out <= segment.in || segment.out > media.duration + EPS) throw bad("分段区间无效或超出素材");
                const shot = s.get("shots", segment.shotId);
                if (!shot) throw notFound("shot");
                const duration = r3(segment.out - segment.in);
                t.clips.push(newClip({ trackId: track.id, type: "media", mediaId: media.id, shotId: shot.id, start: r3(start), duration, in: segment.in, label: shot.title, auto: false }));
                start += duration;
            }
            return;
        }
        case "add_clip": {
            const k = op.clip;
            unlocked(t, k.trackId);
            if (k.type === "shot") { if (!k.shotId || !s.get("shots", k.shotId)) throw notFound("shot"); }
            else if (!k.mediaId || !s.get("media", k.mediaId)) throw notFound("media");
            const sh = k.shotId ? s.get("shots", k.shotId) : null;
            const m = k.mediaId ? s.get("media", k.mediaId) : null;
            const dur = k.duration ?? (k.type === "shot" ? Number(sh?.duration ?? 4) : m?.duration ?? 4);
            const c = newClip({ trackId: k.trackId, type: k.type, shotId: k.shotId, mediaId: k.mediaId, start: r3(k.start), duration: r3(dur), in: k.in, speed: k.speed, gainDb: k.gainDb, fadeIn: k.fadeIn, fadeOut: k.fadeOut, label: k.label || sh?.title || "" });
            t.clips.push(c);
            if (k.transition && k.transition.type !== "cut") applyTransition(t, c, k.transition);
            return;
        }
        case "move_clip": {
            const c = findClip(t, op.id);
            unlocked(t, c.trackId);
            if (op.trackId && op.trackId !== c.trackId) { unlocked(t, op.trackId); if (findTrack(t, op.trackId).kind !== findTrack(t, c.trackId).kind) throw bad("cannot move a clip between video and audio tracks"); c.trackId = op.trackId; }
            if (op.start !== undefined) c.start = r3(op.start);
            c.auto = false;
            return;
        }
        case "trim_clip": {
            const c = findClip(t, op.id);
            unlocked(t, c.trackId);
            const oldDur = c.duration, oldEnd = end(c);
            let inn = op.in ?? c.in, start = op.start ?? c.start, dur = op.duration ?? c.duration;
            if (op.out !== undefined) dur = (op.out - inn) / c.speed;
            // trimming the head with `in` only (no explicit start/duration) keeps the tail fixed and moves the head: classic edge trim
            if (op.in !== undefined && op.start === undefined && op.duration === undefined && op.out === undefined) { const dIn = inn - c.in; dur = c.duration - dIn / c.speed; start = c.start + dIn / c.speed; }
            c.in = r3(inn); c.start = r3(start); c.duration = r3(dur); c.auto = false;
            if (op.ripple) shiftLater(t, c, r3(c.duration - oldDur), oldEnd - EPS);
            return;
        }
        case "split_clip": {
            const c = findClip(t, op.id);
            unlocked(t, c.trackId);
            // ACT: 独立声桥保留自己的入出点；分割前需移除关联声音，避免复制出错误的关联关系。
            if (c.linkedClipId || t.clips.some((x) => x.linkedClipId === c.id)) throw bad("请先移除关联声音片段，再分割画面");
            if (op.at < c.start + MIN_DUR - EPS || op.at > end(c) - MIN_DUR + EPS) throw bad(`split point must be inside the clip with ≥ ${MIN_DUR}s on each side`);
            const first = op.at - c.start;
            const b = newClip({ ...c, id: ulid(), start: r3(op.at), duration: r3(c.duration - first), in: r3(c.in + first * c.speed), transition: { type: "cut", duration: 0 }, fadeIn: 0, auto: false });
            c.duration = r3(first); c.fadeOut = 0; c.auto = false;
            t.clips.push(b);
            return;
        }
        case "delete_clip": {
            const c = findClip(t, op.id);
            unlocked(t, c.trackId);
            t.clips = t.clips.filter((x) => x.id !== c.id);
            if (op.ripple) shiftLater(t, c, -c.duration, end(c) - EPS);
            return;
        }
        case "set_transition": {
            const c = findClip(t, op.id);
            unlocked(t, c.trackId);
            if (findTrack(t, c.trackId).kind !== "video") throw bad("transitions apply to video tracks");
            applyTransition(t, c, op.transition);
            c.auto = false;
            return;
        }
        case "set_gain": {
            const c = findClip(t, op.id);
            unlocked(t, c.trackId);
            if (op.gainDb !== undefined) c.gainDb = op.gainDb;
            if (op.fadeIn !== undefined) c.fadeIn = Math.min(op.fadeIn, c.duration);
            if (op.fadeOut !== undefined) c.fadeOut = Math.min(op.fadeOut, c.duration);
            return;
        }
        case "set_speed": {
            const c = findClip(t, op.id);
            unlocked(t, c.trackId);
            if (c.linkedClipId || t.clips.some((x) => x.linkedClipId === c.id)) throw bad("请先移除关联声音片段，再调整速度");
            const span = c.duration * c.speed; // source span stays, timeline length changes
            c.speed = op.speed; c.duration = r3(span / op.speed); c.auto = false;
            return;
        }
        case "add_track": {
            const n = t.tracks.filter((x) => x.kind === op.kind).length + 1;
            const id = `${op.kind === "video" ? "V" : "A"}${n}`;
            t.tracks.push({ id: t.tracks.some((x) => x.id === id) ? `${id}-${ulid().slice(-4)}` : id, kind: op.kind, name: op.name ?? id, role: op.kind === "audio" ? op.role ?? "sfx" : undefined, muted: false, locked: false, gainDb: 0 });
            return;
        }
        case "update_track": {
            const tk = findTrack(t, op.id);
            if (tk.locked && op.locked !== false) throw forbidden(`track ${tk.id} is locked`);
            for (const k of ["name", "role", "muted", "locked", "gainDb"] as const) if (op[k] !== undefined) (tk as any)[k] = op[k];
            return;
        }
        case "add_marker": t.markers.push({ id: ulid(), t: r3(op.t), label: op.label }); return;
        case "remove_marker": { const n = t.markers.length; t.markers = t.markers.filter((m) => m.id !== op.id); if (t.markers.length === n) throw notFound("marker"); return; }
        case "reorder": {
            const v1 = t.clips.filter((c) => c.trackId === "V1" && c.type === "shot").sort((a, b) => a.start - b.start);
            unlocked(t, "V1");
            const a = v1.find((c) => c.shotId === op.shotIdA), b = v1.find((c) => c.shotId === op.shotIdB);
            if (!a || !b) throw notFound("shot clip on V1");
            const list = t.clips.filter((c) => c.trackId === "V1").sort((x, y) => x.start - y.start);
            const ia = list.indexOf(a), ib = list.indexOf(b);
            [list[ia], list[ib]] = [list[ib], list[ia]];
            // re-pack V1 contiguously (dissolves keep their overlap); audio that was tied to a swapped shot follows it
            let pos = 0;
            for (const c of list) { const ov = c.transition.type === "dissolve" ? c.transition.duration : 0; c.start = r3(Math.max(0, pos - ov)); pos = end(c); c.auto = false; }

            return;
        }
        case "set_duck": t.duck = op.duck; return;
        case "set_sequence_grade": t.grade = op.grade === null ? null : parseGrade(op.grade); return;
    }
}

export function applyOps(s: Scope, sequenceId: string, ops: unknown[], expectedVersion: number | undefined) {
    const seq = s.get("sequences", sequenceId);
    if (!seq) throw notFound("sequence");
    const parsed = ops.map((o, i) => { const r = opSchema.safeParse(o); if (!r.success) throw bad(`op #${i + 1} invalid`, r.error.issues.map((x) => ({ path: x.path.join("."), message: x.message }))); return r.data; });
    if (!parsed.length) throw bad("no ops");
    const ex = rowOf(s, sequenceId);
    const cur: EditRow = ex ?? { ...conformBody(s, sequenceId, null, true), version: 0, history: [], future: [] };
    if (expectedVersion !== undefined && expectedVersion !== cur.version) throw conflict(`timeline changed (version ${cur.version}, you had ${expectedVersion})`, "stale", { version: cur.version });
    const work: Body = structuredClone(body(cur));
    parsed.forEach((op, i) => {
        try {
            const before = new Map(work.clips.map(c => [c.id, { ...c }]));
            apply(s, work, op);
            if (op.type === "bridge_audio" || op.type === "map_segments") return;
            for (const audio of work.clips.filter(c => c.linkedClipId || c.refId)) {
                const parent = audio.linkedClipId ? work.clips.find(c => c.id === audio.linkedClipId) : work.clips.find(c => c.type === "shot" && c.shotId === audio.refId?.split(":")[0]);
                const old = parent && before.get(parent.id);
                if (!parent && audio.linkedClipId) { unlocked(work, audio.trackId); work.clips = work.clips.filter(c => c.id !== audio.id); continue; }
                if (!parent || !old || !before.has(audio.id)) continue;
                const delta = parent.start - parent.in / parent.speed - (old.start - old.in / old.speed);
                if (Math.abs(delta) > EPS) { unlocked(work, audio.trackId); audio.start = r3(audio.start + delta); }
            }
        } catch (e: any) { e.message = `op #${i + 1} (${op.type}): ${e.message}`; throw e; }
    });
    for (const clip of work.clips) {
        const mediaId = resolveClip(s, clip).mediaId;
        if (mediaId && s.get("media", mediaId)?.projectId !== seq.projectId) throw bad("素材不属于当前项目");
        if (clip.shotId && s.get("shots", clip.shotId)?.sequenceId !== sequenceId) throw bad("镜头不属于当前序列");
    }
    validate(s, work);
    const next: EditRow = { ...work, version: cur.version + 1, history: [...cur.history, JSON.stringify(body(cur))].slice(-50), future: [] };
    // a never-persisted timeline is created at version 1 with the pre-edit state as its first undo step
    return tx(() => (save(s, seq, next, !ex), next));
}

export function undoRedo(s: Scope, sequenceId: string, dir: "undo" | "redo") {
    const seq = s.get("sequences", sequenceId);
    const ex = rowOf(s, sequenceId);
    if (!seq || !ex) throw notFound("timeline");
    const from = dir === "undo" ? ex.history : ex.future;
    if (!from.length) throw conflict(`nothing to ${dir}`, "empty_history");
    const snap: Body = JSON.parse(from[from.length - 1]);
    const here = JSON.stringify(body(ex));
    const next: EditRow = { ...snap, version: ex.version + 1, history: dir === "undo" ? ex.history.slice(0, -1) : [...ex.history, here].slice(-50), future: dir === "undo" ? [...ex.future, here] : ex.future.slice(0, -1) };
    return tx(() => (save(s, seq, next, false), next));
}

/** API view: resolved sources next to each clip, history stripped to depths. */
export function editView(s: Scope, row: EditRow) {
    return { version: row.version, fps: row.fps, tracks: row.tracks, markers: row.markers, grade: row.grade ? { ...row.grade, lutCube: row.grade.lutCube ? "(cube)" : undefined } : null, duck: row.duck, historyDepth: row.history.length, futureDepth: row.future.length, duration: Math.max(0, ...row.clips.map(end)),
        clips: row.clips.map((c) => { const r = resolveClip(s, c); const sh = c.shotId ? s.get("shots", c.shotId) : null; return { ...c, out: r3(c.in + c.duration * c.speed), source: { kind: r.kind, mediaId: r.mediaId, mime: r.mime, srcDuration: r.srcDuration, media: r.mediaId ? mediaView(s.get("media", r.mediaId)) : null }, shotOrder: sh?.ord ?? null, subtitle: sh?.subtitle ?? "", grade: sh?.grade ?? null }; }) };
}
void all; void get; void forbidden;

/** 显式选入工作版，不把创作选择冒充完整技术验收。 */
export function selectWorkingTake(s: Scope, takeId: string) {
  const take = s.get("takes", takeId);
  const shot = take && s.get("shots", take.shotId);
  const media = take && s.get("media", take.mediaId);
  if (!take || !shot || !media || take.projectId !== shot.projectId || media.projectId !== shot.projectId || !media.mime.startsWith("video/")) throw bad("视频不属于当前镜头");
  const edit = getEdit(s, shot.sequenceId, true);
  const clip = edit.clips.find(clip => clip.shotId === shot.id && edit.tracks.find(track => track.id === clip.trackId)?.kind === "video");
  if (!clip) throw bad("镜头没有可替换的剪辑片段");
  if (clip.mediaId === media.id) return edit;
  if (clip.audioDetached || edit.clips.some(audio => audio.linkedClipId === clip.id)) throw bad("该镜头已有独立声音剪辑，请通过剪辑操作替换素材，保留声音接点");
  return applyOps(s, shot.sequenceId, [
    { type: "delete_clip", id: clip.id, ripple: false },
    { type: "add_clip", clip: { trackId: clip.trackId, type: "shot", shotId: shot.id, mediaId: media.id, start: clip.start, duration: clip.duration, in: clip.in, speed: clip.speed, transition: clip.transition, gainDb: clip.gainDb, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, label: clip.label } },
  ], edit.version);
}
