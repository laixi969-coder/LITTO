import { readFile, stat, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { QuestionContext, QuestionRequest } from "@toonflow/tools-scaffold/runtime";
import { voiceProjectSchema, speechSourceKey, type VoiceProject } from "@toonflow/tool-media-generation/voiceProject";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { currentTenant } from "@/utils/tenant";
import { cloud } from "@/lib/cloud";
import { readStoryProject } from "@/utils/story";
import { storyStale } from "@toonflow/tool-scene-list/storyProject";

export async function readVoiceProject(directory: string) {
  const { path } = await resolveWorkspacePath(directory, "voiceProject.json");
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return { path, content, project: content === null ? { littoVoice: 1, roles: [], lines: [], lipSyncProviderId: "", lipSyncModelId: "", mixes: [] } as VoiceProject : voiceProjectSchema.parse(JSON.parse(content)) };
}

export async function requestVoiceDecision(directory: string, toolCallId: string, input: { operation: string; data: Record<string, unknown>; reconsider?: boolean }, question: QuestionContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const tenant = currentTenant();
  if (tenant?.role === "VIEWER") throw new Error("只读成员不能修改配音方案");
  const saved = await readVoiceProject(directory);
  let next = structuredClone(saved.project);
  const request: QuestionRequest = { title: "确认配音选择", question: "", options: ["确认保存", "暂不决定"], media: [] };
  const mediaFiles: { path: string; size: number; mtimeMs: number }[] = [];
  const preview = async (media: { path: string; mimeType: string }, title: string) => {
    const { path } = await resolveWorkspacePath(directory, media.path);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("配音素材不存在");
    mediaFiles.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    request.media!.push({ id: media.path, title, url: `/api/workspaces/files/read?${new URLSearchParams({ directory, path: media.path })}`, kind: media.mimeType.startsWith("video/") ? "video" : "audio" });
  };
  let choices: string[] = [];
  let lineId: string | undefined;
  let storySnapshot: string | undefined;
  if (input.operation === "selectVoice") {
    const data = z.strictObject({ lineId: z.string().uuid(), takeIds: z.array(z.string().uuid()).min(1).max(60) }).parse(input.data);
    const line = next.lines.find(item => item.id === data.lineId);
    if (!line) throw new Error("台词不存在");
    if (new Set(data.takeIds).size !== data.takeIds.length) throw new Error("配音候选不能重复");
    if (line.storySource) {
      const story = await readStoryProject(directory);
      const approved = story.revisions.find(item => item.id === story.approvedId);
      const scene = approved?.scenes.find(item => item.sceneId === line.storySource!.sceneId);
      if (!approved || storyStale(story, approved) || scene?.text !== line.storySource.sceneText || scene.speech !== line.storySource.speech) throw new Error("台词来源已变化，请先在聊天中同步已采用剧本");
      storySnapshot = JSON.stringify(story);
    }
    const takes = data.takeIds.map(id => line.takes.find(take => take.id === id));
    if (takes.some(take => !take || take.sourceKey !== speechSourceKey(line, next.roles.find(role => role.id === line.roleId)))) throw new Error("配音候选不存在或台词/音色已变化");
    if (!input.reconsider && data.takeIds.includes(line.takeId)) return { title: "配音版本已选定", applied: true, selectedId: line.takeId, answer: "当前配音版本已选定，无需重复选择" };
    lineId = line.id; choices = data.takeIds;
    request.title = "试听并采用配音";
    request.question = `台词：${line.text}\n表演：${line.emotion} ${line.delivery}\n请选择试听后采用的版本。`;
    for (const [index, take] of takes.entries()) await preview(take!.audio, `配音候选 ${index + 1}`);
    request.options = choices.map((_id, index) => `采用配音 ${index + 1}`).concat("暂不决定");
  } else {
    next = voiceProjectSchema.parse(input.data.project);
    if (!input.reconsider && JSON.stringify(next) === JSON.stringify(saved.project)) return { title: "配音方案已保存", applied: true, answer: "当前方案已保存，无需重复确认" };
    // 配置更新不能抹掉旧生成版本；改变台词/角色时保留原候选供追溯。
    for (const line of saved.project.lines) {
      const updated = next.lines.find(item => item.id === line.id);
      if (!updated || line.takes.some(take => !updated.takes.some(item => JSON.stringify(item) === JSON.stringify(take)))) throw new Error("配音方案须保留已有台词与生成版本；另建台词或候选保存修改");
    }
    if (saved.project.mixes.some(mix => !next.mixes.some(item => JSON.stringify(item) === JSON.stringify(mix)))) throw new Error("配音方案须保留已有混音版本");
    request.question = next.roles.map(role => `角色：${role.name}\n音色：${role.voice}\n配音模型：${role.providerId} / ${role.modelId}`).join("\n\n") + `\n\n口型模型：${next.lipSyncProviderId || "未设置"} / ${next.lipSyncModelId || "未设置"}\n\n` + next.lines.map(line => `${next.roles.find(role => role.id === line.roleId)?.name || "待分配角色"} · ${line.kind === "dialogue" ? "对白" : "旁白"}\n${line.text}\n${line.emotion} ${line.delivery} · 语速 ${line.speed} · 句后停顿 ${line.pauseAfter} 秒`).join("\n\n");
    for (const line of next.lines) {
      if (line.video) await preview(line.video, `人物视频：${line.text.slice(0, 40)}`);
      for (const take of line.takes) { await preview(take.audio, line.takeId === take.id ? `采用配音：${line.text.slice(0, 40)}` : `保留配音：${line.text.slice(0, 40)}`); for (const video of take.videos) await preview(video.video, "口型视频"); }
    }
    for (const mix of next.mixes) await preview(mix.audio, "整段配音");
  }
  const response = await question.ask(toolCallId, request, signal);
  signal?.throwIfAborted();
  const choice = request.options!.slice(0, -1).indexOf(response.answer);
  if (response.skipped || choice < 0) return { ...request, ...response, applied: false };
  if (tenant) {
    const member = cloud()?.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
    if (!member || member.role === "VIEWER") throw new Error("配音方案编辑权限已失效");
  }
  if (lineId) next.lines.find(line => line.id === lineId)!.takeId = choices[choice]!;
  const release = lockWorkspaceFiles([saved.path]);
  try {
    if ((await readVoiceProject(directory)).content !== saved.content) throw new Error("配音方案已改变，本次未覆盖，请重新核对");
    if (storySnapshot && JSON.stringify(await readStoryProject(directory)) !== storySnapshot) throw new Error("故事已改变，请重新核对配音来源");
    for (const item of mediaFiles) { const info = await stat(item.path); if (info.size !== item.size || info.mtimeMs !== item.mtimeMs) throw new Error("预览素材已改变，请重新确认"); }
    await writeAtomic(saved.path, JSON.stringify(next, null, 2), { exclusive: saved.content === null });
  } finally { release(); }
  return { ...request, applied: true, selectedId: lineId ? next.lines.find(line => line.id === lineId)!.takeId : undefined, answer: "配音选择已保存" };
}
