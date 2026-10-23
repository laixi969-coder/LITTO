import type { Scope } from "../db.ts";
import { bad, conflict } from "../util.ts";
import type { Body } from "./nle.ts";

export function musicSource(s: Scope, shot: Record<string, any>, required = false) {
  const plan = shot.musicVideo;
  if (plan?.audioMode !== "sourceTrack") return null;
  if (!plan.sourceMediaId) {
    if (required) throw bad("原曲方案缺少 sourceMediaId，请先导入真实歌曲，不能只用歌曲名称或时间码代替音频");
    return null;
  }
  const media = s.get("media", plan.sourceMediaId);
  const accessible = media?.projectId === shot.projectId || s.list("refs", { projectId: shot.projectId }).some(ref => ref.mediaId === media?.id);
  if (!media || !accessible || !media.mime?.startsWith("audio/") || !Number.isFinite(media.duration) || media.duration <= 0) throw bad("原曲须为本项目已导入且有实测时长的音频");
  if (!Number.isFinite(plan.sourceStart) || plan.sourceStart < 0 || plan.sourceStart + (shot.generationDuration ?? shot.duration) > media.duration + 0.001) throw bad("原曲时间段超出实际音频，不能重复或拉伸歌曲填满画面");
  return media;
}

export function validateMusicEdit(s: Scope, edit: Body) {
  const active = edit.clips.filter(clip => !edit.tracks.find(track => track.id === clip.trackId)?.muted);
  const audible = (clip: Body["clips"][number]) => !clip.audioDetached && clip.gainDb + (edit.tracks.find(track => track.id === clip.trackId)?.gainDb ?? 0) > -60;
  for (const clip of active.filter(clip => edit.tracks.find(track => track.id === clip.trackId)?.kind === "video")) {
    const shot = clip.shotId ? s.get("shots", clip.shotId) : null;
    if (shot?.musicVideo?.audioMode !== "sourceTrack") continue;
    const media = musicSource(s, shot, true)!;
    if (clip.speed !== 1) throw conflict("原曲 MV 画面须保持原速；重新编排歌曲与表演后再定稿", "music_alignment_required");
    if (audible(clip)) throw conflict("原曲 MV 须关闭视频候选的生成歌曲/人声，使用独立原曲轨，避免双重演唱；环境声另用音效轨", "music_alignment_required");
    const parts = active.filter(audio => audio.id !== clip.id && audible(audio) && audio.start < clip.start + clip.duration - 0.001 && audio.start + audio.duration > clip.start + 0.001
      && (audio.mediaId === media.id || edit.tracks.find(track => track.id === audio.trackId)?.role === "music")).sort((a, b) => a.start - b.start);
    let covered = clip.start;
    for (const audio of parts) {
      const start = Math.max(audio.start, clip.start), end = Math.min(audio.start + audio.duration, clip.start + clip.duration);
      const expected = shot.musicVideo.sourceStart + clip.in + start - clip.start;
      const actual = audio.in + (start - audio.start) * audio.speed;
      if (audio.mediaId !== media.id || audio.speed !== 1 || Math.abs(actual - expected) > 0.02 || Math.abs(start - covered) > 0.02) throw conflict("原曲存在错位、重复叠音或空隙；按 sourceStart 与当前剪辑入点重新排轨", "music_alignment_required");
      covered = end;
    }
    if (Math.abs(covered - clip.start - clip.duration) > 0.02) throw conflict("原曲没有完整覆盖当前画面，请排入实际歌曲后再定稿", "music_alignment_required");
  }
}
