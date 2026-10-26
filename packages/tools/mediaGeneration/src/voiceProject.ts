import { z } from "zod";

const pathSchema = z.string().min(1).max(2048).refine(path => !/^[\\/]|[:\u0000-\u001f]/.test(path) && path.split(/[\\/]/).every(part => part && part !== "." && part !== ".."), "素材路径必须位于工作区内");
const audioSchema = z.strictObject({ path: pathSchema, mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i) });
const videoSchema = z.strictObject({ path: pathSchema, mimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i) });
export const speechPlanSchema = z.strictObject({ shotId: z.string().min(1).max(128), bindings: z.array(z.strictObject({ lineIndex: z.number().int().nonnegative(), path: pathSchema })).max(40).optional() })
  .refine(value => !value.bindings || new Set(value.bindings.map(item => item.lineIndex)).size === value.bindings.length, "同一句不能重复绑定配音");
export const speechSegmentSchema = audioSchema.extend({ start: z.number().finite().nonnegative(), duration: z.number().finite().positive().max(600) });
export const speechSyncPathsSchema = z.strictObject({ audioPath: pathSchema, videoPath: pathSchema, sourceVideoPath: pathSchema.optional() });
export const speechTakeInputSchema = speechSyncPathsSchema.extend({
  assemblyId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  shotId: z.string().min(1).max(128), sourceVideoPath: pathSchema, inspectionKey: z.string().length(64),
  fullPlayback: z.literal(true), speech: z.literal("pass"), lipSync: z.literal("pass"), note: z.string().trim().min(10).max(2000),
});
export const syncShotSpeechSchema = z.strictObject({ shotId: z.string().min(1).max(128) });
export const speechInspectionSchema = z.strictObject({
  key: z.string().length(64), audioMatches: z.boolean(), offsetMs: z.number().finite(), correlation: z.number().finite(),
  audioDuration: z.number().finite().positive(), videoDuration: z.number().finite().positive(), sourceVideoDuration: z.number().finite().positive().optional(), note: z.string(),
});
export type SpeechInspection = z.infer<typeof speechInspectionSchema>;

export function speechInspectionMessage(inspection: SpeechInspection) {
  const issues: string[] = [];
  if (inspection.correlation < 0.9) issues.push("参考音轨相似度不足，无法可靠判断偏移；不能靠平移声音直接修复");
  else if (Math.abs(inspection.offsetMs) > 80) issues.push(`相似音轨整体偏移 ${inspection.offsetMs} 毫秒`);
  if (Math.abs(inspection.audioDuration - inspection.videoDuration) > 0.15) issues.push(`时长不符：参考声音 ${inspection.audioDuration.toFixed(3)} 秒，视频 ${inspection.videoDuration.toFixed(3)} 秒`);
  if (inspection.sourceVideoDuration !== undefined && Math.abs(inspection.sourceVideoDuration - inspection.videoDuration) > 0.15) issues.push(`口型结果改变了原片时长：原片 ${inspection.sourceVideoDuration.toFixed(3)} 秒，结果 ${inspection.videoDuration.toFixed(3)} 秒；不能以短句替换整镜`);
  if (!inspection.audioMatches && !issues.length) issues.push("已有检查未通过，请核对当前素材与检查记录");
  return (issues.join("；") || `参考音轨整体匹配，估算偏移 ${inspection.offsetMs} 毫秒`) + "。音轨匹配不证明逐字口型同步；仍需检查可见发声区间。";
}
const roleSchema = z.strictObject({
  assetId: z.string().trim().min(1).max(128).optional(),
  speechStyle: z.string().max(2000).optional(),
  id: z.string().uuid(), name: z.string().max(100), providerId: z.string().max(96), modelId: z.string().max(256), voice: z.string().max(256),
});
const takeSchema = z.strictObject({
  id: z.string().uuid(), audio: audioSchema, sourceKey: z.string().max(30000),
  syncRequests: z.array(z.strictObject({ requestId: z.string().uuid(), sourceVideo: videoSchema, providerId: z.string().max(96), modelId: z.string().max(256) })).max(100).default([]),
  videos: z.array(z.strictObject({ id: z.string().uuid(), video: videoSchema, sourceVideo: videoSchema, providerId: z.string().max(96), modelId: z.string().max(256),
    inspection: speechInspectionSchema.optional(),
    review: z.strictObject({ inspectionKey: z.string().length(64), fullPlayback: z.boolean(), speech: z.enum(["pass", "fail", "uncertain"]), lipSync: z.enum(["pass", "fail", "uncertain"]), note: z.string().trim().min(10).max(2000) }).optional(),
  })).max(100),
});
const lineSchema = z.strictObject({
  storySource: z.strictObject({ revisionId: z.string().uuid(), sceneId: z.string().regex(/^s\d{2,3}$/), sceneText: z.string().max(12000), speech: z.string().max(6000) }).optional(),
  id: z.string().uuid(), roleId: z.string().uuid().or(z.literal("")), kind: z.enum(["dialogue", "narration", "singing"]), text: z.string().max(10000),
  sourceAudio: speechSegmentSchema.optional(),
  shotId: z.string().max(128).optional(),
  dialogueLineIndex: z.number().int().min(0).max(39).optional(),
  emotion: z.string().max(100), delivery: z.string().max(1800), speed: z.number().min(0.25).max(4), pauseAfter: z.number().min(0).max(10),
  video: videoSchema.optional(), takes: z.array(takeSchema).max(100), takeId: z.string().uuid().or(z.literal("")),
});

export const voiceProjectSchema = z.strictObject({
  littoVoice: z.literal(1), roles: z.array(roleSchema).max(50), lines: z.array(lineSchema).max(500),
  lipSyncProviderId: z.string().max(96), lipSyncModelId: z.string().max(256),
  mixes: z.array(z.strictObject({ id: z.string().uuid(), audio: audioSchema, sourceKey: z.string().max(100000) })).max(100),
}).superRefine((project, context) => {
  const assets = project.roles.flatMap(role => role.assetId ? [role.assetId] : []);
  const names = project.roles.map(role => role.name.trim()).filter(Boolean);
  if (new Set(assets).size !== assets.length || new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "同一角色只能绑定一份音色档案，角色名称和资产不能重复" });
  const ids = [...project.roles, ...project.lines, ...project.lines.flatMap(line => line.takes), ...project.lines.flatMap(line => line.takes.flatMap(take => take.videos)), ...project.mixes].map(item => item.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "配音项目包含重复 ID" });
  for (const line of project.lines) {
    if (line.roleId && !project.roles.some(role => role.id === line.roleId)) context.addIssue({ code: "custom", message: "台词引用的角色不存在" });
    if (line.takeId && !line.takes.some(take => take.id === line.takeId)) context.addIssue({ code: "custom", message: "选定配音版本不存在" });
    for (const take of line.takes) for (const video of take.videos) {
      if (video.review && !video.review.fullPlayback && (video.review.speech === "pass" || video.review.lipSync === "pass")) context.addIssue({ code: "custom", message: "通过结论必须完整看听；局部检查只能记录不通过或不确定" });
      if (video.review && (!video.inspection || video.review.inspectionKey !== video.inspection.key || video.review.speech === "pass" && !video.inspection.audioMatches)) context.addIssue({ code: "custom", message: "音画检查须对应当前素材；声音未匹配不能记录为通过" });
    }
  }
});

export type VoiceProject = z.infer<typeof voiceProjectSchema>;
export type VoiceRole = VoiceProject["roles"][number];
export type VoiceLine = VoiceProject["lines"][number];

export function speechInstructions(line: VoiceLine, role?: VoiceRole) {
  return [role?.speechStyle?.trim(), line.emotion.trim(), line.delivery.trim()].filter(Boolean).join("；");
}

export function speechSourceKey(line: VoiceLine, role?: VoiceRole) {
  if (line.sourceAudio) return JSON.stringify([line.text.trim(), line.sourceAudio]);
  return JSON.stringify([line.text.trim(), line.emotion.trim(), line.delivery.trim(), line.speed, role?.providerId, role?.modelId, role?.voice, ...(role?.speechStyle?.trim() ? [role.speechStyle.trim()] : [])]);
}
