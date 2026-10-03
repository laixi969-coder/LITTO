import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ovia-nle-test-"));
const has = (c: string) => spawnSync(c, ["-version"]).status === 0;
const FF = has("ffmpeg") && has("ffprobe");
Object.assign(process.env, { OVIA_DATA_DIR: dir, OVIA_QUIET: "1", OVIA_MOCK_LATENCY_MS: "10", OVIA_WORKER_POLL_MS: "30", OVIA_NO_RATELIMIT: "1", NODE_ENV: "test", OVIA_NO_DERIVATIVES: "1" });

const { app } = await import("../src/app.ts");
const { startWorker, stopWorker } = await import("../src/jobs.ts");
const { seedProviders } = await import("../src/providers/registry.ts");
const { db } = await import("../src/db.ts");
seedProviders();
before(() => startWorker());
after(() => { stopWorker(); rmSync(dir, { recursive: true, force: true }); });

type Who = { token: string };
async function call(who: Who | null, method: string, path: string, body?: unknown) {
    const res = await app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any; try { json = JSON.parse(buf.toString()); } catch { json = buf.toString(); }
    return { status: res.status, json, buf };
}
const ok = async (who: Who | null, m: string, p: string, b?: unknown) => { const r = await call(who, m, p, b); assert.ok(r.status < 300, `${m} ${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`); return r.json; };
async function login(email: string): Promise<Who> {
    const { devCode } = await ok(null, "POST", "/auth/request-code", { email });
    return { token: (await ok(null, "POST", "/auth/verify", { email, code: devCode, client: "api" })).token };
}
const sh = (cmd: string) => execSync(cmd, { stdio: "pipe" });
const ffprobe = (file: string) => JSON.parse(execSync(`ffprobe -v error -show_streams -show_format -of json "${file}"`).toString());

const S: any = {};
const edit = async () => ok(S.u, "GET", `/sequences/${S.seq.id}/edit`);
const ops = async (o: any[], version?: number) => ok(S.u, "POST", `/sequences/${S.seq.id}/edit/ops`, { ops: o, expectedVersion: version });
const opsRaw = (o: any[], version?: number) => call(S.u, "POST", `/sequences/${S.seq.id}/edit/ops`, { ops: o, expectedVersion: version });
const v1 = (e: any) => e.clips.filter((c: any) => c.trackId === "V1").sort((a: any, b: any) => a.start - b.start);

async function upload(file: string, mime?: string) {
    const res = await app.request(`/media?projectId=${S.p.id}`, { method: "POST", headers: { authorization: `Bearer ${S.u.token}` }, body: new Uint8Array(readFileSync(file)) });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    return JSON.parse(text) as any;
}
function makeMedia() {
    // 3s video with audio, 3s video without audio (different pattern), 2s video w/o audio, 6s music, 4s dialogue
    sh(`ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x360:rate=25:duration=3 -f lavfi -i sine=frequency=500:duration=3 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ${dir}/a.mp4`);
    sh(`ffmpeg -y -loglevel error -f lavfi -i smptebars=size=480x270:rate=30:duration=3 -c:v libx264 -pix_fmt yuv420p ${dir}/b.mp4`);
    sh(`ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=640x360:rate=25:duration=2 -c:v libx264 -pix_fmt yuv420p ${dir}/c.mp4`);
    sh(`ffmpeg -y -loglevel error -f lavfi -i sine=frequency=440:duration=6 ${dir}/music.wav`);
    sh(`ffmpeg -y -loglevel error -f lavfi -i sine=frequency=880:duration=4 ${dir}/dlg.wav`);
}

test("setup: project, 3 shots with approved real-video takes; media duration is probed", { skip: !FF }, async () => {
    makeMedia();
    S.u = await login("cutter@example.com");
    S.p = await ok(S.u, "POST", "/projects", { name: "NLE" });
    S.seq = await ok(S.u, "POST", `/projects/${S.p.id}/sequences`, { name: "Cut" });
    const ws = (await ok(S.u, "GET", "/workspaces/current")).id;
    S.media = { a: await upload(`${dir}/a.mp4`), b: await upload(`${dir}/b.mp4`), c: await upload(`${dir}/c.mp4`), music: await upload(`${dir}/music.wav`), dlg: await upload(`${dir}/dlg.wav`) };
    assert.ok(Math.abs((await ok(S.u, "GET", `/media/${S.media.a.id}`)).duration - 3) < 0.2, "ffprobe duration stored");
    S.shots = [];
    for (const [i, [d, m]] of [[3, "a"], [3, "b"], [2, "c"]].entries() as any) {
        const shot = await ok(S.u, "POST", `/projects/${S.p.id}/shots`, { sequenceId: S.seq.id, title: `S${i + 1}`, duration: d, subtitle: i === 0 ? "Hello there" : "" });
        const id = `take${i}`;
        db.prepare("INSERT INTO takes(id,workspace_id,project_id,shot_id,media_id,status,meta,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, ws, S.p.id, shot.id, S.media[m].id, "approved", "{}", new Date().toISOString());
        db.prepare("UPDATE shots SET approved_take_id=?, status='approved' WHERE id=?").run(id, shot.id);
        S.shots.push(shot);
    }
});

test("conform builds V1 + audio tracks; the public timeline reflects it; tenants are isolated", { skip: !FF }, async () => {
    const e = await edit();
    assert.deepEqual(e.tracks.map((t: any) => t.id), ["V1", "A1", "A2", "A3"]);
    assert.deepEqual(v1(e).map((c: any) => [c.start, c.duration, c.source.kind]), [[0, 3, "take"], [3, 3, "take"], [6, 2, "take"]]);
    assert.equal(e.version, 1);
    const tl = await ok(S.u, "GET", `/sequences/${S.seq.id}/timeline`);
    assert.equal(tl.edited, true);
    assert.deepEqual(tl.clips.map((c: any) => [c.start, c.duration, c.kind]), [[0, 3, "take"], [3, 3, "take"], [6, 2, "take"]]);
    assert.equal(tl.duration, 8);
    const other = await login("other-nle@example.com");
    assert.equal((await call(other, "GET", `/sequences/${S.seq.id}/edit`)).status, 404);
    assert.equal((await call(other, "POST", `/sequences/${S.seq.id}/edit/ops`, { ops: [{ type: "add_marker", t: 1 }] })).status, 404);
    assert.equal((await call(null, "GET", `/sequences/${S.seq.id}/edit`)).status, 401);
});

test("edit ops: split / trim / ripple / delete / move / speed / markers / reorder, with undo & redo", { skip: !FF }, async () => {
    let e = await edit();
    const [c1, c2, c3] = v1(e);
    // split c1 at 1.0 → two clips, second keeps the right source offset
    e = await ops([{ type: "split_clip", id: c1.id, at: 1 }], e.version);
    let l = v1(e);
    assert.deepEqual(l.map((c: any) => [c.start, c.duration, c.in]), [[0, 1, 0], [1, 2, 1], [3, 3, 0], [6, 2, 0]]);
    // edge trim: cut 0.5s off the head of the second half (in moves, start moves, tail fixed)
    e = await ops([{ type: "trim_clip", id: l[1].id, in: 1.5 }], e.version);
    assert.deepEqual(v1(e).slice(1, 2).map((c: any) => [c.start, c.duration, c.in]), [[1.5, 1.5, 1.5]]);
    // ripple trim of a tail moves later clips
    e = await ops([{ type: "trim_clip", id: l[1].id, duration: 1, ripple: true }], e.version);
    assert.deepEqual(v1(e).map((c: any) => c.start), [0, 1.5, 2.5, 5.5]);
    // ripple delete closes the gap left by the removed clip
    e = await ops([{ type: "delete_clip", id: l[0].id, ripple: true }], e.version);
    assert.deepEqual(v1(e).map((c: any) => [c.start, c.duration]), [[0.5, 1], [1.5, 3], [4.5, 2]]);
    // undo restores, redo reapplies
    const before = JSON.stringify(v1(e).map((c: any) => c.id));
    const undone = await ok(S.u, "POST", `/sequences/${S.seq.id}/edit/undo`);
    assert.equal(v1(undone).length, 4);
    const redone = await ok(S.u, "POST", `/sequences/${S.seq.id}/edit/redo`);
    assert.equal(JSON.stringify(v1(redone).map((c: any) => c.id)), before);
    assert.equal((await call(S.u, "POST", `/sequences/${S.seq.id}/edit/redo`)).status, 409, "nothing left to redo");
    // back to the pristine 3-clip cut for the remaining tests
    e = await ok(S.u, "POST", `/sequences/${S.seq.id}/timeline/conform`, { reset: true });
    assert.deepEqual(v1(e).map((c: any) => [c.start, c.duration]), [[0, 3], [3, 3], [6, 2]]);
    // speed 2x halves the timeline length, source span stays
    const a = v1(e)[0];
    e = await ops([{ type: "set_speed", id: a.id, speed: 2 }], e.version);
    assert.deepEqual([v1(e)[0].duration, v1(e)[0].out], [1.5, 3]);
    e = await ops([{ type: "set_speed", id: a.id, speed: 1 }], e.version);
    // markers
    e = await ops([{ type: "add_marker", t: 2.5, label: "beat" }], e.version);
    assert.equal(e.markers[0].label, "beat");
    e = await ops([{ type: "remove_marker", id: e.markers[0].id }], e.version);
    assert.equal(e.markers.length, 0);
    // reorder swaps the first two shots and re-packs contiguously
    e = await ops([{ type: "reorder", shotIdA: S.shots[0].id, shotIdB: S.shots[1].id }], e.version);
    assert.deepEqual(v1(e).map((c: any) => [c.shotId === S.shots[1].id ? "S2" : c.shotId === S.shots[0].id ? "S1" : "S3", c.start]), [["S2", 0], ["S1", 3], ["S3", 6]]);
    e = await ops([{ type: "reorder", shotIdA: S.shots[0].id, shotIdB: S.shots[1].id }], e.version);
    assert.equal(v1(e)[0].shotId, S.shots[0].id);
    S.version = e.version;
});

test("edit rules: overlaps, locks, min duration, trim limits, kind checks, stale versions, atomic batches", { skip: !FF }, async () => {
    let e = await edit();
    const [c1, c2] = v1(e);
    // overlap without a dissolve is a conflict
    let r = await opsRaw([{ type: "move_clip", id: c2.id, start: 2 }], e.version);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "overlap");
    // too short
    assert.equal((await opsRaw([{ type: "trim_clip", id: c1.id, duration: 0.05 }], e.version)).status, 400);
    // trimming past the source (3s file)
    r = await opsRaw([{ type: "trim_clip", id: c1.id, duration: 3.5 }], e.version);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /source duration/);
    // video on an audio track / shot on audio track
    assert.equal((await opsRaw([{ type: "add_clip", clip: { trackId: "A2", type: "shot", shotId: S.shots[0].id, start: 0 } }], e.version)).status, 400);
    assert.equal((await opsRaw([{ type: "add_clip", clip: { trackId: "V1", type: "media", mediaId: S.media.music.id, start: 20 } }], e.version)).status, 400);
    // locked track rejects edits; unlocking works
    e = await ops([{ type: "update_track", id: "V1", locked: true }], e.version);
    r = await opsRaw([{ type: "delete_clip", id: c1.id }], e.version);
    assert.equal(r.status, 403);
    e = await ops([{ type: "update_track", id: "V1", locked: false }], e.version);
    // stale version
    r = await opsRaw([{ type: "add_marker", t: 1 }], e.version - 1);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "stale");
    assert.equal(r.json.details.version, e.version);
    // atomic: second op fails → first op not applied
    const v = e.version;
    r = await opsRaw([{ type: "add_marker", t: 9, label: "should not stick" }, { type: "trim_clip", id: "NOPE", duration: 1 }], v);
    assert.equal(r.status, 404);
    assert.match(r.json.error, /op #2/);
    r = await opsRaw([{ type: "add_marker", t: 9, label: "should not stick" }, { type: "trim_clip", id: c1.id, duration: 99 }], v); // fails validation after both ops applied in memory
    assert.equal(r.status, 400);
    e = await edit();
    assert.equal(e.version, v);
    assert.equal(e.markers.length, 0);
    // schema errors name the op
    assert.equal((await opsRaw([{ type: "nope" }])).status, 400);
    // transitions: dissolve overlaps neighbours by exactly its duration and ripples the rest; back to cut restores
    e = await ops([{ type: "set_transition", id: c2.id, transition: { type: "dissolve", duration: 1 } }], e.version);
    assert.deepEqual(v1(e).map((c: any) => c.start), [0, 2, 5]);
    assert.equal(v1(e)[1].transition.type, "dissolve");
    assert.equal((await opsRaw([{ type: "set_transition", id: c1.id, transition: { type: "dissolve", duration: 1 } }], e.version)).status, 400, "first clip has no predecessor");
    assert.equal((await opsRaw([{ type: "set_transition", id: c2.id, transition: { type: "dissolve", duration: 5 } }], e.version)).status, 400, "longer than a neighbour");
    S.dissolveVersion = e.version;
    // audio clips on A2/A1 from media; trims limited to the real duration
    e = await ops([{ type: "add_clip", clip: { trackId: "A2", type: "media", mediaId: S.media.music.id, start: 0, label: "score", gainDb: -10, fadeIn: 0.5, fadeOut: 1 } }, { type: "add_clip", clip: { trackId: "A1", type: "media", mediaId: S.media.dlg.id, start: 1, duration: 3, label: "dialogue" } }], e.version);
    assert.equal(e.clips.filter((c: any) => c.trackId.startsWith("A")).length, 2);
    assert.equal((await opsRaw([{ type: "trim_clip", id: e.clips.find((c: any) => c.label === "score").id, duration: 7 }], e.version)).status, 400);
    const tl = await ok(S.u, "GET", `/sequences/${S.seq.id}/timeline`);
    assert.equal(tl.audio.length, 2);
    assert.equal(tl.duration, 7, "V1 = 3 + 3 + 2 - 1s dissolve overlap = 7");
});

const waitRender = async (seqId: string, notId?: string) => {
    for (let i = 0; i < 400; i++) {
        const list = await ok(S.u, "GET", `/sequences/${seqId}/renders`);
        const r = list.find((x: any) => x.id !== notId && x.status !== "RUNNING");
        if (r && (!notId || r.id !== notId)) return r;
        await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error("render did not finish");
};
async function renderAndProbe(seqId: string, opts: any = {}, name = "out.mp4") {
    const before = (await ok(S.u, "GET", `/sequences/${seqId}/renders`)).map((r: any) => r.id);
    const r0 = await ok(S.u, "POST", `/sequences/${seqId}/render`, opts);
    let r: any;
    for (let i = 0; i < 600; i++) { r = (await ok(S.u, "GET", `/sequences/${seqId}/renders`)).find((x: any) => x.id === r0.id); if (r.status !== "RUNNING") break; await new Promise((res) => setTimeout(res, 100)); }
    assert.equal(r.status, "SUCCEEDED", r.error);
    assert.ok(!before.includes(r0.id));
    const f = join(dir, name);
    writeFileSync(f, (await call(null, "GET", r.media.url)).buf);
    return { file: f, probe: ffprobe(f), id: r0.id };
}
const satAt = (file: string, t: number) => {
    const out = execSync(`ffmpeg -v error -ss ${t} -i "${file}" -frames:v 1 -vf signalstats,metadata=print:file=- -f null -`).toString();
    return Number(/lavfi\.signalstats\.SATAVG=([\d.]+)/.exec(out)![1]);
};
const CUBE = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";

test("colour: grade validation, per-shot / sequence grades, LUT checks", { skip: !FF }, async () => {
    const g = await ok(S.u, "PUT", `/shots/${S.shots[0].id}/grade`, { grade: { saturation: 0 } });
    assert.equal(g.saturation, 0);
    assert.equal((await ok(S.u, "GET", `/shots/${S.shots[0].id}/grade`)).contrast, 1, "defaults filled");
    assert.equal((await call(S.u, "PUT", `/shots/${S.shots[0].id}/grade`, { grade: { saturation: 9 } })).status, 400);
    assert.equal((await call(S.u, "PUT", `/shots/${S.shots[0].id}/grade`, { grade: { lift: [2, 0, 0] } })).status, 400);
    assert.equal((await call(S.u, "PUT", `/shots/${S.shots[0].id}/grade`, { grade: { bogus: 1 } })).status, 400, "unknown fields rejected");
    assert.equal((await call(S.u, "PUT", `/shots/${S.shots[0].id}/grade`, { grade: { lutCube: "nonsense" } })).status, 400);
    assert.equal((await call(S.u, "PUT", `/shots/${S.shots[0].id}/grade`, { grade: { lutCube: "LUT_3D_SIZE 2\n0 0 0\n" } })).status, 400, "row count must be N^3");
    assert.equal((await call(S.u, "PUT", `/shots/${S.shots[0].id}/grade`, { grade: { lutCube: CUBE.replace("1 1 1", "1 1 x") } })).status, 400);
    const s2 = await ok(S.u, "PUT", `/shots/${S.shots[1].id}/grade`, { grade: { temperature: 40, lift: [0.05, 0, 0], gain: [0, 0, -0.05], gamma: [0, 0.02, 0], contrast: 1.1, exposureStops: 0.3 } });
    assert.equal(s2.temperature, 40);
    const sg = await ok(S.u, "PUT", `/sequences/${S.seq.id}/grade`, { grade: { lutCube: CUBE } });
    assert.equal(sg.hasLut, true);
    assert.equal(sg.lutCube, undefined, "LUT text is not echoed back");
    const e = await edit();
    assert.equal(e.grade.lutCube, "(cube)");
    assert.equal((await call(S.u, "PUT", `/sequences/${S.seq.id}/grade`, { grade: { saturation: 5 } })).status, 400);
    // sequence grade is part of the undoable timeline
    const undone = await ok(S.u, "POST", `/sequences/${S.seq.id}/edit/undo`);
    assert.equal(undone.grade, null);
    await ok(S.u, "POST", `/sequences/${S.seq.id}/edit/redo`);
});

test("render: dissolve + multi-track mix + ducking + grades; ffprobe-verified", { skip: !FF }, async () => {
    await ops([{ type: "set_duck", duck: { underRole: "dialogue", amountDb: -12 } }], (await edit()).version);
    const { file, probe, id } = await renderAndProbe(S.seq.id, { normalizeAudio: true });
    const v = probe.streams.find((x: any) => x.codec_type === "video");
    assert.deepEqual([v.width, v.height], [1280, 720]);
    assert.ok(probe.streams.some((x: any) => x.codec_type === "audio"), "mixed audio present");
    assert.ok(Math.abs(Number(probe.format.duration) - 7) < 0.4, `duration ${probe.format.duration} ≈ 7 (3+3+2-1 dissolve)`);
    assert.ok(probe.streams.some((x: any) => x.codec_type === "subtitle"), "soft subtitles muxed");
    // grade actually hits pixels: S1 desaturated, S2 (SMPTE bars) not
    assert.ok(satAt(file, 1) < 8, "shot 1 is grayscale");
    assert.ok(satAt(file, 4) > 30, "shot 2 keeps its colour");
    // loudness analysis of the render
    const rep = await ok(S.u, "GET", `/sequences/${S.seq.id}/audio-report`);
    assert.equal(rep.renderId, id);
    assert.ok(Number.isFinite(rep.integratedLufs) && rep.integratedLufs < -9 && rep.integratedLufs > -26, `LUFS ${rep.integratedLufs}`);
    assert.ok(Number.isFinite(rep.truePeakDb) && rep.truePeakDb <= 0.5);
    assert.ok(Number.isFinite(rep.lra));
});

test("render: video-only sequence (no audio stream), dip to black, overlay track, speed", { skip: !FF }, async () => {
    const ws = (await ok(S.u, "GET", "/workspaces/current")).id;
    const seq2 = await ok(S.u, "POST", `/projects/${S.p.id}/sequences`, { name: "Cut 2" });
    const shots = [];
    for (const [i, [d, m]] of [[3, "b"], [2, "c"]].entries() as any) {
        const sh = await ok(S.u, "POST", `/projects/${S.p.id}/shots`, { sequenceId: seq2.id, title: `T${i + 1}`, duration: d, subtitle: i ? "second" : "" });
        db.prepare("INSERT INTO takes(id,workspace_id,project_id,shot_id,media_id,status,meta,created_at) VALUES(?,?,?,?,?,?,?,?)").run(`t2-${i}`, ws, S.p.id, sh.id, S.media[m].id, "approved", "{}", new Date().toISOString());
        db.prepare("UPDATE shots SET approved_take_id=?, status='approved' WHERE id=?").run(`t2-${i}`, sh.id);
        shots.push(sh);
    }
    let e = await ok(S.u, "GET", `/sequences/${seq2.id}/edit`);
    const [c1, c2] = e.clips.filter((c: any) => c.trackId === "V1");
    e = await ok(S.u, "POST", `/sequences/${seq2.id}/edit/ops`, { expectedVersion: e.version, ops: [
        { type: "set_transition", id: c2.id, transition: { type: "fade_black", duration: 1 } },
        { type: "add_track", kind: "video", name: "V2" },
    ] });
    assert.equal(v1(e).map((c: any) => c.start).join(), "0,3", "dip to black does not overlap");
    const v2 = e.tracks.find((t: any) => t.kind === "video" && t.id !== "V1").id;
    e = await ok(S.u, "POST", `/sequences/${seq2.id}/edit/ops`, { expectedVersion: e.version, ops: [{ type: "add_clip", clip: { trackId: v2, type: "media", mediaId: S.media.c.id, start: 1, duration: 1, label: "overlay" } }, { type: "set_speed", id: c1.id, speed: 1 }] });
    const r = await renderAndProbe(seq2.id, { normalizeAudio: true }, "o2.mp4");
    assert.equal(r.probe.streams.filter((x: any) => x.codec_type === "audio").length, 0, "no audio sources → no audio stream");
    assert.ok(Math.abs(Number(r.probe.format.duration) - 5) < 0.3, `duration ${r.probe.format.duration}`);
    assert.ok(satAt(r.file, 0.1) > 20);
    assert.ok(r.probe.streams.some((x: any) => x.codec_type === "subtitle"));
    // audio-report is a clear 409 for a silent render
    const rep = await call(S.u, "GET", `/sequences/${seq2.id}/audio-report`);
    assert.equal(rep.status, 409);
    // 2x speed halves the first clip: 1.5 + 2 = 3.5s
    e = await ok(S.u, "POST", `/sequences/${seq2.id}/edit/ops`, { expectedVersion: e.version, ops: [{ type: "set_speed", id: c1.id, speed: 2 }] });
    assert.equal(v1(e)[0].duration, 1.5);
    assert.equal(Math.max(...v1(e).map((c: any) => c.start + c.duration)), 5, "second clip stays at 3, leaving a 1.5s gap");
    const r2 = await renderAndProbe(seq2.id, {}, "o3.mp4");
    assert.ok(Math.abs(Number(r2.probe.format.duration) - 5) < 0.3, `gap filled with black: ${r2.probe.format.duration}`);
});

test("export package + EDL carry trims, dissolves, edit timeline and grade files", { skip: !FF }, async () => {
    const e0 = await edit();
    const s3 = v1(e0)[2];
    await ops([{ type: "trim_clip", id: s3.id, in: 0.5 }], e0.version);
    const edl = (await call(S.u, "GET", `/sequences/${S.seq.id}/timeline.edl`)).json as string;
    assert.match(edl, /002  AX       V     D    024 /, "dissolve event with 24 frames");
    assert.match(edl, /003  AX       V     C        00:00:00:12 00:00:02:00 /, "source in/out reflect the 0.5s head trim");
    const z = await call(S.u, "GET", `/sequences/${S.seq.id}/export`);
    const names: string[] = [];
    const eocd = z.buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let off = z.buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < z.buf.readUInt16LE(eocd + 10); i++) { const n = z.buf.readUInt16LE(off + 28); names.push(z.buf.subarray(off + 46, off + 46 + n).toString()); off += 46 + n; }
    for (const n of ["manifest.json", "timeline.edl", "subtitles.srt", "timeline-edit.json", "grades/sequence.json", "grades/sequence.cube", "grades/shot-01.json", "grades/shot-02.json"]) assert.ok(names.includes(n), `${n} in ${names.join()}`);
    assert.ok(names.some((n) => n.startsWith("media/audio-")));
    const f = join(dir, "x.zip"); writeFileSync(f, z.buf);
    assert.match(execSync(`unzip -t ${f}`).toString(), /No errors detected/);
});

test("QC look_normalization is a real fix: it writes a grade toward the previous shot", { skip: !FF }, async () => {
    await ok(S.u, "PATCH", `/shots/${S.shots[0].id}`, { lighting: { colorTemp: "5600K", timeOfDay: "day" } });
    await ok(S.u, "PATCH", `/shots/${S.shots[1].id}`, { lighting: { colorTemp: "3200K", timeOfDay: "day" } });
    const qc = await ok(S.u, "POST", `/shots/${S.shots[1].id}/qc`, { targetType: "take", targetId: "take1", observations: [{ kind: "color_shift" }] });
    const ra = qc.repairActions.find((a: any) => a.action === "look_normalization");
    assert.ok(ra, "diagnosis proposes look_normalization");
    const r = await ok(S.u, "POST", `/repair-actions/${ra.id}/apply`);
    assert.equal(r.applied, true);
    assert.equal(r.grade.temperature, Math.round((5600 - 3200) / 40));
    assert.equal((await ok(S.u, "GET", `/shots/${S.shots[1].id}/grade`)).temperature, 60, "persisted on the shot");
    // the render uses it without error
    const out = await renderAndProbe(S.seq.id, { normalizeAudio: false }, "o4.mp4");
    assert.ok(Number(out.probe.format.duration) > 6);
});
