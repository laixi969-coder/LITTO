import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const binary of ["ffmpeg", "ffprobe"]) {
    assert.equal(spawnSync(binary, ["-version"], { stdio: "ignore" }).status, 0, `剪辑回归需要可执行的 ${binary}`);
}
const dir = mkdtempSync(join(tmpdir(), "milimili-nle-test-"));
Object.assign(process.env, { MILIMILI_DATA_DIR: dir, MILIMILI_DB: ":memory:", MILIMILI_QUIET: "1", MILIMILI_NO_RATELIMIT: "1", NODE_ENV: "test", MILIMILI_NO_DERIVATIVES: "1" });

const { app } = await import("../src/app.ts");
const { loginUser, setUserPassword } = await import("../src/auth.ts");
const { scoped } = await import("../src/db.ts");
const { sha256 } = await import("../src/util.ts");
const { sequenceFingerprint } = await import("../src/domain/finalQuality.ts");
const { readAudioIntervals } = await import("../src/domain/musicInspection.ts");
const { configureNarrativeGate } = await import("../src/domain/narrativeGate.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

type Who = { token: string };
async function call(who: Who | null, method: string, path: string, body?: unknown) {
    const res = await app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any; try { json = JSON.parse(buf.toString()); } catch { json = buf.toString(); }
    return { status: res.status, json, buf };
}
const ok = async (who: Who | null, m: string, p: string, b?: unknown) => { const r = await call(who, m, p, b); assert.ok(r.status < 300, `${m} ${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`); return r.json; };
async function login(email: string): Promise<Who> {
    const password = randomUUID();
    await setUserPassword(loginUser(email).user.id, password);
    const { token } = await ok(null, "POST", "/auth/password/login", { email, password, client: "api" });
    return { token };
}
const ffprobe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));

const S: any = {};
const fixtureShots = new Map<string, string[]>();
// 工程回归只使用已知顺序的合成色卡。在外部叙事评审端口核对镜头清单，并在编码结束时复核同一版剪辑。
configureNarrativeGate(async ({ workspaceId, projectId, sequenceId }) => {
    assert.equal(workspaceId, S.workspaceId);
    assert.equal(projectId, S.p.id);
    assert.ok(sequenceId && fixtureShots.has(sequenceId));
    const scope = scoped(workspaceId);
    assert.deepEqual(scope.list("shots", { projectId, sequenceId }, "ord").map(shot => shot.id), fixtureShots.get(sequenceId));
    const fingerprint = sequenceFingerprint(scope, sequenceId);
    return async () => { assert.equal(sequenceFingerprint(scope, sequenceId), fingerprint); };
});
const edit = async () => ok(S.u, "GET", `/sequences/${S.seq.id}/edit`);
const ops = async (o: any[], version?: number) => ok(S.u, "POST", `/sequences/${S.seq.id}/edit/ops`, { ops: o, expectedVersion: version });
const opsRaw = (o: any[], version?: number) => call(S.u, "POST", `/sequences/${S.seq.id}/edit/ops`, { ops: o, expectedVersion: version });
const v1 = (e: any) => e.clips.filter((c: any) => c.trackId === "V1").sort((a: any, b: any) => a.start - b.start);

async function upload(file: string) {
    const res = await app.request(`/media?projectId=${S.p.id}`, { method: "POST", headers: { authorization: `Bearer ${S.u.token}` }, body: new Uint8Array(readFileSync(file)) });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    return JSON.parse(text) as any;
}
function makeMedia() {
    // 首镜自带 500 Hz 现场声，配乐和音效另走独立轨。固定种子的噪声使配乐波形可唯一定位。
    // 在首镜 0.512 秒处丢弃三个 AAC 包。前后两次 1500 Hz 提示音分别在 0.2、1.2 秒起响。
    const keyAudio = "aevalsrc='0.125*sin(2*PI*500*t)+0.17*sin(2*PI*1500*t)*(between(t,0.2,0.32)+between(t,1.2,1.32))':s=48000:d=3";
    const encode = (input: string, name: string, args: string[] = []) => execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", input, ...args, join(dir, name)]);
    const video = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
    encode("testsrc=size=640x360:rate=25:duration=3", "a.mp4", ["-f", "lavfi", "-i", keyAudio, ...video, "-c:a", "aac", "-bsf:a", "noise=drop='between(pts,24576,27647)'", "-shortest"]);
    encode("smptebars=size=480x270:rate=30:duration=3", "b.mp4", video);
    encode("testsrc2=size=640x360:rate=25:duration=2", "c.mp4", video);
    encode("sine=frequency=440:sample_rate=8000:duration=6[tone];anoisesrc=sample_rate=8000:amplitude=0.13:duration=6:seed=17[noise];[tone][noise]amix=inputs=2:normalize=0", "music.wav");
    encode("sine=frequency=880:duration=4", "effect.wav");
}

async function reviewPattern(shotId: string, takeId: string) {
    const path = `/shots/${shotId}/qc`, target = { targetType: "take", targetId: takeId };
    const basic = await ok(S.u, "POST", path, { ...target, basic: true });
    assert.equal(basic.status, "checked", basic.error);
    assert.ok(basic.hasVideo && basic.duration > 0 && !basic.blackSegments.length);
    await ok(S.u, "POST", path, { ...target, reviewed: basic.plan.checks, fullPlayback: true, observedStateDelta: {},
        note: "工程回归使用已知的 FFmpeg 色卡素材，无人物或剧情。全长可解码，固定色条的静止符合输入设计。" });
}

async function prepareSequence(sequenceId: string, clips: { media: string; duration: number; subtitle?: string }[]) {
    const shots = [];
    const scope = scoped(S.workspaceId);
    for (const [index, clip] of clips.entries()) {
        const shot = await ok(S.u, "POST", `/projects/${S.p.id}/shots`, { sequenceId, title: `色卡 ${index + 1}`, duration: clip.duration, subtitle: clip.subtitle ?? "" });
        const take = scope.insert("takes", { project_id: S.p.id, shot_id: shot.id, media_id: S.media[clip.media].id, status: "candidate", meta: {} });
        shots.push({ id: shot.id, takeId: take.id });
    }
    fixtureShots.set(sequenceId, shots.map(shot => shot.id));
    for (const shot of shots) {
        await reviewPattern(shot.id, shot.takeId);
        const take = await ok(S.u, "POST", `/takes/${shot.takeId}/approve`, {});
        assert.equal(take.status, "approved");
    }
    return shots;
}

test("setup: project, 3 shots with approved real-video takes; media duration is probed", async () => {
    makeMedia();
    const intervals = await readAudioIntervals(join(dir, "a.mp4"));
    assert.ok(intervals?.some((range, index) => Math.abs(range.end - 0.512) < 0.001 && Math.abs(intervals[index + 1]?.start - 0.576) < 0.001), "输入须保留 64 毫秒的真实音频帧空档");
    S.u = await login("cutter@example.com");
    S.p = await ok(S.u, "POST", "/projects", { name: "NLE" });
    S.seq = await ok(S.u, "POST", `/projects/${S.p.id}/sequences`, { name: "Cut", kind: "musicFilm" });
    S.workspaceId = (await ok(S.u, "GET", "/workspaces/current")).id;
    S.media = { a: await upload(`${dir}/a.mp4`), b: await upload(`${dir}/b.mp4`), c: await upload(`${dir}/c.mp4`), music: await upload(`${dir}/music.wav`), effect: await upload(`${dir}/effect.wav`) };
    assert.ok(Math.abs((await ok(S.u, "GET", `/media/${S.media.a.id}`)).duration - 3) < 0.2, "ffprobe duration stored");
    S.shots = await prepareSequence(S.seq.id, [{ media: "a", duration: 3, subtitle: "Hello there" }, { media: "b", duration: 3 }, { media: "c", duration: 2 }]);
});

test("conform builds V1 + audio tracks; the public timeline reflects it; tenants are isolated", async () => {
    const previous = await edit();
    const e = await ok(S.u, "POST", `/sequences/${S.seq.id}/timeline/conform`, { reset: true });
    assert.deepEqual(e.tracks.map((t: any) => t.id), ["V1", "A1", "A2", "A3"]);
    assert.deepEqual(v1(e).map((c: any) => [c.start, c.duration, c.source.kind]), [[0, 3, "take"], [3, 3, "take"], [6, 2, "take"]]);
    assert.equal(e.version, previous.version + 1);
    const tl = await ok(S.u, "GET", `/sequences/${S.seq.id}/timeline`);
    assert.equal(tl.edited, true);
    assert.deepEqual(tl.clips.map((c: any) => [c.start, c.duration, c.kind]), [[0, 3, "take"], [3, 3, "take"], [6, 2, "take"]]);
    assert.equal(tl.duration, 8);
    const other = await login("other-nle@example.com");
    assert.equal((await call(other, "GET", `/sequences/${S.seq.id}/edit`)).status, 404);
    assert.equal((await call(other, "POST", `/sequences/${S.seq.id}/edit/ops`, { ops: [{ type: "add_marker", t: 1 }] })).status, 404);
    assert.equal((await call(null, "GET", `/sequences/${S.seq.id}/edit`)).status, 401);
});

test("edit ops: split / trim / ripple / delete / move / speed / markers / reorder, with undo & redo", async () => {
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
});

test("edit rules: overlaps, locks, min duration, trim limits, kind checks, stale versions, atomic batches", async () => {
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
    const effect = { type: "media", mediaId: S.media.effect.id, in: 0.5, start: 1, duration: 3, label: "effect" };
    const unlinked = await opsRaw([{ type: "add_clip", clip: { ...effect, trackId: "A1" } }], e.version);
    assert.equal(unlinked.status, 400);
    assert.match(unlinked.json.error, /原句/);
    e = await ops([{ type: "add_clip", clip: { trackId: "A2", type: "media", mediaId: S.media.music.id, start: 0, label: "score", gainDb: -10, fadeIn: 0.5, fadeOut: 1 } }, { type: "add_clip", clip: { ...effect, trackId: "A3" } }], e.version);
    assert.equal(e.clips.filter((c: any) => c.trackId.startsWith("A")).length, 2);
    assert.equal((await opsRaw([{ type: "trim_clip", id: e.clips.find((c: any) => c.label === "score").id, duration: 7 }], e.version)).status, 400);
    const tl = await ok(S.u, "GET", `/sequences/${S.seq.id}/timeline`);
    assert.equal(tl.audio.length, 2);
    assert.equal(tl.duration, 7, "V1 = 3 + 3 + 2 - 1s dissolve overlap = 7");
});

async function renderAndProbe(seqId: string, opts: any = {}, name = "out.mp4") {
    const before = (await ok(S.u, "GET", `/sequences/${seqId}/renders`)).map((r: any) => r.id);
    const r0 = await ok(S.u, "POST", `/sequences/${seqId}/render`, opts);
    let r = r0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const renders = await ok(S.u, "GET", `/sequences/${seqId}/renders`);
        r = renders.find((item: any) => item.id === r0.id);
        assert.ok(r, "导出记录应出现在当前序列");
        if (r.status === "SUCCEEDED" || r.status === "FAILED") break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(r.status, "SUCCEEDED", r.error || "等待定稿导出超时");
    assert.equal(r.draft, false);
    assert.ok(!before.includes(r0.id));
    const f = join(dir, name);
    const download = await call(null, "GET", r.media.url);
    assert.equal(download.status, 200);
    writeFileSync(f, download.buf);
    const probe = ffprobe(f);
    const quality = await ok(S.u, "POST", `/renders/${r.id}/quality/analyze`, {});
    assert.ok(quality.analysisId);
    assert.equal(quality.mediaId, r.media.id);
    assert.equal(quality.hash, sha256(download.buf));
    assert.equal(quality.coverage, "decodeAndAudioSignals");
    assert.equal(quality.status, "unverified");
    assert.equal(quality.hasAudio, probe.streams.some((stream: any) => stream.codec_type === "audio"));
    assert.equal(quality.findings.some((finding: any) => finding.id === "noAudio"), !quality.hasAudio);
    assert.ok(!quality.findings.some((finding: any) => finding.severity === "block"));
    const saved = (await ok(S.u, "GET", `/sequences/${seqId}/renders`)).find((item: any) => item.id === r.id);
    assert.deepEqual(saved.quality, quality);
    return { file: f, probe, quality, id: r.id };
}
const satAt = (file: string, t: number) => {
    const out = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf8" });
    return Number(/lavfi\.signalstats\.SATAVG=([\d.]+)/.exec(out)![1]);
};
const CUBE = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";

test("colour: grade validation, per-shot / sequence grades, LUT checks", async () => {
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

test("render: dissolve + multi-track mix + ducking + grades; ffprobe-verified", async () => {
    await ops([{ type: "set_duck", duck: { underRole: "dialogue", amountDb: -12 } }], (await edit()).version);
    const { file, probe, id, quality } = await renderAndProbe(S.seq.id, { normalizeAudio: true, width: 1280, height: 720 });
    const v = probe.streams.find((x: any) => x.codec_type === "video");
    assert.deepEqual([v.width, v.height], [1280, 720]);
    assert.ok(probe.streams.some((x: any) => x.codec_type === "audio"), "mixed audio present");
    const sampleRate = 8000;
    const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ar", String(sampleRate), "-ac", "1", "-f", "f32le", "-"]);
    assert.equal(pcm.status, 0, pcm.stderr.toString());
    function toneLevelAt(seconds: number, frequency: number, length: number) {
        const start = Math.round(seconds * sampleRate), count = Math.round(length * sampleRate);
        assert.ok((start + count) * 4 <= pcm.stdout.length, `no decoded audio at ${seconds}s`);
        let real = 0, imaginary = 0;
        for (let i = 0; i < count; i++) {
            const sample = pcm.stdout.readFloatLE((start + i) * 4), phase = 2 * Math.PI * frequency * i / sampleRate;
            real += sample * Math.cos(phase);
            imaginary += sample * Math.sin(phase);
        }
        return 20 * Math.log10(2 * Math.hypot(real, imaginary) / count);
    }
    for (const onset of [0.2, 1.2]) {
        const before = toneLevelAt(onset - 0.045, 1500, 0.025), during = toneLevelAt(onset + 0.015, 1500, 0.025);
        assert.ok(during > -30 && during > before + 10, `${onset}s 提示音未按时起响：之前 ${before} dBFS，之后 ${during} dBFS`);
    }
    // 现场声在 3 秒停止，配乐到 6 秒。用配乐中已知的 440 Hz 分量比较压低与释放后的电平。
    const compressed = toneLevelAt(1.5, 440, 0.25), released = toneLevelAt(4.45, 440, 0.25);
    assert.ok(released > compressed + 2, `音乐侧链压低 ${compressed} dBFS，释放后 ${released} dBFS`);
    const beforeEffect = toneLevelAt(0.8, 880, 0.1), onEffect = toneLevelAt(1.1, 880, 0.1);
    const endEffect = toneLevelAt(3.85, 880, 0.1), afterEffect = toneLevelAt(4.15, 880, 0.1);
    assert.ok(onEffect > beforeEffect + 10 && endEffect > afterEffect + 10, `1–4 秒音效起止电平 ${[beforeEffect, onEffect, endEffect, afterEffect].join(", ")} dBFS`);
    assert.deepEqual(quality.musicAlignment.ranges, [{ start: 0, end: 6, status: "covered" }]);
    const tail = quality.musicAlignment.windows.at(-1);
    assert.equal(tail.sourceMediaId, S.media.music.id);
    assert.equal(tail.status, "aligned", tail.reason);
    assert.ok(Number.isFinite(tail.offsetMs) && Math.abs(tail.offsetMs) < 1000 / 24);
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

test("render: video-only sequence (no audio stream), dip to black, overlay track, speed", async () => {
    const seq2 = await ok(S.u, "POST", `/projects/${S.p.id}/sequences`, { name: "Cut 2" });
    const shots = await prepareSequence(seq2.id, [{ media: "b", duration: 3 }, { media: "c", duration: 2, subtitle: "second" }]);
    let e = await ok(S.u, "GET", `/sequences/${seq2.id}/edit`);
    const [c1, c2] = e.clips.filter((c: any) => c.trackId === "V1");
    e = await ok(S.u, "POST", `/sequences/${seq2.id}/edit/ops`, { expectedVersion: e.version, ops: [
        { type: "set_transition", id: c2.id, transition: { type: "fade_black", duration: 1 } },
        { type: "add_track", kind: "video", name: "V2" },
    ] });
    assert.equal(v1(e).map((c: any) => c.start).join(), "0,3", "dip to black does not overlap");
    const v2 = e.tracks.find((t: any) => t.kind === "video" && t.id !== "V1").id;
    e = await ok(S.u, "POST", `/sequences/${seq2.id}/edit/ops`, { expectedVersion: e.version, ops: [{ type: "add_clip", clip: { trackId: v2, type: "media", shotId: shots[1].id, mediaId: S.media.c.id, start: 1, duration: 1, label: "overlay" } }, { type: "set_speed", id: c1.id, speed: 1 }] });
    const r = await renderAndProbe(seq2.id, { normalizeAudio: true }, "o2.mp4");
    const video = r.probe.streams.find((stream: any) => stream.codec_type === "video");
    assert.deepEqual([video.width, video.height], [S.media.b.width, S.media.b.height]);
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
    // 仅有一条音效时，其他音轨无法掩盖前导静音被裁掉的错误。
    await ok(S.u, "POST", `/sequences/${seq2.id}/edit/ops`, { expectedVersion: e.version, ops: [
        { type: "add_clip", clip: { trackId: "A3", type: "media", mediaId: S.media.effect.id, in: 0.5, start: 1, duration: 3 } },
    ] });
    const delayed = await renderAndProbe(seq2.id, {}, "delayed.mp4");
    const audio = delayed.probe.streams.find((stream: any) => stream.codec_type === "audio");
    assert.ok(Math.abs(Number(audio.start_time) + Number(audio.duration) - 4) < 0.03, "独立音效应止于 4 秒");
    assert.ok(delayed.quality.silences.some((gap: { start: number; end: number }) => gap.start === 0 && Math.abs(gap.end - 1) < 0.03), "定稿应检出音效前完整的 1 秒静音");
});

test("export package + EDL carry trims, dissolves, edit timeline and grade files", async () => {
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
    execFileSync("unzip", ["-t", f]);
});

test("QC look_normalization is a real fix: it writes a grade toward the previous shot", async () => {
    await ok(S.u, "PATCH", `/shots/${S.shots[0].id}`, { lighting: { colorTemp: "5600K", timeOfDay: "day" }, confirm: true });
    await ok(S.u, "PATCH", `/shots/${S.shots[1].id}`, { lighting: { colorTemp: "3200K", timeOfDay: "day" }, confirm: true });
    const qc = await ok(S.u, "POST", `/shots/${S.shots[1].id}/qc`, { targetType: "take", targetId: S.shots[1].takeId, observations: [{ kind: "color_shift" }] });
    const ra = qc.repairActions.find((a: any) => a.action === "look_normalization");
    assert.ok(ra, "diagnosis proposes look_normalization");
    const r = await ok(S.u, "POST", `/repair-actions/${ra.id}/apply`);
    assert.equal(r.applied, true);
    assert.equal(r.grade.temperature, Math.round((5600 - 3200) / 40));
    assert.equal((await ok(S.u, "GET", `/shots/${S.shots[1].id}/grade`)).temperature, 60, "persisted on the shot");
    const stale = await call(S.u, "POST", `/sequences/${S.seq.id}/render`, { normalizeAudio: false });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "review_required");
    for (const shot of S.shots.slice(0, 2)) await reviewPattern(shot.id, shot.takeId);
    // the render uses it without error
    const out = await renderAndProbe(S.seq.id, { normalizeAudio: false }, "o4.mp4");
    assert.ok(Number(out.probe.format.duration) > 6);
    const cached = await ok(S.u, "POST", `/sequences/${S.seq.id}/render`, { normalizeAudio: false });
    assert.equal(cached.id, out.id);
    // 旧记录有完整成片和检测报告，但没有新编码版本。相同剪辑再次导出时应生成新文件。
    const scope = scoped(S.workspaceId);
    const { encoderVersion, ...legacyManifest } = scope.get("renders", out.id)!.manifest;
    assert.ok(encoderVersion);
    scope.update("renders", out.id, { manifest: legacyManifest });
    const regenerated = await renderAndProbe(S.seq.id, { normalizeAudio: false }, "regenerated.mp4");
    assert.notEqual(regenerated.id, out.id);
    const historical = await ok(S.u, "POST", `/renders/${out.id}/quality/analyze`, {});
    assert.deepEqual(historical, out.quality);
});
