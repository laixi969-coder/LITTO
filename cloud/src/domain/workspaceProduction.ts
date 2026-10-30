import { z } from "zod";
import { mkdtemp, readFile, writeFile, rm } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalQualityView, finalReviewSchema, reviewFinalQuality } from "./finalQuality.ts";
import { tx, type Scope } from "../db.ts";
import { assetInput, bindingInput, shotInput, worldSchema, lookSchema, stateDeltaSchema } from "./schema.ts";
import { createAsset, assetVersions } from "./assets.ts";
import { bindReference, createShot, updateShot, shotPartial } from "./shots.ts";
import { bad, conflict, notFound, sha256 } from "../util.ts";
import { mediaView, saveMedia, sniff, storage } from "../storage.ts";
import { compactProductionRead, qualityReviewPlan, needsLipSync } from "@toonflow/tool-media-generation/runtime";
import { productionQualityView } from "./qualityInspection.ts";
import { runQc } from "./qc.ts";
import { approveTake, promoteHero } from "./lifecycle.ts";
import { selectWorkingTake, applyOps, getEdit, editView, resolveClip } from "./nle.ts";
import { audioReviewSchema, reviewedSegmentsSchema, shotFingerprint, techniqueReviewSchema, motionReviewSchema, requireReviewed } from "./realism.ts";
import { creativeReviewSchema } from "./creativeDirection.ts";
import { searchFilmTechniques, techniqueStages } from "@toonflow/tool-media-generation/filmTechniques";
import { adReadiness, saveAdDirection } from "./adDirection.ts";
import { createSequence, sequenceInput } from "./sequences.ts";
import { searchLibrary, setLibraryFavorite, importFromLibrary, publishToLibrary } from "./library.ts";
import { planShotSpeech } from "./speechPlanning.ts";
import { probeBuffer, probeFile, runCmd } from "../media-tools.ts";
import { continuityPredecessor } from "./state.ts";

/** 接戏只从已返回的真实视频取帧；候选和检查状态保留，不代填完整看听。 */
export async function extractContinuationFrame(s: Scope, projectId: string, data: unknown) {
  const input = z.object({ shotId: z.string().min(1), takeId: z.string().min(1), seconds: z.number().finite().nonnegative().optional() }).strict().parse(data);
  const shot = s.get("shots", input.shotId), take = s.get("takes", input.takeId);
  const sourceShot = take && s.get("shots", take.shotId), media = take && s.get("media", take.mediaId);
  if (!shot || !take || !sourceShot || !media || [shot, take, sourceShot, media].some(item => item.projectId !== projectId)) throw notFound("project continuation source");
  if (continuityPredecessor(s, shot)?.id !== sourceShot.id) throw bad("接戏帧必须来自本镜明确接续的前镜视频");
  if (!media.mime.startsWith("video/")) throw bad("接戏来源必须是实际视频，不能使用静态主帧代替");
  if (shot.continuity?.mode === "continuous") {
    if (sourceShot.approvedTakeId !== take.id || take.status !== "approved") throw bad("连续动作须从前镜已采用视频取帧，不能使用未采用候选");
    requireReviewed(s, "take", take);
  }
  const edit = getEdit(s, sourceShot.sequenceId, true);
  const clips = edit.clips.filter(clip => clip.shotId === sourceShot.id && edit.tracks.some(track => track.id === clip.trackId && track.kind === "video" && !track.muted));
  if (clips.length !== 1 || resolveClip(s, clips[0]).mediaId !== media.id) throw bad("接戏来源须对应时间线中唯一采用的视频片段，请先明确前镜的实际剪入剪出位置");
  const clip = clips[0];
  const sourceCut = { clipId: clip.id, sourceIn: clip.in, sourceOut: clip.in + clip.duration * clip.speed, speed: clip.speed };
  const fingerprint = shotFingerprint(s, sourceShot.id);
  const directory = await mkdtemp(join(tmpdir(), "milimiliContinuation"));
  try {
    const bytes = await storage.get(media.storageKey);
    if (sha256(bytes) !== media.hash) throw conflict("前镜视频与记录不符", "stale");
    const source = join(directory, "source.mp4"), output = join(directory, "frame.png");
    await writeFile(source, bytes);
    const probe = await probeFile(source);
    if (!probe?.hasVideo || !probe.duration) throw bad("前镜视频不可读取");
    const seconds = input.seconds ?? Math.max(clip.in, Math.min(sourceCut.sourceOut, probe.duration) - 1 / edit.fps);
    if (shot.continuity?.mode === "continuous" && (seconds < clip.in || seconds >= sourceCut.sourceOut || sourceCut.sourceOut - seconds > Math.max(0.15, 2 / edit.fps))) throw bad("连续动作接戏帧须位于前镜实际剪出点附近；需要更早画面时先调整前镜剪点，不能重复播放已发生动作");
    if (seconds >= probe.duration) throw bad("接戏时间须在实际视频内");
    const extracted = await runCmd("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", source, "-frames:v", "1", output]);
    if (extracted.code !== 0) throw bad("前镜接戏帧提取失败");
    const image = await readFile(output);
    if (s.get("takes", take.id)?.mediaId !== media.id || shotFingerprint(s, sourceShot.id) !== fingerprint || continuityPredecessor(s, s.get("shots", shot.id)!)?.id !== sourceShot.id) throw conflict("提取期间前镜或接戏来源已改变", "stale");
    const currentClip = getEdit(s, sourceShot.sequenceId, false).clips.find(item => item.id === clip.id);
    if (!currentClip || currentClip.in !== sourceCut.sourceIn || currentClip.in + currentClip.duration * currentClip.speed !== sourceCut.sourceOut || currentClip.speed !== sourceCut.speed || resolveClip(s, currentClip).mediaId !== media.id) throw conflict("取帧期间前镜剪点已改变，请重新提取", "stale");
    const sourceKey = sha256(JSON.stringify([take.id, media.hash, fingerprint, seconds, sourceCut]));
    let frame = s.list("keyframes", { shotId: shot.id }).find(item => item.meta?.continuationSource?.key === sourceKey);
    if (!frame) {
      const saved = s.list("media", { projectId, hash: sha256(image) })[0] ?? await saveMedia(s.workspaceId, projectId, image, { source: "continuationFrame" });
      if (shotFingerprint(s, sourceShot.id) !== fingerprint || s.get("shots", shot.id)?.projectId !== projectId) throw conflict("保存期间接戏规格已改变", "stale");
      frame = s.insert("keyframes", { project_id: projectId, shot_id: shot.id, media_id: saved.id, status: "variant", meta: { source: "continuationFrame", continuationSource: { key: sourceKey, takeId: take.id, mediaId: media.id, hash: media.hash, fingerprint, seconds, sourceCut } } });
    }
    return { keyframe: frame, image, seconds, sourceTakeId: take.id, reviewStatus: "unverified" };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** 拆格或用户上传的干净单帧进入候选，采用仍复用聊天中的真实检查。 */
export async function importWorkspaceKeyframe(s: Scope, projectId: string, shotId: string, bytes: Buffer, path: string) {
  const shot = s.get("shots", shotId);
  if (!shot || shot.projectId !== projectId) throw notFound("project shot");
  if (!sniff(bytes)?.mime.startsWith("image/")) throw bad("关键帧须为可识别的图片");
  const hash = sha256(bytes);
  let media = s.list("media", { projectId, hash })[0];
  if (!media) media = await saveMedia(s.workspaceId, projectId, bytes, { source: "storyboard" });
  // 存储期间镜头可能被删除；再次核对，不能把候选挂到失效镜头。
  if (s.get("shots", shotId)?.projectId !== projectId) throw notFound("project shot");
  const existing = s.list("keyframes", { projectId, shotId, mediaId: media.id })[0];
  if (existing) return existing;
  const frame = s.insert("keyframes", { project_id: projectId, shot_id: shotId, media_id: media.id, status: "variant", meta: { source: "storyboard", workspacePath: path, hash } });
  if (s.get("shots", shotId)?.status === "planned") s.update("shots", shotId, { status: "keyframing" });
  return frame;
}

export async function importWorkspaceAudio(s: Scope, projectId: string, bytes: Buffer, kind: "speech" | "music" | "sfx" = "speech") {
  if (!s.get("projects", projectId)) throw notFound("project");
  if (!sniff(bytes)?.mime.startsWith("audio/")) throw bad("声音素材须为可识别的音频文件");
  const probe = kind === "speech" ? await probeBuffer(bytes) : null;
  if (kind === "speech" && (!probe?.hasAudio || !Number.isFinite(probe.duration) || probe.duration! <= 0)) throw bad("配音须有实际可解码音轨与实测时长，不能以文件声明或估时替代");
  let media = s.list("media", { projectId, hash: sha256(bytes) })[0] ?? await saveMedia(s.workspaceId, projectId, bytes, { source: kind === "speech" ? "speechReference" : "audioReference" });
  if (kind === "speech") media = s.update("media", media.id, { source: "speechReference", duration: probe!.duration });
  if (!s.get("projects", projectId)) throw notFound("project");
  return mediaView(media);
}

export async function importWorkspaceSpeechTake(s: Scope, projectId: string, shotId: string, bytes: Buffer, path: string, audioBytes: Buffer, audioPath: string, speechSync: Record<string, unknown>) {
  const shot = s.get("shots", shotId);
  if (!shot || shot.projectId !== projectId) throw notFound("project shot");
  if (!sniff(bytes)?.mime.startsWith("video/") || !sniff(audioBytes)?.mime.startsWith("audio/")) throw bad("口型候选需要实际视频与声音参考");
  let media = s.list("media", { projectId, hash: sha256(bytes) })[0];
  if (!media) media = await saveMedia(s.workspaceId, projectId, bytes, { source: "lipSync" });
  let audio = s.list("media", { projectId, hash: sha256(audioBytes) })[0];
  if (!audio) audio = await saveMedia(s.workspaceId, projectId, audioBytes, { source: "speechReference" });
  if (s.get("shots", shotId)?.projectId !== projectId) throw notFound("project shot");
  const existing = s.list("takes", { projectId, shotId, mediaId: media.id })[0];
  if (existing) {
    if (existing.meta?.speechSync?.inspectionKey !== speechSync.inspectionKey) throw conflict("这个视频已关联另一声音版本，不能覆盖原检查记录", "speech_review_stale");
    return existing;
  }
  // 对口型只新增候选，不替换原片，不自动批准人物、动作、接戏或最终同步。
  return s.insert("takes", { project_id: projectId, shot_id: shotId, keyframe_id: shot.heroKeyframeId, media_id: media.id, status: "candidate",
    meta: { source: "lipSync", workspacePath: path, speechSync: { ...speechSync, referenceMediaId: audio.id, audioPath } } });
}

/** 主机读取已授权资产的实际图片，不让模型猜测媒体存储路径。 */
export async function readWorkspaceAsset(s: Scope, projectId: string, data: Record<string, unknown>) {
  const asset = workspaceProduction(s, projectId, "readAsset", data) as any;
  const mediaIds = new Set<string>();
  if (asset.attributes?.authoritativeReference) mediaIds.add(asset.attributes.authoritativeReference);
  for (const id of asset.references ?? []) {
    const reference = s.get("refs", id);
    if (reference?.projectId !== projectId) throw notFound("project reference");
    if (reference.kind === "image" && reference.mediaId) mediaIds.add(reference.mediaId);
  }
  const images = [];
  for (const id of mediaIds) {
    const media = s.get("media", id);
    if (media?.projectId !== projectId || !media.mime.startsWith("image/")) throw notFound("project image");
    images.push({ mediaId: id, mimeType: media.mime, data: await storage.get(media.storageKey) });
  }
  return { asset, images };
}

/** 草稿可直接保存；采用与变更确认通过聊天决定卡片写入，和制作面板复用领域规则。 */
export function workspaceProduction(s: Scope, projectId: string, operation: string, data: Record<string, unknown>, actor?: string) {
  if (!s.get("projects", projectId)) throw notFound("project");
  if (operation === "planSpeech") {
    const input = z.object({ shotId: z.string().min(1), bindings: z.array(z.object({ lineIndex: z.number().int().nonnegative(), mediaId: z.string().min(1) }).strict()).max(40).default([]) }).strict().parse(data);
    return planShotSpeech(s, projectId, input.shotId, input.bindings);
  }
  if (operation === "searchTechniques") return searchFilmTechniques(z.object({
    query: z.string().trim().max(500).optional(), category: z.enum(["camera", "lighting", "composition", "editing", "sound", "story", "effects", "genre"]).optional(),
    stage: z.enum(techniqueStages).optional(), limit: z.number().int().min(1).max(20).optional(),
  }).strict().parse(data));
  if (operation === "readLibrary") return searchLibrary(s, data);
  if (operation === "readAsset") {
    const input = z.object({ assetId: z.string().min(1) }).strict().parse(data);
    const asset = s.get("assets", input.assetId);
    if (asset?.projectId !== projectId) throw notFound("project asset");
    return { ...asset, versions: assetVersions(s, asset.id) };
  }
  if (["favoriteAsset", "importAsset", "publishAsset"].includes(operation)) {
    if (!actor) throw bad("角色库操作须有已认证的操作人");
    if (operation === "favoriteAsset") {
      const input = z.object({ libraryId: z.string().min(1), favorite: z.boolean() }).strict().parse(data);
      return setLibraryFavorite(s, input.libraryId, input.favorite, actor);
    }
    if (operation === "importAsset") {
      const input = z.object({ libraryId: z.string().min(1) }).strict().parse(data);
      return importFromLibrary(s, input.libraryId, projectId, actor);
    }
    const input = z.object({ assetId: z.string().min(1) }).strict().parse(data);
    if (s.get("assets", input.assetId)?.projectId !== projectId) throw notFound("project asset");
    return publishToLibrary(s, input.assetId, actor);
  }
  if (operation === "soundCues") {
    const input = z.strictObject({
      sequenceId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
      cues: z.array(z.strictObject({
        trackId: z.string().min(1), mediaId: z.string().min(1), shotId: z.string().min(1).optional(),
        videoClipId: z.string().min(1).optional(), dialogueLineIndex: z.number().int().nonnegative().optional(),
        start: z.number().finite().nonnegative(), duration: z.number().finite().positive(), in: z.number().finite().nonnegative().default(0),
        gainDb: z.number().min(-60).max(24).default(0), fadeIn: z.number().finite().nonnegative().default(0), fadeOut: z.number().finite().nonnegative().default(0),
        purpose: z.string().trim().min(1).max(1000),
      })).min(1).max(100),
      duck: z.strictObject({ underRole: z.enum(["dialogue", "music", "sfx"]), amountDb: z.number().min(-40).max(-1) }).nullable().optional(),
    }).parse(data);
    if (s.get("sequences", input.sequenceId)?.projectId !== projectId) throw notFound("project sequence");
    const edit = getEdit(s, input.sequenceId, false);
    const seenDialogue = new Set<string>();
    const ops: unknown[] = input.cues.map(({ purpose, videoClipId, dialogueLineIndex, ...cue }) => {
      let dialogueText: string | undefined;
      const track = edit.tracks.find(track => track.id === cue.trackId);
      const media = s.get("media", cue.mediaId);
      if (!track || track.kind !== "audio" || track.locked || track.muted) throw bad("声音须写入未锁定、未静音的声音轨");
      if (!media || media.projectId !== projectId || !media.mime.startsWith("audio/")) throw bad("声音段须引用当前项目的真实音频素材");
      if (cue.shotId && s.get("shots", cue.shotId)?.sequenceId !== input.sequenceId) throw bad("声音对应镜头不属于当前序列");
      if (track.role === "dialogue" || videoClipId !== undefined || dialogueLineIndex !== undefined) {
        const clip = edit.clips.find(item => item.id === videoClipId);
        const shot = clip?.shotId ? s.get("shots", clip.shotId) : null;
        const line = dialogueLineIndex === undefined ? null : shot?.creativeBrief?.dialogue?.lines?.[dialogueLineIndex];
        if (!clip || edit.tracks.find(item => item.id === clip.trackId)?.kind !== "video" || !line || cue.shotId !== clip.shotId) throw bad("对白须传 readEdit 的 videoClipId、shotId 和 dialogueLineIndex，不能按场次估算落点");
        if (line.audio && (line.audio.mediaId !== cue.mediaId || line.audio.text !== line.text)) throw bad("对白音轨不是当前镜头规划绑定的原句配音，请重新 planSpeech，不能用别的声音凑窗口");
        const sourceEnd = clip.in + clip.duration * clip.speed;
        if (line.start < clip.in || line.end > sourceEnd) throw bad("当前剪辑截断了这句对白，请先解决剪辑与台词容量冲突");
        const start = clip.start + (line.start - clip.in) / clip.speed;
        const end = clip.start + (line.end - clip.in) / clip.speed;
        if (Math.abs(cue.start - start) > 0.001) throw bad(`对白落点不符：当前画面要求 ${start.toFixed(3)} 秒，提交的是 ${cue.start.toFixed(3)} 秒，请重新 readEdit`);
        if (cue.start + cue.duration > end + 0.001) throw bad(`配音超出对应台词窗口：${cue.duration.toFixed(3)} 秒声音，可用 ${(end - start).toFixed(3)} 秒。台词：${line.text}。保留完整台词，不自动挪到下一镜、删词、加速或截断`);
        if (!Number.isFinite(media.duration) || media.duration <= 0 || cue.in !== 0 || Math.abs(cue.duration - media.duration) > 0.02) throw bad("对白须使用已探测的整句音频时长，不能裁掉台词以塞入画面");
        if (line.lipSync === "visible") throw bad("这句需要可见口型同步；不能将独立 TTS 直接叠到旧画面，请使用专用对口型候选并完成实际看听检查");
        const key = `${videoClipId}:${dialogueLineIndex}`;
        if (seenDialogue.has(key) || edit.clips.some(item => item.shotId === cue.shotId && edit.tracks.find(track => track.id === item.trackId)?.role === "dialogue" && item.start < end && item.start + item.duration > start)) throw bad("对应台词窗口已有对白，请调整已有音轨，不重复叠加");
        seenDialogue.add(key);
        dialogueText = line.text;
      }
      return { type: "add_clip", clip: { ...cue, ...(videoClipId ? { linkedClipId: videoClipId, dialogueLineIndex, dialogueText } : {}), type: "media", label: purpose } };
    });
    if (input.duck !== undefined) ops.push({ type: "set_duck", duck: input.duck });
    return editView(s, applyOps(s, input.sequenceId, ops, input.expectedVersion));
  }
  if (operation === "adDirection" || operation === "readAdDirection") {
    const sequenceId = z.string().min(1).parse(data.sequenceId);
    if (s.get("sequences", sequenceId)?.projectId !== projectId) throw notFound("project sequence");
    if (operation === "adDirection") return saveAdDirection(s, projectId, sequenceId, data.direction);
    return { sequence: s.get("sequences", sequenceId), readiness: adReadiness(s, sequenceId) };
  }
  if (operation === "agentReviewFinal") {
    if (!actor) throw bad("成片代理审阅须有已认证的操作人");
    const input = z.object({ renderId: z.string().min(1), authorization: z.string().trim().min(1).max(2000), review: finalReviewSchema }).strict().parse(data);
    if (s.get("renders", input.renderId)?.projectId !== projectId) throw notFound("project render");
    return reviewFinalQuality(s, input.renderId, input.review, `agent:${actor}`, input.authorization);
  }
  if (operation === "agentReview") {
    if (!actor) throw bad("代理审阅须有已认证的操作人");
    const input = z.strictObject({
      targetType: z.enum(["keyframe", "take"]), targetId: z.string().min(1),
      authorization: z.string().trim().min(1).max(2000), note: z.string().trim().min(10).max(8000),
      frameTimes: z.array(z.number().finite().nonnegative()).max(600).default([]),
      fullPlayback: z.boolean().default(false), observedStateDelta: stateDeltaSchema.optional(), reviewedSegments: reviewedSegmentsSchema, audioReview: audioReviewSchema.optional(),
      creativeReview: creativeReviewSchema.optional(),
      techniqueReview: techniqueReviewSchema.optional(),
      motionReview: motionReviewSchema.optional(),
      observations: z.array(z.strictObject({ kind: z.string(), note: z.string().min(1) })).max(40).default([]),
    }).parse(data);
    const item = s.get(input.targetType === "keyframe" ? "keyframes" : "takes", input.targetId);
    const shot = item && s.get("shots", item.shotId);
    const media = item && s.get("media", item.mediaId);
    if (!item || !shot || !media || [item, shot, media].some(row => row.projectId !== projectId)) throw notFound("project output");
    if (!media.mime.startsWith(input.targetType === "take" ? "video/" : "image/")) throw bad("审阅目标的媒体类型不符");
    if (shot.creativeBrief && !input.creativeReview) throw bad("请由助手对照 creativeBrief 和实际输出填写 creativeReview：verdict 为 pass 或 revise，styling 说明妆发服装与视觉目标是否相符，staging 说明动作起点/实际攻防是否相符。无变形不等于造型与编排合格，不要求用户填写。");
    if (input.creativeReview?.verdict === "revise") input.observations.push({ kind: "creativeMismatch", note: `${input.creativeReview.styling}；${input.creativeReview.staging}` });
    if (input.targetType === "take" && (!media.duration || input.frameTimes.length < 2
      || input.frameTimes.some((time, index) => time >= media.duration || index > 0 && time <= input.frameTimes[index - 1]!))) {
      throw bad("视频工作版须记录至少两个递增且位于素材时长内的实际抽帧时间");
    }
    const plan = qualityReviewPlan(shot, input.targetType);
    // 后配音原片可先保留完整视觉检查与实际末态，声音未核验时只选工作版，供后续口型处理。
    const canApprove = input.fullPlayback && input.observedStateDelta
      && (!(needsLipSync(shot) || shot.creativeBrief?.dialogue?.lines?.length)
        || input.audioReview?.speech === "pass" && (!needsLipSync(shot) || input.audioReview.lipSync === "pass"));
    return tx(() => {
      const previous = s.list("qc_reports", { targetType: input.targetType, targetId: item.id }, "created_at DESC, rowid DESC")[0];
      // ACT: 同一素材和规格的有效代理检查只做一次；有新缺陷或要求修改时仍记录新结论。
      if (!input.observations.length && input.creativeReview?.verdict !== "revise"
        && previous?.evidence?.mediaId === item.mediaId && previous.evidence.fingerprint === shotFingerprint(s, shot.id, input.targetType)
        && previous.evidence.vision?.source === "delegatedAgent"
        && plan.checks.every(key => previous.evidence.reviewed?.includes(key))
        && (!input.fullPlayback || previous.evidence.fullPlayback)
        && (!input.observedStateDelta || JSON.stringify(input.observedStateDelta) === JSON.stringify(previous.evidence.observedStateDelta))
        && (!input.audioReview || JSON.stringify(input.audioReview) === JSON.stringify(previous.evidence.audioReview))
        && (!plan.techniques.length || JSON.stringify(input.techniqueReview) === JSON.stringify(previous.evidence.techniqueReview))
        && (!plan.motionPlan?.checkpoints.length || plan.motionPlan.checkpoints.every(checkpoint => previous.evidence.motionReview?.some((check: { id: string }) => check.id === checkpoint.id))
          && (!input.motionReview || JSON.stringify(input.motionReview) === JSON.stringify(previous.evidence.motionReview)))
        && (!input.reviewedSegments.length || JSON.stringify(input.reviewedSegments) === JSON.stringify(previous.evidence.reviewedSegments))) {
        const review = { report: previous, repairActions: s.list("repair_actions", { qcReportId: previous.id }) };
        if (previous.findings.some((finding: { severity: string }) => finding.severity === "high")) {
          return { selected: false, reused: true, review, reason: "已有严重问题记录。重复检查不能消除缺陷；请报告阻塞，不自动重生成" };
        }
        if (input.targetType === "keyframe" && shot.heroKeyframeId !== item.id) promoteHero(s, item.id, `agent:${actor}`);
        if (input.targetType === "take") {
          if (canApprove) approveTake(s, item.id, `agent:${actor}`);
          else selectWorkingTake(s, item.id);
        }
        return { selected: true, reused: true, status: s.get("shots", shot.id)?.approvedTakeId === item.id ? "approved" : "workingVersion", finalReviewRequired: true, review };
      }
      const review = runQc(s, shot.id, { type: input.targetType, id: item.id }, input.observations, {
        actor: `agent:${actor}`, note: input.note, observedStateDelta: input.observedStateDelta,
        fullPlayback: input.fullPlayback, reviewedSegments: input.reviewedSegments, audioReview: input.audioReview,
        techniqueReview: input.techniqueReview,
        motionReview: input.motionReview,
        reviewed: plan.fullPlayback && !input.fullPlayback ? [] : plan.checks,
        vision: { source: "delegatedAgent", authorization: input.authorization, frameTimes: input.frameTimes, creativeReview: input.creativeReview, audioReview: "notVerified", status: "workingVersion" },
      });
      if (review.report.findings.some(finding => finding.severity === "high")) return { selected: false, review, reason: "存在严重问题，已保留检查记录，未采用" };
      if (input.targetType === "keyframe") promoteHero(s, item.id, `agent:${actor}`);
      else if (canApprove) approveTake(s, item.id, `agent:${actor}`);
      else selectWorkingTake(s, item.id);

      return { selected: true, status: s.get("shots", shot.id)?.approvedTakeId === item.id ? "approved" : "workingVersion", finalReviewRequired: true, review, answer: "代理检查已记录；完整检查和实际末态齐备时已采用正式镜头，否则保留工作版。成片仍需最终看听验收" };
    });
  }
  const shots = s.list("shots", { projectId }, "sequence_id, ord");
  if (operation === "read") return compactProductionRead({
    decisions: { location: "chat", keyframes: "requestKeyframeApproval({keyframeIds:[...]})：可批量确认并保存主关键帧，不在 updateShot 或 compile 中传 heroKeyframeId", production: "requestProductionDecision：资产、定妆、视频、配音、剪辑和最终验收；有效采用无需重复确认", story: "requestStoryDecision / requestStoryApproval：在聊天中保存故事选择与采用" },
    projectId, quality: productionQualityView(s, projectId), world: s.list("worlds", { projectId }), looks: s.list("looks", { projectId }), assets: s.list("assets", { projectId }),
    sequences: s.list("sequences", { projectId }), shots, references: s.list("refs", { projectId }), bindings: s.list("reference_bindings", { projectId }),
    keyframes: s.list("keyframes", { projectId }), takes: s.list("takes", { projectId }), qc: s.list("qc_reports", { projectId }),
    media: s.list("media", { projectId }).map(mediaView),
    candidateBatches: s.list("candidate_batches", { projectId }), candidates: s.list("candidates", { projectId }),
    renders: s.list("renders", { projectId }).map(render => ({ ...render, quality: finalQualityView(s, render), media: render.mediaId ? mediaView(s.get("media", render.mediaId)) : null })),
  });
  if (operation === "world" || operation === "look") {
    if (shots.some(shot => shot.heroKeyframeId || shot.approvedTakeId)) throw conflict("已有采用镜头，请调用 requestProductionDecision 在聊天中确认世界或影调修改", "approved_world");
    const table = operation === "world" ? "worlds" : "looks";
    const current = s.list(table, { projectId }).find(item => operation === "world" || item.scope === "project");
    if (!current) throw notFound(table);
    const schema = operation === "world" ? worldSchema : lookSchema;
    const patch = schema.partial().strict().parse(data);
    return s.update(table, current.id, { data: schema.parse({ ...current, ...patch }) });
  }
  if (operation === "asset") {
    const parsed = assetInput.parse(data);
    for (const id of parsed.references) if (s.get("refs", id)?.projectId !== projectId) throw notFound("project reference");
    return createAsset(s, projectId, parsed);
  }
  if (operation === "reference") {
    const { mediaId, name } = z.object({ mediaId: z.string().min(1), name: z.string().max(260).optional() }).strict().parse(data);
    const media = s.get("media", mediaId);
    if (!media || media.projectId !== projectId) throw notFound("当前项目媒体");
    const kind = media.mime.split("/")[0];
    if (!["image", "video", "audio"].includes(kind)) throw bad("参考素材须为图片、视频或音频");
    return s.list("refs", { projectId, mediaId })[0]
      ?? s.insert("refs", { project_id: projectId, kind, name: name ?? null, media_id: mediaId, source: media.source ?? "upload" });
  }
  if (operation === "sequence") {
    return createSequence(s, projectId, sequenceInput.parse(data));
  }
  if (operation === "shot") return createShot(s, projectId, shotInput.parse(data));
  const shot = typeof data.shotId === "string" && s.get("shots", data.shotId);
  if (!shot || shot.projectId !== projectId) throw notFound("project shot");
  if (operation === "updateShot") {
    if ("heroKeyframeId" in data) throw bad("主关键帧须调用 requestKeyframeApproval({keyframeIds:[所选关键帧记录ID]})，在聊天中展示并保存采用；不能通过 updateShot 设置，也无需去制作面板点击");
    if ("approvedTakeId" in data) throw bad("视频采用须调用 requestProductionDecision({operation:'approveTake',data:{takeIds:[所选视频记录ID]}})，在聊天中确认并保存，无需去制作面板");
    const { shotId: _shotId, ...patch } = data;
    return updateShot(s, shot.id, shotPartial.strict().parse(patch));
  }
  if (operation === "binding") return bindReference(s, projectId, { type: "shot", id: shot.id }, bindingInput.parse(data));
  throw bad("未知制片操作");
}
