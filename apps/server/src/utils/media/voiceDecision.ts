import { readFile, stat, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { QuestionContext, QuestionRequest } from "@toonflow/tools-scaffold/runtime";
import { voiceProjectSchema, speechPlanSchema, speechSourceKey, speechInstructions, type VoiceProject } from "@toonflow/tool-media-generation/voiceProject";
import { createHash } from "node:crypto";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { currentTenant } from "@/utils/tenant";
import { cloud } from "@/lib/cloud";
import { readStoryProject } from "@/utils/story";
import { storyStale } from "@toonflow/tool-scene-list/storyProject";
import type { GeneratedMedia, MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { getMediaProvider } from "@/utils/media/provider";
import { readReference } from "@/utils/media/generation";
import { workspaceProject } from "@/utils/media/jobs";
import { modelAccess } from "@/utils/modelAvailability";

const voiceWriteQueue = new Map<string, Promise<void>>();

export async function readVoiceProject(directory: string) {
  const { path } = await resolveWorkspacePath(directory, "voiceProject.json");
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return { path, content, project: content === null ? { littoVoice: 1, roles: [], lines: [], lipSyncProviderId: "", lipSyncModelId: "", mixes: [] } as VoiceProject : voiceProjectSchema.parse(JSON.parse(content)) };
}

function currentVoiceLine(project: VoiceProject, shot: Record<string, any>, lineIndex: number, speakerName: string, required = false) {
  const planned = shot.creativeBrief.dialogue.lines[lineIndex];
  const roles = project.roles.filter(role => role.assetId ? role.assetId === planned.speakerId : role.name.trim() === speakerName.trim());
  if (roles.length > 1) throw new Error("说话人对应多个音色档案，请用角色 assetId 明确绑定，不能猜测声音");
  const role = roles[0];
  if (required && (!role || !role.providerId.trim() || !role.modelId.trim() || !role.voice.trim())) throw new Error(`第${lineIndex + 1}句须先为角色「${speakerName}」保存固定供应商、配音模型和音色，不回退到原生随机声音`);
  const linked = project.lines.filter(line => line.shotId === shot.id && (line.dialogueLineIndex === undefined || line.dialogueLineIndex === lineIndex));
  const matches = linked.filter(line => (planned.lipSync === "offscreen" || line.kind !== "narration") && line.text.trim() === planned.text && line.roleId === role?.id);
  if (!matches.length && linked.some(line => line.text.trim() === planned.text || line.dialogueLineIndex === lineIndex)) throw new Error(`第${lineIndex + 1}句的配音原文或角色与镜头不一致，请核对对应台词，不回退到旧声音`);
  if (matches.length > 1) throw new Error(`第${lineIndex + 1}句对应多个配音记录，请设置 voiceProject.lines 的 dialogueLineIndex（从0开始），不重新生成或猜测版本`);
  const line = matches[0];
  if (line && line.dialogueLineIndex === undefined && shot.creativeBrief.dialogue.lines.filter((item: { text: string; speakerId: string }) => item.text === planned.text && item.speakerId === planned.speakerId).length > 1) throw new Error("同镜同角色重复原句须指定 dialogueLineIndex，不能猜测对应的配音版本");
  if (!line) {
    if (required || role) throw new Error(`第${lineIndex + 1}句尚未关联角色的配音记录，请先绑定 shotId、dialogueLineIndex 并采用声音`);
    return null;
  }
  const take = line.takes.find(take => take.id === line.takeId);
  if (!take || take.sourceKey !== speechSourceKey(line, project.roles.find(role => role.id === line.roleId))) throw new Error(`第${lineIndex + 1}句尚无当前有效的已选配音；保留旧声音，不自动重新生成`);
  return take.audio;
}

/** 角色配音独立于音乐默认模型；只能发送已保存的原句、音色及表演。 */
export async function assertVoiceSpeechRequest(directory: string, request: MediaGenerationRequest) {
  const { project } = await readVoiceProject(directory);
  const line = project.lines.find(line => line.id === request.voiceLineId);
  const role = project.roles.find(role => role.id === line?.roleId);
  if (!line || !role || !role.name.trim() || !role.voice.trim() || line.kind === "singing" || line.sourceAudio) throw new Error("固定配音须使用已保存角色及其对白或旁白原句，已有录音不重新生成");
  if (request.providerId !== role.providerId || request.modelId !== role.modelId || request.voice !== role.voice
    || request.prompt.trim() !== line.text.trim() || (request.speed ?? 1) !== line.speed
    || (request.instructions?.trim() ?? "") !== speechInstructions(line, role) || request.audios?.length || Object.keys(request.audioParameters ?? {}).length) throw new Error("配音请求与角色固定音色、原文或表演不一致，请先保存当前方案；不能被默认值或额外参数覆盖");
  modelAccess("media", role.providerId, role.modelId).assert();
  const provider = await getMediaProvider(role.providerId);
  const model = provider.models.find(model => model.type === "audio" && model.id === role.modelId);
  if (!model || model.audioTask && model.audioTask !== "speech") throw new Error("角色音色必须绑定可用的语音模型，不能使用音乐或音效模型");
  if (Array.isArray(model.voices) && model.voices.length && !model.voices.some(voice => voice && typeof voice === "object" && "voice" in voice && voice.voice === role.voice)) throw new Error("角色绑定的固定音色不属于当前模型，不能静默使用默认音色");
  if (line.storySource) {
    const story = await readStoryProject(directory);
    const approved = story.revisions.find(item => item.id === story.approvedId);
    const scene = approved?.scenes.find(item => item.sceneId === line.storySource!.sceneId);
    if (!approved || storyStale(story, approved) || scene?.text !== line.storySource.sceneText || scene.speech !== line.storySource.speech) throw new Error("剧本已变化，请先同步当前台词，不生成旧句配音");
  }
  const sourceKey = speechSourceKey(line, role);
  if (line.takes.length >= 100 && !line.takes.some(take => take.sourceKey === sourceKey)) throw new Error("此句配音候选已达上限，保留现有版本，不再提交付费生成");
  return sourceKey;
}

export async function saveVoiceSpeechTake(directory: string, lineId: string, sourceKey: string, files: GeneratedMedia[]) {
  const { path } = await readVoiceProject(directory);
  // 沿用画布登记的按文件串行写法；不同角色并行完成时，逐次读取最新快照，避免丢掉另一人的候选。
  const task = (voiceWriteQueue.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const release = lockWorkspaceFiles([path]);
    try {
      const saved = await readVoiceProject(directory);
      const line = saved.project.lines.find(line => line.id === lineId);
      if (!line) throw new Error("原配音台词已移除，已生成声音保留在磁盘，不重新生成");
      for (const file of files) {
        if (file.mediaType !== "audio") throw new Error("配音结果不是音频，不能记录为角色配音");
        if (line.takes.some(take => take.audio.path === file.path)) continue;
        line.takes.push({ id: crypto.randomUUID(), audio: { path: file.path, mimeType: file.mimeType }, sourceKey, syncRequests: [], videos: [] });
      }
      const next = voiceProjectSchema.parse(saved.project);
      await writeAtomic(path, JSON.stringify(next, null, 2));
    } finally { release(); }
  });
  voiceWriteQueue.set(path, task);
  try { await task; }
  finally { if (voiceWriteQueue.get(path) === task) voiceWriteQueue.delete(path); }
}

/** 复用已选声音或明确的旧素材映射；只导入实测声音并计算方案，不改镜头或音轨。 */
export async function planWorkspaceSpeech(directory: string, data: unknown, signal?: AbortSignal) {
  const input = speechPlanSchema.parse(data);
  const tenant = currentTenant(), api = cloud();
  if (!tenant || !api || tenant.role === "VIEWER") throw Object.assign(new Error("无权规划当前项目配音"), { status: 403 });
  const projectId = workspaceProject(directory, false);
  if (!projectId) throw Object.assign(new Error("工作目录尚未关联镜头项目，不能创建空项目代替配音规划"), { status: 404 });
  const scope = api.scoped(tenant.workspaceId), shot = scope.get("shots", input.shotId);
  if (!shot || shot.projectId !== projectId) throw Object.assign(new Error("镜头不属于当前项目"), { status: 404 });
  const lines = shot.creativeBrief?.dialogue?.lines ?? [];
  if (input.bindings?.some(binding => !lines[binding.lineIndex])) throw Object.assign(new Error("配音绑定索引不属于本镜原句"), { status: 400 });
  const saved = await readVoiceProject(directory);
  const snapshot = JSON.stringify(shot);
  const bindings = [];
  for (const [lineIndex, line] of lines.entries()) {
    signal?.throwIfAborted();
    const explicit = input.bindings?.find(binding => binding.lineIndex === lineIndex);
    const audio = explicit ? { path: explicit.path, mimeType: "audio/wav" }
      : currentVoiceLine(saved.project, shot, lineIndex, scope.get("assets", line.speakerId)?.name ?? "", api.shotDialogueMode(scope, shot) === "post");
    if (explicit && api.shotDialogueMode(scope, shot) === "post") {
      const selected = currentVoiceLine(saved.project, shot, lineIndex, scope.get("assets", line.speakerId)?.name ?? "", true);
      if (selected?.path !== explicit.path) throw new Error("多人固定音色只使用该角色当前已采用配音，不能用任意文件替代或串用另一人的声音");
    }
    if (!audio) continue; // 已保存且仍有效的领域声音绑定由 planShotSpeech 复用。
    const reference = await readReference(directory, audio, "audio", signal);
    const media = await api.importWorkspaceAudio(scope, projectId, Buffer.from(reference.data, "base64"));
    bindings.push({ lineIndex, mediaId: media.id });
  }
  signal?.throwIfAborted();
  if (JSON.stringify(scope.get("shots", shot.id)) !== snapshot || (await readVoiceProject(directory)).content !== saved.content) throw new Error("测量期间镜头或配音选择已改变，未应用旧规划，请重新核对");
  return api.workspaceProduction(scope, projectId, "planSpeech", { shotId: shot.id, bindings }, tenant.userId);
}

/** 已选择的声音被替换或改词后，不能继续用旧领域绑定提交付费画面。 */
export async function assertCurrentSpeechAudio(directory: string, shot: Record<string, any>, signal?: AbortSignal) {
  if (!shot.creativeBrief?.dialogue?.lines?.length) return;
  const tenant = currentTenant(), api = cloud();
  if (!tenant || !api) throw new Error("缺少配音规划的工作区身份");
  const scope = api.scoped(tenant.workspaceId);
  const saved = await readVoiceProject(directory);
  for (const [index, line] of shot.creativeBrief.dialogue.lines.entries()) {
    const audio = currentVoiceLine(saved.project, shot, index, scope.get("assets", line.speakerId)?.name ?? "", api.shotDialogueMode(scope, shot) === "post");
    if (!audio) continue;
    const reference = await readReference(directory, audio, "audio", signal);
    const hash = createHash("sha256").update(Buffer.from(reference.data, "base64")).digest("hex");
    const bound = line.audio && scope.get("media", line.audio.mediaId);
    if (!bound || bound.projectId !== shot.projectId || bound.hash !== hash || line.audio.text !== line.text) throw new Error(`第${index + 1}句的已选声音与镜头规划不一致，请重新 planSpeech；不沿用旧时长提交生成`);
  }
  if ((await readVoiceProject(directory)).content !== saved.content) throw new Error("检查期间配音选择已改变，停止提交生成");
}

export async function isVoiceSyncRequest(directory: string, request: MediaGenerationRequest) {
  const provider = await getMediaProvider(request.providerId);
  if (!provider.models.some(model => model.id === request.modelId && model.type === "video" && model.lipSync === true)) return false;
  if (request.speechSegment) {
    await (await import("@/utils/media/speechAssembly")).validateSpeechSegmentRequest(directory, request);
    return true;
  }
  if (request.shotId || request.productionFingerprint || request.videos?.length !== 1 || request.audios?.length !== 1)
    throw new Error("专用口型处理不切换默认视频模型：请使用已保存配音方案中的一对人物 videos 和已选 audios，不传 shotId 或 productionFingerprint");
  const { project } = await readVoiceProject(directory);
  if (project.lipSyncProviderId !== request.providerId || project.lipSyncModelId !== request.modelId)
    throw new Error("请先通过 configureVoice 保存 lipSyncProviderId 和 lipSyncModelId；口型模型独立于默认视频模型，无需改选默认视频模型");
  const line = project.lines.find(line => {
    const take = line.takes.find(take => take.id === line.takeId);
    return line.kind !== "narration" && line.video?.path === request.videos![0]!.path && take?.audio.path === request.audios![0]!.path
      && take.sourceKey === speechSourceKey(line, project.roles.find(role => role.id === line.roleId));
  });
  if (!line) throw new Error("口型请求未匹配当前已采用的原句、声音与人物视频，请先在配音方案中绑定对应台词，不改选默认视频模型");
  if (line.storySource) {
    const story = await readStoryProject(directory);
    const approved = story.revisions.find(item => item.id === story.approvedId);
    const scene = approved?.scenes.find(item => item.sceneId === line.storySource!.sceneId);
    if (!approved || storyStale(story, approved) || scene?.text !== line.storySource.sceneText || scene.speech !== line.storySource.speech) throw new Error("台词来源已变化，请先同步当前采用剧本的配音方案，保留已有素材");
  }
  return true;
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
    request.question = next.roles.map(role => `角色：${role.name}\n音色：${role.voice}\n说话习惯：${role.speechStyle || "未指定"}\n配音模型：${role.providerId} / ${role.modelId}`).join("\n\n") + `\n\n口型模型：${next.lipSyncProviderId || "未设置"} / ${next.lipSyncModelId || "未设置"}\n\n` + next.lines.map(line => `${next.roles.find(role => role.id === line.roleId)?.name || "待分配角色"} · ${line.kind === "dialogue" ? "对白" : line.kind === "singing" ? "演唱" : "旁白"}\n${line.text}\n${line.emotion} ${line.delivery} · 语速 ${line.speed} · 句后停顿 ${line.pauseAfter} 秒`).join("\n\n");
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
