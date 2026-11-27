import type { Scope } from "../db.ts";
import { resolveDialogueMode } from "@toonflow/tool-media-generation/runtime";
import { sha256 } from "../util.ts";
import { isAdSequence } from "./adDirection.ts";
import type { prepareInspectionSources } from "./musicInspection.ts";
import { getEdit, nativeDialogueWindows, resolveClip } from "./nle.ts";
import { shotFingerprint } from "./realism.ts";
import type { ShotInput } from "./schema.ts";
import { createSpeechInspector, type SpeechAlignment } from "./speechAlignment.ts";
import { speechMedia } from "./speechPlanning.ts";

type DialogueLine = NonNullable<ShotInput["creativeBrief"]>["dialogue"]["lines"][number];
type PlannedLine = {
  shotId: string; shotTitle?: string; lineIndex: number; text: string; speaker?: string; time: number | null; end: number | null;
  referenceKind: "recording" | "takeAudio" | null; mediaId: string | null; sourceTime: number; duration: number; reason?: string;
};

/** 旧单句口型视频可能只在已采用的 Take 上记声音。核对实际成功任务及当时核验的三份文件。 */
function legacyRecording(s: Scope, shot: Record<string, any>, takeMedia: Record<string, any>, sync: Record<string, any>) {
  if (!sync.referenceMediaId || !sync.sourceMediaId || !sync.jobId || !sync.specFingerprint) return null;
  const audio = s.get("media", sync.referenceMediaId), source = s.get("media", sync.sourceMediaId);
  const job = s.get("generation_jobs", sync.jobId), inputs = job?.parameters?.request?.speechSyncInputs;
  if (!audio || audio.projectId !== shot.projectId || !audio.mime?.startsWith("audio/") || !Number.isFinite(audio.duration) || audio.duration <= 0 || !audio.hash
    || !source || source.projectId !== shot.projectId || !source.hash || !takeMedia.hash
    || !job || job.projectId !== shot.projectId || job.status !== "SUCCEEDED" || job.kind !== "video"
    || inputs?.audioHash !== audio.hash || inputs?.videoHash !== source.hash
    || sync.inspectionKey !== sha256(JSON.stringify([audio.hash, takeMedia.hash, source.hash]))
    || !s.list("generation_outputs", { jobId: job.id, mediaId: takeMedia.id }).length
    || sync.specFingerprint !== shotFingerprint(s, shot.id)) return null;
  return audio;
}

export function speechInspectionPlan(s: Scope, sequenceId: string) {
  const sequence = s.get("sequences", sequenceId);
  if (!sequence || !(isAdSequence(sequence) || ["story", "serial"].includes(sequence.kind ?? "story"))) return null;
  const shots = s.list("shots", { projectId: sequence.projectId, sequenceId }, "ord").filter(shot => shot.creativeBrief?.dialogue?.lines?.length);
  if (!shots.length) return null;
  const edit = getEdit(s, sequenceId, false);
  const tracks = new Map(edit.tracks.map(track => [track.id, track]));
  const lines: PlannedLine[] = [];
  for (const shot of shots) {
    const dialogue: DialogueLine[] = shot.creativeBrief.dialogue.lines;
    const pictures = edit.clips.filter(clip => clip.shotId === shot.id && tracks.get(clip.trackId)?.kind === "video" && !tracks.get(clip.trackId)?.muted);
    const take = shot.approvedTakeId ? s.get("takes", shot.approvedTakeId) : null;
    const takeMedia = take?.status === "approved" && take.shotId === shot.id && take.projectId === shot.projectId && take.mediaId ? s.get("media", take.mediaId) : null;
    const adoptedId = takeMedia && takeMedia.projectId === shot.projectId && takeMedia.mime?.startsWith("video/") ? takeMedia.id : null;
    const sync = adoptedId ? take?.meta?.speechSync : null;
    // 按这份成片已采用的素材查来源。其他集后来增加说话人，不应改变历史镜头的声音。
    const useTakeAudio = resolveDialogueMode(shot) === "native" && !sync?.audioMatches;
    const windows = useTakeAudio ? pictures.flatMap(picture => nativeDialogueWindows(s, edit, picture, dialogue).map(window => ({ ...window, picture }))) : [];
    for (const [lineIndex, line] of dialogue.entries()) {
      const speaker = s.get("assets", line.speakerId);
      const row: PlannedLine = { shotId: shot.id, shotTitle: shot.title, lineIndex, text: line.text, speaker: speaker && speaker.projectId === shot.projectId ? speaker.name : line.speakerId,
        time: null, end: null, referenceKind: null, mediaId: null, sourceTime: 0, duration: line.end - line.start };
      // 旧的或静音的逐句轨仍表明这里排过配音，不能改用镜头的配乐来证明对白对齐。
      const cues = edit.clips.filter(audio => audio.shotId === shot.id && audio.dialogueLineIndex === lineIndex
        && tracks.get(audio.trackId)?.kind === "audio" && pictures.some(picture => picture.id === audio.linkedClipId));
      if (useTakeAudio && !cues.length) {
        const matches = windows.filter(window => window.lineIndex === lineIndex);
        const [window] = matches;
        if (window && matches.length === 1) {
          row.time = window.start;
          row.end = window.end;
          const id = resolveClip(s, window.picture).mediaId;
          if (window.complete && window.synced && id && id === adoptedId) {
            row.mediaId = id;
            row.referenceKind = "takeAudio";
            row.sourceTime = line.start;
          }
        }
        if (!row.mediaId) row.reason = "无法将这句唯一对应到已采用镜头的完整原速原声";
        lines.push(row);
        continue;
      }
      const placements = pictures.filter(clip => clip.in <= line.start + 0.001 && clip.in + clip.duration * clip.speed >= line.end - 0.001);
      if (!placements.length) { lines.push({ ...row, reason: "当前剪辑没有完整保留这句的计划窗口" }); continue; }
      for (const clip of placements) {
        const time = Math.max(0, clip.start + (line.start - clip.in) / clip.speed);
        const item = { ...row, time, end: time + row.duration / clip.speed };
        const linked = cues.filter(audio => audio.linkedClipId === clip.id);
        const placed = linked.filter(audio => !tracks.get(audio.trackId)!.muted && audio.gainDb + tracks.get(audio.trackId)!.gainDb > -60);
        const [cue] = placed;
        // 旧工程可能只在对白音轨登记整句配音，须同时核对镜头、句号、原文和项目。
        const audio = line.audio ?? (cue?.mediaId ? { mediaId: cue.mediaId, text: line.text } : undefined);
        const media = !audio && !linked.length && takeMedia && dialogue.length === 1 && !sync?.assemblyId && sync?.audioMatches && line.start === 0
          && adoptedId === resolveClip(s, clip).mediaId
          ? legacyRecording(s, shot, takeMedia, sync) : speechMedia(s, shot.projectId, { ...line, audio });
        if (!line.audio && linked.length && !placed.length) {
          item.reason = "对应的独立对白轨已静音或音量过低，无法定位本句";
        } else if (!media) {
          item.reason = "缺少与当前原句对应的已采用录音";
        } else if (placed.length > 1 || (cue && (cue.mediaId !== media.id || cue.dialogueText !== line.text))) {
          item.reason = "这句的排轨与采用录音不唯一或版本不符";
        } else if (!line.audio && cue && (cue.in !== 0 || cue.fadeIn || cue.fadeOut || Math.abs(cue.start - time) > 0.001 || Math.abs(cue.duration - media.duration) > 0.001)) {
          item.reason = "历史对白轨未按原句位置保留完整录音";
        } else if ((cue?.speed ?? clip.speed) !== 1 || media.duration > item.end - time + 0.001) {
          item.reason = "变速或窗口不足以容纳整句录音，需复听";
        } else {
          item.referenceKind = "recording";
          item.mediaId = media.id;
          item.duration = media.duration;
          item.end = time + media.duration;
        }
        lines.push(item);
      }
    }
  }
  const sources = [...new Set(lines.flatMap(line => line.mediaId ? [line.mediaId] : []))].map(id => {
    const media = s.get("media", id);
    return { id, storageKey: media && media.projectId === sequence.projectId ? media.storageKey as string : null, hash: media?.hash as string | undefined };
  });
  lines.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  return { key: sha256(JSON.stringify([4, edit.fps, lines, sources])), fps: edit.fps, lines, sources };
}

export async function inspectSpeechAlignment(plan: NonNullable<ReturnType<typeof speechInspectionPlan>>, file: string, duration: number,
  sources: Awaited<ReturnType<typeof prepareInspectionSources>>, audioRanges: { start: number; end: number }[] | null) {
  const inspectLine = createSpeechInspector(file, duration, audioRanges);
  const lines = [];
  let retryable = audioRanges === null;
  for (const { mediaId, sourceTime, duration: length, reason, ...line } of plan.lines) {
    const source = mediaId ? sources.files.get(mediaId) : null;
    let result: SpeechAlignment = { status: "uncertain", offsetMs: null, reason: reason ?? source?.reason };
    if (source?.path && line.time !== null) {
      if (audioRanges?.length === 0) result.reason = "成片没有可解码的声音，无法定位这句录音";
      else try {
        result = await inspectLine(source.path, line.time, sourceTime, length, 1000 / plan.fps);
      } catch (error) {
        result.reason = error instanceof Error ? error.message : "台词音频解码失败";
        retryable = true;
      }
      if (result.status === "uncertain" && audioRanges?.length && line.end !== null) {
        let cursor = line.time;
        const gaps: string[] = [];
        for (const range of audioRanges) {
          if (range.end <= cursor) continue;
          if (range.start >= line.end) break;
          if (range.start - cursor >= 1 / plan.fps) gaps.push(`${cursor.toFixed(3)}–${range.start.toFixed(3)}`);
          cursor = Math.max(cursor, range.end);
        }
        if (line.end - cursor >= 1 / plan.fps) gaps.push(`${cursor.toFixed(3)}–${line.end.toFixed(3)}`);
        if (gaps.length) result.reason += `。计划区间内的 ${gaps.join("、")} 秒没有成片音频帧`;
      }
    }
    lines.push({ ...line, ...result });
  }
  // 媒体 ID 不同也可能是同一份录音。一次匹配不能代替同一帧附近计划的两次发声。
  const occurrences = new Map<string, number[]>();
  for (const [i, line] of plan.lines.entries()) {
    if (!line.mediaId || line.time === null) continue;
    const key = JSON.stringify([sources.files.get(line.mediaId)?.hash ?? line.mediaId, line.sourceTime]);
    const group = occurrences.get(key);
    if (group) group.push(i);
    else occurrences.set(key, [i]);
  }
  const positions = lines.map(line => line.time !== null && line.offsetMs !== null ? line.time + line.offsetMs / 1000 : null);
  const frame = 1 / plan.fps;
  for (const group of occurrences.values()) for (const i of group) {
    const line = lines[i], found = positions[i];
    if (group.length < 2 || found === null || line.offsetMs === null) continue;
    const shifted = Math.abs(line.offsetMs) > frame * 1000;
    const collides = group.some(j => i !== j && (Math.abs(found - plan.lines[j].time!) <= frame
      || (shifted && positions[j] !== null && Math.abs(found - positions[j]) <= frame)));
    if (collides) Object.assign(line, { status: "uncertain", offsetMs: null, missingStart: undefined, missingEnd: undefined, reason: "检测位置与同一录音的另一次排入重合，无法单独定位本句" });
  }
  return { lines, key: retryable ? null : sources.key };
}
