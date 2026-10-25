import type { Scope } from "../db.ts";
import { bad, notFound } from "../util.ts";
import { coversSpeechRanges, resolveDialogueMode } from "@toonflow/tool-media-generation/runtime";
import type { ShotInput } from "./schema.ts";

type DialogueLine = NonNullable<ShotInput["creativeBrief"]>["dialogue"]["lines"][number];

export function shotDialogueMode(s: Scope, shot: Record<string, any>) {
  if (!shot.creativeBrief?.dialogue?.lines?.length) return "none";
  // ACT: 按项目现有镜头扫描说话人，跨镜头的两人对白也先定音色；项目规模增长后可缓存到规格版本。
  const shots = [...s.list("shots", { projectId: shot.projectId }).filter(item => item.id !== shot.id), shot];
  const speakers = new Set(shots.flatMap(item => item.creativeBrief?.dialogue?.lines?.map((line: DialogueLine) => line.speakerId) ?? []));
  return speakers.size > 1 ? "post" : resolveDialogueMode(shot);
}

function speechMedia(s: Scope, projectId: string, line: DialogueLine) {
  if (!line.audio) return null;
  const media = s.get("media", line.audio.mediaId);
  if (!media || media.projectId !== projectId || media.source !== "speechReference" || !media.mime.startsWith("audio/")
    || !Number.isFinite(media.duration) || media.duration <= 0 || line.audio.text !== line.text) return null;
  return media;
}

/** 设计校验不冒充实际嘴形检查；后配对白必须先用真实声音定屏时。 */
export function speechPlanningIssues(s: Scope, shot: Record<string, any>) {
  const dialogue = shot.creativeBrief?.dialogue;
  const issues: string[] = [];
  let previousEnd = 0;
  const lines = (dialogue?.lines ?? []) as DialogueLine[];
  const mode = shotDialogueMode(s, shot);
  for (const [index, line] of lines.entries()) {
    const label = `第${index + 1}句`;
    const media = speechMedia(s, shot.projectId, line);
    if (mode === "post" && !media) issues.push(`${label}须先为每个角色绑定固定音色并采用配音，再绑定当前项目实测的 audio:{mediaId,text}；不能按字数估时或沿用改词前的声音；先 planSpeech`);
    if (media && media.duration > line.end - line.start + 0.001) issues.push(`${label}真实配音 ${media.duration.toFixed(3)} 秒超过窗口 ${(line.end - line.start).toFixed(3)} 秒；须重排镜头，不能加速、删句、截断或跨镜挪音`);
    if (line.start < previousEnd - 0.001) issues.push(`${label}与前句重叠，不能叠说来压缩未授权的对白`);
    previousEnd = line.end;
    if (line.end <= line.start || line.end > shot.duration + 0.001) issues.push(`${label}超出实际剪入镜头时长；生成余量不能冒充对白屏时`);
    if (line.lipSync === "visible") {
      const coverage = line.coverage ?? [];
      if (!coversSpeechRanges([{ start: line.start, end: line.end }], coverage)
        || coverage.some(range => range.end <= range.start || range.end > shot.duration + 0.001 || !range.description.trim())) {
        issues.push(`${label}缺少覆盖全部发声窗口的 coverage:{start,end,description}；须在相应时段看见说话者完整嘴部，不能以本镜曾出镜代替`);
      }
      if (!(shot.visibleAssetIds ?? shot.assetIds ?? []).includes(line.speakerId)) issues.push(`${label}画内说话者不在出镜资产中，不能静默改为画外音`);
    }
  }
  return issues;
}

export function assertSpeechPlan(s: Scope, shot: Record<string, any>) {
  const issues = speechPlanningIssues(s, shot);
  if (issues.length) throw Object.assign(bad(`配音规划未完成：${issues.join("；")}`), { retryable: false, fallbackAllowed: false });
}

/** ACT: 只计算声音容量和不重叠的局部窗口，不猜动作所需秒数、不自动拉长或改写已采用分镜。 */
export function planShotSpeech(s: Scope, projectId: string, shotId: string, bindings: { lineIndex: number; mediaId: string }[] = []) {
  const shot = s.get("shots", shotId);
  if (!shot || shot.projectId !== projectId) throw notFound("project shot");
  const dialogue = shot.creativeBrief?.dialogue;
  if (!dialogue?.lines.length) throw bad("镜头没有原文对白，不创建或补写台词");
  if (new Set(bindings.map(item => item.lineIndex)).size !== bindings.length
    || bindings.some(item => !Number.isInteger(item.lineIndex) || item.lineIndex < 0 || !dialogue.lines[item.lineIndex])) throw bad("配音绑定索引重复或不属于本镜原句");
  let cursor = 0;
  const lines = (dialogue.lines as DialogueLine[]).map((line, index, originals) => {
    const binding = bindings.find(item => item.lineIndex === index);
    const audio = binding ? { mediaId: binding.mediaId, text: line.text } : line.audio;
    const media = speechMedia(s, projectId, { ...line, audio });
    if (!media) throw bad(`第${index + 1}句没有有效的实测配音，不能编造时长或自动生成付费声音`);
    // 保留原定首句触发与明确的句间间隔；后句只在同镜内顺延，不碰其他镜头音轨。
    const gap = index ? Math.max(0, line.start - originals[index - 1]!.end) : line.start;
    const start = Math.max(line.start, cursor + gap);
    const end = Number((start + media.duration).toFixed(6));
    cursor = end;
    return { ...line, start, end, audio, measuredDuration: media.duration,
      coverageRequired: line.lipSync === "visible" ? { start, end, speakerId: line.speakerId, framing: line.framing } : null };
  });
  const minimumDuration = Math.max(shot.duration, cursor);
  const requiresReblocking = minimumDuration > shot.duration + 0.001;
  const proposed = { ...shot, duration: minimumDuration, creativeBrief: { ...shot.creativeBrief, dialogue: { ...dialogue, lines } } };
  return { shotId, originalDuration: shot.duration, minimumDuration, requiresReblocking,
    lines, suggestedDialogue: { ...dialogue, lines: lines.map(({ measuredDuration, coverageRequired, ...line }) => line) },
    issues: [...speechPlanningIssues(s, proposed), ...(requiresReblocking ? ["原镜时长不足；须重新设计观看与表演，minimumDuration 不能直接用于拉长旧动作或自动通过"] : [])], applied: false,
    note: "这是假设保留原触发和句间间隔的声音容量下限，不是自动延长方案。导演须复核动作、摄影节拍及可见嘴部覆盖，并用 updateShot 同次保存 creativeBrief、duration、generationDuration（如已有）和受影响字段；动作仍按实时因果推进。容量不足时重新设计分镜或新增有意义的对白表演单元，完整原句在其对应镜头内播放，不拉慢打斗救援、不循环画面、不删句或把旧音轨挪到邻镜凑时长。超过模型上限时保留待规划，不提交生成。coverageRequired是待设计要求，不能当作已有画面覆盖或口型通过。" };
}
