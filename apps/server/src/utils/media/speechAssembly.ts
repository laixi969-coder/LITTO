import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, unlink, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { FfmpegCommand } from "@toonflow/ffmpeg/types";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { speechSourceKey, syncShotSpeechSchema } from "@toonflow/tool-media-generation/voiceProject";
import { cloud } from "@/lib/cloud";
import { currentTenant, privateDataDirectory } from "@/utils/tenant";
import { workspaceProject } from "@/utils/media/jobs";
import { readVoiceProject, assertCurrentSpeechAudio } from "@/utils/media/voiceDecision";
import { generateMedia, listMediaModels } from "@/utils/media/generation";
import { mediaHash, probeMedia, inspectSpeechSync } from "@/utils/media/lipSync";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const lineSchema = z.object({
  lineIndex: z.number().int().nonnegative(), lineId: z.string(), takeId: z.string(), text: z.string(), sourceKey: z.string(),
  audioPath: z.string(), audioHash: hashSchema, audioMediaId: z.string(), start: z.number().nonnegative(), duration: z.number().positive(),
  visible: z.boolean(), requestId: z.uuid(),
  segment: z.object({ path: z.string(), hash: hashSchema, duration: z.number().positive() }).optional(),
  result: z.object({ path: z.string(), hash: hashSchema, mediaId: z.string(), jobId: z.string(), inspectionKey: hashSchema }).optional(),
});
const assemblySchema = z.object({
  id: hashSchema, directory: z.string(), projectId: z.string(), shotId: z.string(), sequenceId: z.string(), fingerprint: hashSchema,
  sourceMediaId: z.string(), sourceHash: hashSchema, sourcePath: z.string(), duration: z.number().positive().max(600),
  width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive().max(240), hasAudio: z.boolean(),
  providerId: z.string(), modelId: z.string(), lines: z.array(lineSchema).min(1).max(40),
  output: z.object({ videoPath: z.string(), audioPath: z.string(), videoHash: hashSchema, audioHash: hashSchema, mediaId: z.string(), inspectionKey: hashSchema }).optional(),
});
type SpeechAssembly = z.infer<typeof assemblySchema>;
const running = new Set<string>();

function context(directory: string) {
  const api = cloud(), tenant = currentTenant();
  if (!api || !tenant || tenant.role === "VIEWER") throw new Error("整镜口型处理需要当前工作区编辑权限");
  const projectId = workspaceProject(directory, false);
  if (!projectId) throw new Error("工作目录尚未关联镜头项目");
  return { api, tenant, projectId, scope: api.scoped(tenant.workspaceId) };
}

function recordPath(id: string) {
  return join(privateDataDirectory(), "speechAssemblies", `assembly${hashSchema.parse(id)}.json`);
}

async function save(assembly: SpeechAssembly) {
  await mkdir(join(privateDataDirectory(), "speechAssemblies"), { recursive: true });
  await writeAtomic(recordPath(assembly.id), JSON.stringify(assemblySchema.parse(assembly)));
}

export async function readSpeechAssembly(directory: string, id: string) {
  const assembly = assemblySchema.parse(JSON.parse(await readFile(recordPath(id), "utf8")));
  const { projectId } = context(directory);
  if (assembly.id !== id || assembly.directory !== directory || assembly.projectId !== projectId) throw new Error("整镜口型记录不属于当前项目");
  return assembly;
}

async function assertCurrent(assembly: SpeechAssembly, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { api, scope } = context(assembly.directory);
  const shot = scope.get("shots", assembly.shotId);
  if (shot?.projectId !== assembly.projectId || shot.sequenceId !== assembly.sequenceId || api.shotFingerprint(scope, shot.id) !== assembly.fingerprint)
    throw new Error("镜头或对白规格已变化，旧口型任务和原片已保留；请按当前规格重新 syncSpeech");
  api.assertSpeechPlan(scope, shot);
  await assertCurrentSpeechAudio(assembly.directory, shot, signal);
  const { project } = await readVoiceProject(assembly.directory);
  if (project.lipSyncProviderId !== assembly.providerId || project.lipSyncModelId !== assembly.modelId) throw new Error("口型模型已改变，不能继续旧制作记录");
  for (const line of assembly.lines) {
    const current = project.lines.find(item => item.id === line.lineId), take = current?.takes.find(item => item.id === current.takeId);
    if (!current || current.shotId !== shot.id || current.takeId !== line.takeId || take?.sourceKey !== line.sourceKey
      || speechSourceKey(current, project.roles.find(role => role.id === current.roleId)) !== line.sourceKey
      || take.audio.path !== line.audioPath || await mediaHash(assembly.directory, line.audioPath) !== line.audioHash)
      throw new Error(`第${line.lineIndex + 1}句采用声音或原文已变化，停止旧任务，不自动覆盖或重生成`);
  }
  if (scope.get("media", assembly.sourceMediaId)?.hash !== assembly.sourceHash || await mediaHash(assembly.directory, assembly.sourcePath) !== assembly.sourceHash)
    throw new Error("人物原片已改变，不能复用旧口型片段");
  const edit = api.editView(scope, api.getEdit(scope, assembly.sequenceId, false));
  const clips = edit.clips.filter(clip => clip.shotId === shot.id && edit.tracks.find(track => track.id === clip.trackId)?.kind === "video");
  if (clips.length !== 1 || clips[0].speed !== 1 || ![assembly.sourceMediaId, assembly.output?.mediaId].includes(clips[0].source.mediaId!))
    throw new Error("原镜剪辑来源或速度已变化，停止处理并保留已有结果");
  signal?.throwIfAborted();
}

async function renderFile(directory: string, command: FfmpegCommand, extension: string, signal?: AbortSignal) {
  const path = `assets/speech/part${randomUUID().replaceAll("-", "")}.${extension}`;
  const resolved = await resolveWorkspacePath(directory, path, true);
  const cancel = () => command.kill("SIGKILL");
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => command.on("error", reject).on("end", () => resolve())
      .on("start", () => { if (signal?.aborted) cancel(); }).save(path));
    signal?.throwIfAborted();
    return { path, hash: await mediaHash(directory, path) };
  } catch (error) {
    await unlink(resolved.path).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); }
}

export async function validateSpeechSegmentRequest(directory: string, request: MediaGenerationRequest, signal?: AbortSignal) {
  const segment = z.strictObject({ assemblyId: hashSchema, lineIndex: z.number().int().nonnegative(), requestId: z.uuid() }).parse(request.speechSegment);
  const assembly = await readSpeechAssembly(directory, segment.assemblyId);
  await assertCurrent(assembly, signal);
  const line = assembly.lines.find(line => line.lineIndex === segment.lineIndex);
  if (!line?.visible || !line.segment || line.requestId !== segment.requestId || request.providerId !== assembly.providerId || request.modelId !== assembly.modelId
    || request.shotId || request.productionFingerprint || request.generateAudio === false || request.videos?.length !== 1 || request.audios?.length !== 1
    || request.videos[0].path !== line.segment.path || request.audios[0].path !== line.audioPath
    || await mediaHash(directory, line.segment.path) !== line.segment.hash) throw new Error("逐句口型请求与服务端保存的真实片段不一致");
  return { videoHash: line.segment.hash, audioHash: line.audioHash, videoDuration: line.segment.duration, audioDuration: line.duration,
    ratio: `${assembly.width}:${assembly.height}`, lineId: line.lineId, voiceSourceKey: line.sourceKey,
    assemblyId: assembly.id, lineIndex: line.lineIndex, start: line.start, sourceVideoHash: assembly.sourceHash, specFingerprint: assembly.fingerprint };
}

async function createAssembly(directory: string, shotId: string, signal?: AbortSignal) {
  const { api, scope, projectId } = context(directory), shot = scope.get("shots", shotId);
  if (shot?.projectId !== projectId) throw new Error("镜头不属于当前项目");
  api.assertSpeechPlan(scope, shot);
  await assertCurrentSpeechAudio(directory, shot, signal);
  const planned = shot.creativeBrief?.dialogue?.lines ?? [];
  if (!planned.length || api.shotDialogueMode(scope, shot) !== "post") throw new Error("syncSpeech 用于已有采用配音的后配对白镜头");
  const fingerprint = api.shotFingerprint(scope, shot.id);
  const edit = api.editView(scope, api.getEdit(scope, shot.sequenceId, false));
  const clips = edit.clips.filter(clip => clip.shotId === shot.id && edit.tracks.find(track => track.id === clip.trackId)?.kind === "video");
  if (clips.length !== 1 || clips[0].speed !== 1) throw new Error("整镜口型需要一条正常速度的视频片段，不改变现有剪辑速度或重复镜头");
  const media = scope.get("media", clips[0].source.mediaId!);
  if (media?.projectId !== projectId || !media.mime.startsWith("video/") || media.size > 100 * 1024 * 1024) throw new Error("请选择本镜现有的有效视频工作版，单镜最多100MB");
  if (media.source?.startsWith("speechAssembly:")) {
    const completed = await readSpeechAssembly(directory, media.source.slice("speechAssembly:".length));
    await assertCurrent(completed, signal);
    return completed;
  }
  const { project } = await readVoiceProject(directory);
  const model = (await listMediaModels(true)).find(item => item.providerId === project.lipSyncProviderId && item.modelId === project.lipSyncModelId && item.lipSync);
  if (planned.some((line: { lipSync: string }) => line.lipSync === "visible") && !model) throw new Error("请先 configureVoice 保存可用的专用口型模型");
  const folder = await resolveWorkspacePath(directory, "assets/speech", true);
  await mkdir(folder.path, { recursive: true });
  const sourcePath = `assets/speech/source${media.hash}.mp4`;
  const bytes = await api.storage.get(media.storageKey);
  if (createHash("sha256").update(bytes).digest("hex") !== media.hash) throw new Error("原视频与媒体记录不一致");
  await writeAtomic((await resolveWorkspacePath(directory, sourcePath, true)).path, bytes, { exclusive: true }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || await mediaHash(directory, sourcePath) !== media.hash) throw error;
  });
  const ffmpeg = await createWorkspaceFfmpeg(directory, signal, true), probe = await probeMedia(ffmpeg, sourcePath);
  const video = probe.streams.find(stream => stream.codec_type === "video");
  const duration = Number(video?.duration ?? probe.format.duration), [numerator, denominator] = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const fps = numerator / denominator;
  if (!video?.width || !video.height || !Number.isFinite(fps) || fps <= 0 || fps > 240 || !Number.isFinite(duration) || duration <= 0 || duration > 600)
    throw new Error("原视频的尺寸、帧率或时长无法核验，单次整镜口型最多10分钟");
  const lines: SpeechAssembly["lines"] = [];
  for (const [lineIndex, plan] of planned.entries()) {
    const matches = project.lines.filter(line => line.shotId === shotId && (line.dialogueLineIndex === lineIndex || line.dialogueLineIndex === undefined && line.text.trim() === plan.text)
      && line.text.trim() === plan.text && project.roles.some(role => role.id === line.roleId && (role.assetId ? role.assetId === plan.speakerId : role.name.trim() === scope.get("assets", plan.speakerId)?.name?.trim())));
    if (matches.length !== 1) throw new Error(`第${lineIndex + 1}句须唯一关联原句、角色和 dialogueLineIndex`);
    const line = matches[0], take = line.takes.find(take => take.id === line.takeId);
    if (!take || take.sourceKey !== speechSourceKey(line, project.roles.find(role => role.id === line.roleId))) throw new Error("当前采用配音已失效");
    const audio = await probeMedia(ffmpeg, take.audio.path), audioDuration = Number(audio.format.duration);
    const audioHash = await mediaHash(directory, take.audio.path);
    if (!audio.streams.some(stream => stream.codec_type === "audio") || !Number.isFinite(audioDuration) || audioDuration <= 0
      || plan.start + audioDuration > Math.min(plan.end, duration) + 0.001 || plan.start < (lines.at(-1)?.start ?? 0) + (lines.at(-1)?.duration ?? 0) - 0.001
      || scope.get("media", plan.audio?.mediaId)?.hash !== audioHash) throw new Error(`第${lineIndex + 1}句真实声音超出窗口、重叠或与规划不一致；先 planSpeech 更新声音窗口，不截断或加速台词`);
    lines.push({ lineIndex, lineId: line.id, takeId: take.id, text: plan.text, sourceKey: take.sourceKey, audioPath: take.audio.path, audioHash,
      audioMediaId: plan.audio.mediaId, start: plan.start, duration: audioDuration, visible: plan.lipSync === "visible", requestId: randomUUID() });
  }
  const id = createHash("sha256").update(JSON.stringify([1, directory, projectId, shotId, fingerprint, media.id, media.hash,
    project.lipSyncProviderId, project.lipSyncModelId, lines.map(({ requestId, ...line }) => line)])).digest("hex");
  try { const saved = await readSpeechAssembly(directory, id); await assertCurrent(saved, signal); return saved; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const assembly = assemblySchema.parse({ id, directory, projectId, shotId, sequenceId: shot.sequenceId, fingerprint,
    sourceMediaId: media.id, sourceHash: media.hash, sourcePath, duration, width: video.width, height: video.height, fps,
    hasAudio: probe.streams.some(stream => stream.codec_type === "audio"), providerId: project.lipSyncProviderId, modelId: project.lipSyncModelId, lines });
  await assertCurrent(assembly, signal);
  await save(assembly);
  return assembly;
}

async function verifyResults(assembly: SpeechAssembly, signal?: AbortSignal) {
  await assertCurrent(assembly, signal);
  const { scope } = context(assembly.directory);
  for (const line of assembly.lines.filter(line => line.visible)) {
    if (!line.segment || !line.result) throw new Error("仍有未完成的口型片段，不能合成或采用");
    const job = scope.get("generation_jobs", line.result.jobId), input = job?.parameters?.request;
    if (job?.projectId !== assembly.projectId || job.status !== "SUCCEEDED" || job.kind !== "video" || job.parameters?.directory !== assembly.directory
      || input?.speechSegment?.assemblyId !== assembly.id || input.speechSegment.lineIndex !== line.lineIndex || input.speechSegment.requestId !== line.requestId
      || input.providerId !== assembly.providerId || input.modelId !== assembly.modelId
      || input.speechSyncInputs?.videoHash !== line.segment.hash || input.speechSyncInputs?.audioHash !== line.audioHash
      || !scope.list("generation_outputs", { jobId: job.id }).some(output => output.mediaId === line.result!.mediaId)
      || scope.get("media", line.result.mediaId)?.hash !== line.result.hash || await mediaHash(assembly.directory, line.result.path) !== line.result.hash
      || await mediaHash(assembly.directory, line.segment.path) !== line.segment.hash) throw new Error("口型片段任务或输入输出关联已失效，不能拼接旧结果");
  }
}

export async function validateSpeechAssembly(directory: string, id: string) {
  const assembly = await readSpeechAssembly(directory, id);
  await verifyResults(assembly);
  const { scope } = context(directory), output = assembly.output;
  if (!output || scope.get("media", output.mediaId)?.hash !== output.videoHash
    || scope.get("media", output.mediaId)?.source !== `speechAssembly:${id}`
    || await mediaHash(directory, output.videoPath) !== output.videoHash || await mediaHash(directory, output.audioPath) !== output.audioHash)
    throw new Error("整镜合成尚未完成或文件已改变，不能沿用旧观察");
  return assembly;
}

/** 内部固定 FFmpeg 图；只处理当前已采用声音的窗口，不开放任意视频导出或更改镜头规格。 */
export async function syncShotSpeech(directory: string, input: unknown, signal?: AbortSignal, onProgress?: (message: string) => void) {
  const { shotId } = syncShotSpeechSchema.parse(input), key = `${directory}:${shotId}`;
  if (running.has(key)) throw new Error("此镜口型正在处理，请等待原任务完成，不重复提交");
  running.add(key);
  try {
    const assembly = await createAssembly(directory, shotId, signal);
    const { api, scope, tenant } = context(directory);
    const ffmpeg = await createWorkspaceFfmpeg(directory, signal, true);
    if (!assembly.output) {
      for (const line of assembly.lines.filter(line => line.visible)) {
        await assertCurrent(assembly, signal);
        onProgress?.(`处理第${line.lineIndex + 1}句口型：${line.start.toFixed(3)}秒起，保留完整配音`);
        if (!line.segment) {
          const segment = await renderFile(directory, ffmpeg(assembly.sourcePath).seekInput(line.start).duration(line.duration).noAudio()
            .videoCodec("libx264").outputOptions(["-pix_fmt yuv420p", "-crf 18", "-preset fast", "-map_metadata -1"]), "mp4", signal);
          const probe = await probeMedia(ffmpeg, segment.path), duration = Number(probe.streams.find(stream => stream.codec_type === "video")?.duration ?? probe.format.duration);
          if (!Number.isFinite(duration) || Math.abs(duration - line.duration) > 0.15) throw new Error("自动裁片时长未对齐实际配音，原片保留");
          line.segment = { ...segment, duration };
          await assertCurrent(assembly, signal); await save(assembly);
        }
        if (!line.result) {
          const files = await generateMedia(directory, "video", { providerId: assembly.providerId, modelId: assembly.modelId, purpose: "standalone",
            prompt: "Synchronize the visible speaker to the supplied complete recording. Preserve the camera, action and all other people.",
            videos: [{ path: line.segment.path, mimeType: "video/mp4" }], audios: [{ path: line.audioPath, mimeType: "audio/wav" }], generateAudio: true,
            outputName: `speech${assembly.id}Line${line.lineIndex}`, speechSegment: { assemblyId: assembly.id, lineIndex: line.lineIndex, requestId: line.requestId } }, signal, onProgress);
          const file = files.find(file => file.mediaType === "video");
          if (!file) throw new Error("口型任务没有返回视频，保留任务记录，不重新提交");
          const inspection = await inspectSpeechSync(directory, line.audioPath, file.path, signal, line.segment.path);
          if (!inspection.audioMatches) throw new Error(`第${line.lineIndex + 1}句口型声音核验未通过：${inspection.note}`);
          const probe = await probeMedia(ffmpeg, file.path), frame = probe.streams.find(stream => stream.codec_type === "video");
          if (frame?.width !== assembly.width || frame.height !== assembly.height) throw new Error("口型结果改变了原片尺寸，保留结果，不拉伸或重生成");
          const hash = await mediaHash(directory, file.path);
          const receipt = api.dbGet("SELECT response FROM idempotency_keys WHERE workspace_id=? AND key=?", tenant.workspaceId, `workspaceMedia:${line.requestId}`);
          const job = receipt && scope.get("generation_jobs", JSON.parse(receipt.response).id);
          const output = job && scope.list("generation_outputs", { jobId: job.id }).find(output => scope.get("media", output.mediaId)?.hash === hash);
          if (!output) throw new Error("找不到对应的成功口型输出，保留文件，不自动补发任务");
          line.result = { path: file.path, hash, mediaId: output.mediaId, jobId: job.id, inspectionKey: inspection.key };
          await assertCurrent(assembly, signal); await save(assembly);
        }
      }
      await verifyResults(assembly, signal);
      onProgress?.("按原始时间位置合回完整镜头，保留发声间隙与完整台词");
      const audioCommand = ffmpeg(assembly.sourcePath);
      assembly.lines.forEach(line => audioCommand.input(line.audioPath));
      const muted = assembly.lines.map(line => `between(t,${line.start},${line.start + line.duration})`).join("+");
      const audioFilters = [assembly.hasAudio
        ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=0:enable='${muted}',apad,atrim=duration=${assembly.duration}[baseAudio]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${assembly.duration}[baseAudio]`,
      ...assembly.lines.map((line, index) => `[${index + 1}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${Math.round(line.start * 48000)}S:all=1[lineAudio${index}]`),
      `[baseAudio]${assembly.lines.map((_line, index) => `[lineAudio${index}]`).join("")}amix=inputs=${assembly.lines.length + 1}:duration=first:dropout_transition=0:normalize=0[fullAudio]`];
      const audio = await renderFile(directory, audioCommand.complexFilter(audioFilters).outputOptions(["-map [fullAudio]", "-vn", "-c:a pcm_s16le", "-ar 24000"]), "wav", signal);
      const visible = assembly.lines.filter(line => line.visible), videoCommand = ffmpeg(assembly.sourcePath);
      visible.forEach(line => videoCommand.input(line.result!.path));
      videoCommand.input(audio.path);
      const filters = ["[0:v]setpts=PTS-STARTPTS[baseVideo]", ...visible.flatMap((line, index) => [
        `[${index + 1}:v]fps=${assembly.fps},setpts=PTS-STARTPTS+${line.start}/TB[part${index}]`,
        `[${index ? `merged${index - 1}` : "baseVideo"}][part${index}]overlay=eof_action=pass:repeatlast=0:enable='gte(t,${line.start})*lt(t,${line.start + line.duration})'[merged${index}]`,
      ])];
      const video = await renderFile(directory, videoCommand.complexFilter(filters).outputOptions([
        `-map [${visible.length ? `merged${visible.length - 1}` : "baseVideo"}]`, `-map ${visible.length + 1}:a`,
        "-c:v libx264", "-crf 18", "-preset fast", "-pix_fmt yuv420p", "-c:a aac", "-b:a 192k", "-map_metadata -1", `-t ${assembly.duration}`,
      ]), "mp4", signal);
      const inspection = await inspectSpeechSync(directory, audio.path, video.path, signal, assembly.sourcePath);
      if (!inspection.audioMatches) throw new Error(`整镜声音或时长核验未通过：${inspection.note}`);
      await verifyResults(assembly, signal);
      const savedMedia = await api.saveMedia(tenant.workspaceId, assembly.projectId, await readFile((await resolveWorkspacePath(directory, video.path)).path), { source: `speechAssembly:${assembly.id}` });
      assembly.output = { videoPath: video.path, audioPath: audio.path, videoHash: video.hash, audioHash: audio.hash, mediaId: savedMedia.id, inspectionKey: inspection.key };
      await assertCurrent(assembly, signal); await save(assembly);
    }
    await validateSpeechAssembly(directory, assembly.id);
    return { assemblyId: assembly.id, shotId, ...assembly.output!, sourceVideoPath: assembly.sourcePath,
      windows: assembly.lines.map(line => ({ lineIndex: line.lineIndex, start: line.start, end: line.start + line.duration, text: line.text, lipSync: line.visible ? "visible" : "offscreen", jobId: line.result?.jobId })),
      note: "整镜已自动拆片、对口型并按原时间合回；未自动采用。先 observeAutoFilmVideo 完整看听此 mediaId，再 importSpeech 携带 assemblyId 与返回路径、inspectionKey；登记后重新观察摄影清单并 reviewProduction。不要再向 A1 重复铺这批对白。" };
  } finally { running.delete(key); }
}

export async function importAssembledSpeechTake(directory: string, input: { assemblyId?: string; shotId: string; videoPath: string; audioPath: string; sourceVideoPath: string; inspectionKey: string; note: string }) {
  const assembly = await validateSpeechAssembly(directory, hashSchema.parse(input.assemblyId)), output = assembly.output!;
  if (input.shotId !== assembly.shotId || input.videoPath !== output.videoPath || input.audioPath !== output.audioPath
    || input.sourceVideoPath !== assembly.sourcePath || input.inspectionKey !== output.inspectionKey) throw new Error("导入参数与当前完整口型结果不一致");
  const inspection = await inspectSpeechSync(directory, output.audioPath, output.videoPath, undefined, assembly.sourcePath);
  if (!inspection.audioMatches || inspection.key !== output.inspectionKey) throw new Error("整镜声音检查已失效");
  const { api, scope, tenant } = context(directory);
  const bytes = await readFile((await resolveWorkspacePath(directory, output.videoPath)).path), audio = await readFile((await resolveWorkspacePath(directory, output.audioPath)).path);
  if (createHash("sha256").update(bytes).digest("hex") !== output.videoHash || createHash("sha256").update(audio).digest("hex") !== output.audioHash) throw new Error("导入期间整镜文件已变化");
  await assertCurrent(assembly);
  return api.importWorkspaceSpeechTake(scope, assembly.projectId, assembly.shotId, bytes, output.videoPath, audio, output.audioPath, {
    assemblyId: assembly.id, sourceMediaId: assembly.sourceMediaId, sourceVideoHash: assembly.sourceHash, composedHash: output.videoHash, audioHash: output.audioHash,
    specFingerprint: assembly.fingerprint, inspectionKey: inspection.key, audioMatches: true, offsetMs: inspection.offsetMs,
    sourceVideoPath: assembly.sourcePath, fullPlayback: true, note: input.note, actor: tenant.userId,
    segments: assembly.lines.map(line => ({ lineIndex: line.lineIndex, text: line.text, start: line.start, duration: line.duration, visible: line.visible,
      audioMediaId: line.audioMediaId, audioHash: line.audioHash, lineId: line.lineId, sourceKey: line.sourceKey,
      ...(line.result ? { jobId: line.result.jobId, mediaId: line.result.mediaId, hash: line.result.hash, segmentHash: line.segment!.hash } : {}) })),
  });
}
