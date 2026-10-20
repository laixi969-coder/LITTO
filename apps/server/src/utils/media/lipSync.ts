import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdir, readFile, stat, unlink, writeAtomic } from "@toonflow/file";
import type { FfprobeData } from "@toonflow/ffmpeg/types";
import { speechSegmentSchema, speechInspectionMessage, speechSourceKey, type SpeechInspection } from "@toonflow/tool-media-generation/voiceProject";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { currentTenant } from "@/utils/tenant";
import { cloud } from "@/lib/cloud";
import { workspaceProject } from "@/utils/media/jobs";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { readVoiceProject } from "@/utils/media/voiceDecision";

// ACT: 仅保留本进程最近32份数值结果；每次先核验实际字节，不信任客户端缓存。
const speechInspections = new Map<string, SpeechInspection>();

async function mediaHash(directory: string, path: string) {
  const resolved = await resolveWorkspacePath(directory, path);
  const info = await stat(resolved.path);
  if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) throw new Error("同步素材须为工作区内不超过100MB的非空文件");
  return createHash("sha256").update(await readFile(resolved.path)).digest("hex");
}

function probeMedia(ffmpeg: Awaited<ReturnType<typeof createWorkspaceFfmpeg>>, path: string) {
  return new Promise<FfprobeData>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(data)));
}

export async function validateSpeechInputs(directory: string, request: MediaGenerationRequest, signal?: AbortSignal) {
  if (request.videos?.length !== 1 || request.audios?.length !== 1) throw new Error("专用口型处理须使用一个人物视频与一段已确定声音");
  if (request.generateAudio === false) throw new Error("口型任务必须保留采用的声音，不能关闭音轨；本次未提交生成");
  const { project } = await readVoiceProject(directory);
  const line = project.lines.find(line => line.video?.path === request.videos![0]!.path && line.takes.some(take => take.id === line.takeId && take.audio.path === request.audios![0]!.path
    && take.sourceKey === speechSourceKey(line, project.roles.find(role => role.id === line.roleId))));
  const api = cloud(), tenant = currentTenant();
  const projectId = workspaceProject(directory, false);
  const scope = api && tenant ? api.scoped(tenant.workspaceId) : null;
  if (projectId && scope?.list("shots", { projectId }).some(shot => shot.creativeBrief?.dialogue?.lines?.length)) {
    const shot = line?.shotId ? scope.get("shots", line.shotId) : null;
    const planned = shot?.creativeBrief?.dialogue?.lines;
    if (shot?.projectId !== projectId || !planned?.length) throw new Error("请先将采用的声音和人物原片关联到当前项目的对应台词镜头，再对口型；本次未提交生成");
    if (planned.length !== 1 || planned[0].text !== line!.text || planned[0].start !== 0) throw new Error("多句或延迟发声的整镜须先按台词窗口拆成对应发声片段；不能让从第0秒开始的一句口型替代整镜。本次未提交生成。");
  }
  const paths = [request.videos[0]!.path, request.audios[0]!.path];
  const hashes = await Promise.all(paths.map(path => mediaHash(directory, path)));
  const ffmpeg = await createWorkspaceFfmpeg(directory, signal);
  const [video, audio] = await Promise.all(paths.map(path => probeMedia(ffmpeg, path)));
  const videoDuration = Number(video!.streams.find(stream => stream.codec_type === "video")?.duration ?? video!.format.duration);
  const audioDuration = Number(audio!.format.duration);
  if (!video!.streams.some(stream => stream.codec_type === "video") || !audio!.streams.some(stream => stream.codec_type === "audio")
    || ![videoDuration, audioDuration].every(duration => Number.isFinite(duration) && duration > 0 && duration <= 600)
    || Math.abs(videoDuration - audioDuration) > 0.15) throw new Error("口型输入音画时长不一致；请先准备对应的同长发声片段，不能截断整镜、循环画面或变速塞入短句。本次未提交生成。");
  const inputs = { videoHash: hashes[0], audioHash: hashes[1], videoDuration, audioDuration, lineId: line?.id, voiceSourceKey: line?.takes.find(take => take.id === line.takeId)?.sourceKey };
  const expected = (request as MediaGenerationRequest & { speechSyncInputs?: typeof inputs }).speechSyncInputs;
  if (expected && JSON.stringify(expected) !== JSON.stringify(inputs)) throw new Error("口型任务的声音或原视频已改变，拒绝复用旧输入提交");
  return inputs;
}

export async function prepareSpeechAudio(directory: string, input: unknown, signal?: AbortSignal) {
  if (currentTenant()?.role === "VIEWER") throw Object.assign(new Error("只读成员不能准备配音素材"), { status: 403 });
  const audio = speechSegmentSchema.parse(input);
  const hash = await mediaHash(directory, audio.path);
  const ffmpeg = await createWorkspaceFfmpeg(directory, signal);
  const source = await probeMedia(ffmpeg, audio.path);
  const duration = Number(source.format.duration);
  if (!source.streams.some(stream => stream.codec_type === "audio") || !Number.isFinite(duration) || audio.start + audio.duration > duration + 0.02) throw new Error("歌曲或配音裁剪区间超出实际音频长度");
  const key = createHash("sha256").update(JSON.stringify([hash, audio.start, audio.duration, 24000])).digest("hex");
  const path = `assets/speech/audio${key}.wav`;
  const output = await resolveWorkspacePath(directory, path, true);
  const existing = await stat(output.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) {
    const cached = existing.isFile() && existing.size > 44 ? await probeMedia(ffmpeg, path) : null;
    if (!cached?.streams.some(stream => stream.codec_type === "audio") || Math.abs(Number(cached.format.duration) - audio.duration) > 0.02) throw new Error("已有声音片段损坏或时长不符，已保留文件，请核对后处理");
    if (await mediaHash(directory, audio.path) !== hash) throw new Error("检查期间原音频已改变，请核对当前素材");
    return { path, mimeType: "audio/wav", duration: audio.duration };
  }
  const folder = await resolveWorkspacePath(directory, "assets/speech", true);
  await mkdir(folder.path, { recursive: true });
  const temporary = `assets/speech/audio${randomUUID()}.wav`;
  const target = await resolveWorkspacePath(directory, temporary, true);
  const command = ffmpeg(audio.path).seekInput(audio.start).duration(audio.duration).noVideo().audioChannels(1).audioFrequency(24000).audioCodec("pcm_s16le");
  const cancel = () => command.kill("SIGKILL");
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => command.on("error", reject).on("end", () => resolve()).on("start", () => { if (signal?.aborted) cancel(); }).save(temporary));
    signal?.throwIfAborted();
    if (await mediaHash(directory, audio.path) !== hash) throw new Error("处理期间原音频已改变，本次结果未采用");
    const bytes = await readFile(target.path);
    await writeAtomic(output.path, bytes, { exclusive: true }).catch(async (error: NodeJS.ErrnoException) => {
      // 同源同区间的并发请求只复用相同字节，绝不覆盖先完成的片段。
      if (error.code !== "EEXIST" || !bytes.equals(await readFile(output.path))) throw error;
    });
    return { path, mimeType: "audio/wav", duration: audio.duration };
  } finally {
    signal?.removeEventListener("abort", cancel);
    await unlink(target.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function audioEnvelope(ffmpeg: Awaited<ReturnType<typeof createWorkspaceFfmpeg>>, path: string, signal?: AbortSignal) {
  const command = ffmpeg(path).noVideo().audioChannels(1).audioFrequency(8000).audioCodec("pcm_f32le").format("f32le");
  const stream = new PassThrough();
  command.on("error", error => stream.destroy(error));
  command.pipe(stream);
  const cancel = () => { command.kill("SIGKILL"); stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error("声音检查已取消")); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 8000 * 600 * 4) throw new Error("单次同步检查最多处理10分钟音频");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const envelope: number[] = [];
    for (let offset = 0; offset + 320 <= bytes.length; offset += 320) {
      let energy = 0;
      for (let sample = offset; sample < offset + 320; sample += 4) energy += bytes.readFloatLE(sample) ** 2;
      envelope.push(Math.sqrt(energy / 80));
    }
    return envelope;
  } finally { signal?.removeEventListener("abort", cancel); command.kill("SIGKILL"); }
}

export async function inspectSpeechSync(directory: string, audioPath: string, videoPath: string, signal?: AbortSignal, sourceVideoPath?: string) {
  const paths = [audioPath, videoPath, ...(sourceVideoPath ? [sourceVideoPath] : [])];
  const hashes = await Promise.all(paths.map(path => mediaHash(directory, path)));
  signal?.throwIfAborted();
  const key = createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
  const cacheKey = JSON.stringify([directory, key]);
  const cached = speechInspections.get(cacheKey);
  if (cached) return { ...cached, note: speechInspectionMessage(cached) };
  const ffmpeg = await createWorkspaceFfmpeg(directory, signal);
  const [audio, video, original] = await Promise.all([probeMedia(ffmpeg, audioPath), probeMedia(ffmpeg, videoPath), sourceVideoPath ? probeMedia(ffmpeg, sourceVideoPath) : undefined]);
  if (!audio.streams.some(stream => stream.codec_type === "audio") || !video.streams.some(stream => stream.codec_type === "audio") || !video.streams.some(stream => stream.codec_type === "video")) throw new Error("口型结果须同时包含视频和声音，参考素材须有音轨");
  const audioDuration = Number(audio.format.duration);
  const videoDuration = Number(video.streams.find(stream => stream.codec_type === "video")?.duration ?? video.format.duration);
  const sourceVideoDuration = original ? Number(original.streams.find(stream => stream.codec_type === "video")?.duration ?? original.format.duration) : undefined;
  if (original && (!original.streams.some(stream => stream.codec_type === "video") || !Number.isFinite(sourceVideoDuration) || sourceVideoDuration! <= 0 || sourceVideoDuration! > 600)) throw new Error("人物原片不是有效视频或时长超出范围");
  if (![audioDuration, videoDuration].every(duration => Number.isFinite(duration) && duration > 0 && duration <= 600)) throw new Error("同步素材时长无效或超过10分钟");
  const [reference, actual] = await Promise.all([audioEnvelope(ffmpeg, audioPath, signal), audioEnvelope(ffmpeg, videoPath, signal)]);
  let correlation = -1;
  let offsetMs = 0;
  // ACT: 10ms声音能量包络在±250ms内比较，用于发现错音轨与整体偏移；不能据此证明逐字口型或对白内容正确。
  for (let lag = -25; lag <= 25; lag++) {
    const start = Math.max(0, -lag);
    const end = Math.min(reference.length, actual.length - lag);
    let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
    for (let i = start; i < end; i++) { const x = reference[i]!, y = actual[i + lag]!; sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y; }
    const count = end - start;
    const denominator = Math.sqrt((count * sumXX - sumX ** 2) * (count * sumYY - sumY ** 2));
    const score = count > 20 && denominator > 0 ? (count * sumXY - sumX * sumY) / denominator : -1;
    if (score > correlation) { correlation = score; offsetMs = lag * 10; }
  }
  signal?.throwIfAborted();
  if (JSON.stringify(await Promise.all(paths.map(path => mediaHash(directory, path)))) !== JSON.stringify(hashes)) throw new Error("检查期间音视频已改变，请检查当前版本");
  const inspection = { key, audioMatches: correlation >= 0.9 && Math.abs(offsetMs) <= 80 && Math.abs(audioDuration - videoDuration) <= 0.15 && (sourceVideoDuration === undefined || Math.abs(sourceVideoDuration - videoDuration) <= 0.15), offsetMs, correlation: Math.max(-1, Math.min(1, correlation)), audioDuration, videoDuration, sourceVideoDuration, note: "自动检查仅确认参考音轨相似度、整体偏移与时长；不能证明逐字口型同步，须记录实际音画检查中的失败或不确定区间。" };
  inspection.note = speechInspectionMessage(inspection);
  speechInspections.set(cacheKey, inspection);
  if (speechInspections.size > 32) speechInspections.delete(speechInspections.keys().next().value!);
  return { ...inspection };
}

export async function importSpeechTake(directory: string, input: { shotId: string; videoPath: string; audioPath: string; sourceVideoPath: string; inspectionKey: string; fullPlayback: true; speech: "pass"; lipSync: "pass"; note: string }) {
  if (input.fullPlayback !== true || input.speech !== "pass" || input.lipSync !== "pass") throw new Error("须确认当前版本全部可见发声区间同步；局部通过或不确定不能整体采用");
  const tenant = currentTenant(), api = cloud();
  if (!tenant || !api || tenant.role === "VIEWER") throw Object.assign(new Error("无权登记口型候选"), { status: 403 });
  const projectId = workspaceProject(directory)!;
  const scope = api.scoped(tenant.workspaceId);
  if (scope.get("shots", input.shotId)?.projectId !== projectId) throw new Error("镜头不属于当前工作区项目");
  const { project } = await readVoiceProject(directory);
  const line = project.lines.find(line => line.shotId === input.shotId && line.video?.path === input.sourceVideoPath && line.kind !== "narration"
    && line.takes.some(take => take.id === line.takeId && take.audio.path === input.audioPath && take.sourceKey === speechSourceKey(line, project.roles.find(role => role.id === line.roleId))));
  if (!line) throw new Error("口型结果须对应当前选定台词、声音和人物视频，旧版本或任意混音不能登记为同步候选");
  const inspection = await inspectSpeechSync(directory, input.audioPath, input.videoPath, undefined, input.sourceVideoPath);
  if (!inspection.audioMatches || inspection.key !== input.inspectionKey) throw new Error("声音检查未通过或素材已变化，请检核当前版本，不重生成");
  const video = await resolveWorkspacePath(directory, input.videoPath);
  const audio = await resolveWorkspacePath(directory, input.audioPath);
  const bytes = await readFile(video.path), audioBytes = await readFile(audio.path);
  const hashes = [createHash("sha256").update(audioBytes).digest("hex"), createHash("sha256").update(bytes).digest("hex"), await mediaHash(directory, input.sourceVideoPath)];
  if (createHash("sha256").update(JSON.stringify(hashes)).digest("hex") !== inspection.key) throw new Error("登记期间素材已改变，未采用");
  const matchingMedia = scope.list("media", { projectId, hash: hashes[1] });
  const output = matchingMedia.flatMap(media => scope.list("generation_outputs", { mediaId: media.id })).find(output => {
    const job = scope.get("generation_jobs", output.jobId);
    const saved = job?.parameters?.request;
    return job?.projectId === projectId && job.status === "SUCCEEDED" && job.kind === "video" && job.parameters?.directory === directory
      && saved?.providerId === project.lipSyncProviderId && saved?.modelId === project.lipSyncModelId
      && saved.speechSyncInputs?.lineId === line.id && saved.speechSyncInputs?.voiceSourceKey === line.takes.find(take => take.id === line.takeId)?.sourceKey
      && saved.speechSyncInputs?.audioHash === hashes[0] && saved.speechSyncInputs?.videoHash === hashes[2];
  });
  if (!output) throw new Error("找不到对应声音、原视频和结果字节的成功口型任务；混入相同音轨不能冒充口型处理");
  const shot = scope.get("shots", input.shotId)!;
  const planned = shot.creativeBrief?.dialogue?.lines;
  if (planned?.length && (planned.length !== 1 || planned[0].text !== line.text || planned[0].start !== 0)) throw new Error("当前是整镜的多句或延迟发声方案，不能把从第0秒开始的一句口型视频替代整镜；须先按台词窗口拆分对应发声片段");
  const existing = scope.list("takes", { shotId: input.shotId, mediaId: output.mediaId }).find(take => take.meta?.speechSync?.inspectionKey === inspection.key && take.meta.speechSync.specFingerprint === api.shotFingerprint(scope, input.shotId));
  if (existing) return existing;
  const edit = api.editView(scope, api.getEdit(scope, scope.get("shots", input.shotId)!.sequenceId, false));
  const source = edit.clips.find(clip => clip.shotId === input.shotId && edit.tracks.find(track => track.id === clip.trackId)?.kind === "video");
  if (!source || scope.get("media", source.source.mediaId!)?.hash !== hashes[2] || source.in !== 0 || source.speed !== 1
    || Math.abs(source.duration - inspection.videoDuration) > 0.15) throw new Error("口型结果不能用一句短视频替换另一长度或另一来源的整镜，请先对齐对应剪辑片段");
  return api.importWorkspaceSpeechTake(scope, projectId, input.shotId, Buffer.from(bytes), input.videoPath, Buffer.from(audioBytes), input.audioPath,
    { jobId: output.jobId, sourceMediaId: source.source.mediaId, specFingerprint: api.shotFingerprint(scope, input.shotId), inspectionKey: inspection.key, audioMatches: inspection.audioMatches, offsetMs: inspection.offsetMs, sourceVideoPath: input.sourceVideoPath, fullPlayback: true, note: input.note, actor: tenant.userId });
}
