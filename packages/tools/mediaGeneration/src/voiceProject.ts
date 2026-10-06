import { z } from "zod";

const pathSchema = z.string().min(1).max(2048).refine(path => !/^[\\/]|[:\u0000-\u001f]/.test(path) && path.split(/[\\/]/).every(part => part && part !== "." && part !== ".."), "素材路径必须位于工作区内");
const audioSchema = z.strictObject({ path: pathSchema, mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i) });
const videoSchema = z.strictObject({ path: pathSchema, mimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i) });
const roleSchema = z.strictObject({
  id: z.string().uuid(), name: z.string().max(100), providerId: z.string().max(96), modelId: z.string().max(256), voice: z.string().max(256),
});
const takeSchema = z.strictObject({
  id: z.string().uuid(), audio: audioSchema, sourceKey: z.string().max(30000),
  videos: z.array(z.strictObject({ id: z.string().uuid(), video: videoSchema, sourceVideo: videoSchema, providerId: z.string().max(96), modelId: z.string().max(256) })).max(100),
});
const lineSchema = z.strictObject({
  id: z.string().uuid(), roleId: z.string().uuid().or(z.literal("")), kind: z.enum(["dialogue", "narration"]), text: z.string().max(10000),
  emotion: z.string().max(100), delivery: z.string().max(1800), speed: z.number().min(0.25).max(4), pauseAfter: z.number().min(0).max(10),
  video: videoSchema.optional(), takes: z.array(takeSchema).max(100), takeId: z.string().uuid().or(z.literal("")),
});

export const voiceProjectSchema = z.strictObject({
  littoVoice: z.literal(1), roles: z.array(roleSchema).max(50), lines: z.array(lineSchema).max(500),
  lipSyncProviderId: z.string().max(96), lipSyncModelId: z.string().max(256),
  mixes: z.array(z.strictObject({ id: z.string().uuid(), audio: audioSchema, sourceKey: z.string().max(100000) })).max(100),
}).superRefine((project, context) => {
  const ids = [...project.roles, ...project.lines, ...project.lines.flatMap(line => line.takes), ...project.lines.flatMap(line => line.takes.flatMap(take => take.videos)), ...project.mixes].map(item => item.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "配音项目包含重复 ID" });
  for (const line of project.lines) {
    if (line.roleId && !project.roles.some(role => role.id === line.roleId)) context.addIssue({ code: "custom", message: "台词引用的角色不存在" });
    if (line.takeId && !line.takes.some(take => take.id === line.takeId)) context.addIssue({ code: "custom", message: "选定配音版本不存在" });
  }
});

export type VoiceProject = z.infer<typeof voiceProjectSchema>;
export type VoiceRole = VoiceProject["roles"][number];
export type VoiceLine = VoiceProject["lines"][number];

export function speechSourceKey(line: VoiceLine, role?: VoiceRole) {
  return JSON.stringify([line.text.trim(), line.emotion.trim(), line.delivery.trim(), line.speed, role?.providerId, role?.modelId, role?.voice]);
}
