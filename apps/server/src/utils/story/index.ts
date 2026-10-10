import { readFile, stat, writeAtomic } from "@toonflow/file";
import { createHash, randomUUID } from "node:crypto";
import { storyActionSchema, storyDecisionSchema, storyProjectSchema, newStoryProject, storyStale, storyPreviewKey, storyBoard, validateStoryDraft, type StoryAction, type StoryProject, type StorySource } from "@toonflow/tool-scene-list/storyProject";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { currentTenant } from "@/utils/tenant";
import { cloud } from "@/lib/cloud";
import type { QuestionContext } from "@toonflow/tools-scaffold/runtime";

const fileName = "storyProject.json";
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
export async function readStoryProject(directory: string): Promise<StoryProject> {
  const { path } = await resolveWorkspacePath(directory, fileName);
  const data = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (data === null) return newStoryProject();
  const result = storyProjectSchema.safeParse(JSON.parse(data));
  if (!result.success) fail("故事项目格式无效，原文件未覆盖", 409);
  return result.data;
}
async function readSource(directory: string, relativePath: string, maxBytes: number) {
  const { path } = await resolveWorkspacePath(directory, relativePath);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes || !info.size) fail("资料为空、不是文件或超过大小限制");
  return readFile(path);
}
async function sourceFingerprint(directory: string, source: StorySource) {
  const bytes = await readSource(directory, source.path, 100 * 1024 * 1024);
  const body = source.textPath ? await readSource(directory, source.textPath, 1024 * 1024) : /^text\//.test(source.mimeType) ? bytes : undefined;
  if (body && source.observations.some(item => !item.quote || !body.toString("utf8").includes(item.quote))) fail("资料引句必须真实出现在提取正文中");
  return createHash("sha256").update(bytes).update(body ?? "").update(JSON.stringify([source.purpose, source.observations, source.coverage, source.unknowns])).digest("hex");
}
export async function checkSources(directory: string, sources: StoryProject["sources"]) {
  for (const source of sources) if (await sourceFingerprint(directory, source) !== source.fingerprint) fail(`资料「${source.name}」原件或正文已修改，请重新分析并确认`, 409);
}
async function validateApproval(directory: string, project: StoryProject, revisionId: string) {
  const revision = project.revisions.find(item => item.id === revisionId) ?? fail("故事版本不存在");
  await checkSources(directory, project.sources);
  if (storyStale(project, revision)) fail("故事依据已更新，请产生新版本并重新审阅", 409);
  const reviews = project.reviews.filter(item => item.revisionId === revision.id);
  const coverage = new Set(reviews.flatMap(item => item.coverage));
  if (revision.scenes.some(scene => !coverage.has(scene.sceneId))) fail("还有场次未审阅，请先完成审稿");
  if (reviews.some(review => review.issues.some(issue => issue.category === "contradiction" && !review.decisions[issue.id]))) fail("存在未处置的明确矛盾，请修改或记录保留理由");
  if (project.sources.some(source => source.purpose === "fact" && !source.confirmed)) fail("作为事实使用的资料尚未确认");
  return revision;
}
export async function requestStoryApproval(directory: string, toolCallId: string, revisionId: string, question: QuestionContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (currentTenant()?.role === "VIEWER") fail("只读成员不能修改故事项目", 403);
  const project = await readStoryProject(directory);
  const revision = await validateApproval(directory, project, revisionId);
  const title = `采用《${revision.title}》`;
  if (project.approvedId === revision.id) return { title, approved: true, revisionId, answer: "此版本已采用，无需再次确认" };
  const request = {
    title,
    question: `故事版本 ${project.revisions.indexOf(revision) + 1} · ${revision.scenes.length} 场\n${revision.id}\n\n${revision.outline}\n\n采用后将以此版本继续制作。`,
    options: ["采用此版本", "暂不采用"],
  };
  const response = await question.ask(toolCallId, request, signal);
  signal?.throwIfAborted();
  if (response.skipped || response.answer !== request.options[0]) return { ...request, ...response, approved: false, revisionId };
  // ACT: 确认绑定展示时的项目版本；等待期间任何修改都须重新核对，不自动套用到新版本。
  const updated = await applyStoryAction(directory, project.version, { type: "approve", id: revisionId, reason: "用户在聊天确认卡片中采用" }, true);
  return { ...request, approved: true, revisionId, version: updated.version, answer: "已采用此版本，可继续已授权的后续工作" };
}
export async function requestStoryDecision(directory: string, toolCallId: string, input: unknown, question: QuestionContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (currentTenant()?.role === "VIEWER") fail("只读成员不能修改故事项目", 403);
  const decision = storyDecisionSchema.parse(input);
  const project = await readStoryProject(directory);
  let title: string, content: string;
  let choices: { label: string; action: StoryAction }[];
  switch (decision.type) {
    case "confirmSource": {
      const source = project.sources.find(item => item.id === decision.id) ?? fail("资料不存在");
      if (!source.coverage.trim()) fail("请先说明读取覆盖范围和未知项");
      await checkSources(directory, [source]);
      title = `确认资料理解：${source.name}`;
      if (source.confirmed) return { title, applied: true, answer: "这份资料理解已确认，无需重复确认" };
      const purposes = { fact: "事实依据", style: "风格参考", reference: "结构 / 剧情参考" };
      content = `用途：${purposes[source.purpose]}\n读取范围：${source.coverage}\n\n${source.observations.map(item => `${item.statement}\n依据：${item.quote || '画面观察'}\n位置：${item.locator}`).join("\n\n")}\n\n未知项：${source.unknowns.join("；") || "无"}`;
      choices = [{ label: "确认上述理解", action: decision }];
      break;
    }
    case "chooseDirection": {
      if (!project.directions.length) fail("请先保存候选方向");
      title = "选择故事方向";
      const selected = project.directions.find(item => item.id === project.directionId);
      if (selected && !decision.reconsider) return { title, applied: true, selectedId: selected.id, answer: `已采用「${selected.title}」，无需重复选择` };
      content = project.directions.map((item, index) => `${index + 1}. ${item.title}${item.id === project.directionId ? "（当前方向）" : ""}\n${item.premise}\n观众为什么在意：${item.audienceReason}\n代表性场面：${item.signatureScene}\n制作难点：${item.risk}`).join("\n\n");
      choices = project.directions.map((item, index) => ({ label: `选择 ${index + 1}：${item.title}`, action: { type: "chooseDirection", id: item.id } }));
      break;
    }
    case "decideIssue": {
      const review = project.reviews.find(item => item.id === decision.reviewId) ?? fail("审稿记录不存在");
      const issue = review.issues.find(item => item.id === decision.issueId) ?? fail("问题不存在");
      const revision = project.revisions.find(item => item.id === review.revisionId) ?? fail("故事版本不存在");
      title = `确认保留：${revision.title} · ${issue.sceneId}`;
      if (review.decisions[issue.id]) return { title, applied: true, answer: `此问题已有保留决定：${review.decisions[issue.id]!.reason}` };
      content = `故事版本 ${project.revisions.indexOf(revision) + 1}\n原文：${issue.quote}\n问题：${issue.problem}\n依据：${issue.basis}\n建议改法：${issue.suggestion}\n\n本次提议的保留理由：${decision.reason}\n\n确认会记录保留决定，不会修改剧本正文。`;
      choices = [{ label: "按此理由保留", action: decision }];
      break;
    }
    case "release": {
      const existing = project.releases.find(item => item.id === decision.value.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(decision.value)) return { title: "发布反馈已保存", applied: true, answer: "这份反馈已保存，无需重复确认" };
      if (existing) fail("同一发布记录已有其他数据，请保留旧记录并新增观测");
      const revision = project.revisions.find(item => item.id === decision.value.revisionId) ?? fail("故事版本不存在");
      title = `确认《${revision.title}》发布反馈`;
      const value = decision.value;
      content = `平台：${value.channel}\n链接：${value.url}\n发布时间：${value.publishedAt}\n受众：${value.audience}\n分发方式：${value.distribution}\n版本：${value.variant}\n花费：${value.spend ?? "未知"} ${value.currency}\n曝光：${value.impressions ?? "未知"}\n开始观看：${value.starts ?? "未知"}\n完整观看：${value.completions ?? "未知"}\n分享：${value.shares ?? "未知"}\n关注：${value.follows ?? "未知"}\n点击：${value.clicks ?? "未知"}\n转化：${value.conversions ?? "未知"}\n观测窗口：${value.observationWindow}\n统计口径：${value.metricDefinitions}\n数据依据：${value.evidence}\n备注：${value.notes}\n\n只保存以上反馈，不会执行对外发布。`;
      choices = [{ label: "确认并保存反馈", action: decision }];
      break;
    }
  }
  const request = { title, question: content, options: [...choices.map(item => item.label), "暂不决定"] };
  const response = await question.ask(toolCallId, request, signal);
  signal?.throwIfAborted();
  const choice = response.skipped ? undefined : choices.find(item => item.label === response.answer);
  if (!choice) return { ...request, ...response, applied: false };
  const updated = await applyStoryAction(directory, project.version, choice.action, true);
  return { ...request, applied: true, version: updated.version, action: choice.action, answer: `${choice.label}，已保存` };
}
export async function applyStoryAction(directory: string, expectedVersion: number, input: unknown, human = false) {
  if (currentTenant()?.role === "VIEWER") fail("只读成员不能修改故事项目", 403);
  const tenant = currentTenant();
  if (tenant) {
    const member = cloud()?.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
    if (!member || member.role === "VIEWER") fail("故事项目编辑权限已失效", 403);
  }
  const parsed = storyActionSchema.safeParse(input);
  if (!parsed.success) fail(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；"));
  const action = parsed.data;
  if (!human && ["confirmSource", "chooseDirection", "decideIssue", "approve", "release"].includes(action.type)) {
    const tool = action.type === "approve" ? "requestStoryApproval" : "requestStoryDecision";
    fail(`请调用 ${tool}，在聊天中展示具体内容并等待用户决定`, 403);
  }
  const { path } = await resolveWorkspacePath(directory, fileName);
  const release = lockWorkspaceFiles([path]);
  try {
    const project = await readStoryProject(directory);
    if (expectedVersion !== project.version) fail("故事项目已更新，请刷新后核对再保存；当前编辑未覆盖", 409);
    const now = new Date().toISOString();
    const getRevision = (id: string) => project.revisions.find(item => item.id === id) ?? fail("故事版本不存在");
    const addDraft = async (value: Parameters<typeof validateStoryDraft>[0], parentId?: string) => {
      try { validateStoryDraft(value); }
      catch (cause) { fail(cause instanceof Error ? cause.message : "剧本结构无效"); }
      await checkSources(directory, project.sources);
      const parent = parentId ? getRevision(parentId) : undefined;
      const revision = { ...value, id: randomUUID(), createdAt: now, parentId, brief: structuredClone(project.brief), directionId: project.directionId, direction: structuredClone(project.directions.find(item => item.id === project.directionId)), sourceFingerprints: Object.fromEntries(project.sources.map(source => [source.id, source.fingerprint])) };
      project.revisions.push(revision);
      if (parent) project.boards[revision.id] = value.scenes.map(scene => {
        const previous = parent.scenes.find(item => item.sceneId === scene.sceneId);
        const board = storyBoard(project, parent.id).find(item => item.sceneId === scene.sceneId);
        // ACT: 整场未变才复用预演素材；变动场清空，旧版本的图与声音仍保留。
        return previous && board && JSON.stringify(previous) === JSON.stringify(scene) ? structuredClone(board) : { sceneId: scene.sceneId, duration: scene.duration };
      });
    };
    switch (action.type) {
      case "brief": project.brief = action.value; break;
      case "source": {
        const fingerprint = await sourceFingerprint(directory, action.value);
        const previous = project.sources.findIndex(source => source.id === action.value.id);
        const source = { ...action.value, fingerprint, confirmed: false };
        if (previous < 0) project.sources.push(source); else { source.confirmed = project.sources[previous]!.fingerprint === fingerprint && project.sources[previous]!.confirmed; project.sources[previous] = source; }
        break;
      }
      case "confirmSource": {
        const source = project.sources.find(item => item.id === action.id) ?? fail("资料不存在");
        if (!source.coverage.trim()) fail("请先说明读取覆盖范围和未知项");
        await checkSources(directory, [source]);
        if (source.confirmed) return project;
        source.confirmed = true; break;
      }
      case "directions":
        if (new Set(action.values.map(item => item.id)).size !== action.values.length) fail("创意方向 ID 重复");
        if (JSON.stringify(project.directions.find(item => item.id === project.directionId)) !== JSON.stringify(action.values.find(item => item.id === project.directionId))) project.directionId = undefined;
        project.directions = action.values; break;
      case "chooseDirection":
        if (!project.directions.some(item => item.id === action.id)) fail("创意方向不存在");
        if (project.directionId === action.id) return project;
        project.directionId = action.id; break;
      case "draft": await addDraft(action.value, action.parentId); break;
      case "rewrite": {
        const revision = getRevision(action.revisionId);
        const original = revision.scenes.find(scene => scene.sceneId === action.sceneId) ?? fail("场次不存在");
        if (original.text !== action.before || action.after.sceneId !== original.sceneId) fail("改写依据已改变或场次 ID 不匹配", 409);
        await addDraft({ title: revision.title, outline: revision.outline, scenes: revision.scenes.map(scene => scene.sceneId === action.sceneId ? action.after : scene), canon: revision.canon, threads: revision.threads }, revision.id);
        break;
      }
      case "review": {
        const revision = getRevision(action.value.revisionId);
        if (new Set(action.value.issues.map(issue => issue.id)).size !== action.value.issues.length) fail("审稿问题 ID 重复");
        if (action.value.coverage.some(id => !revision.scenes.some(scene => scene.sceneId === id))) fail("审稿范围包含不存在的场次");
        for (const issue of action.value.issues) {
          const scene = revision.scenes.find(scene => scene.sceneId === issue.sceneId);
          if (!scene || !action.value.coverage.includes(issue.sceneId) || !scene.text.includes(issue.quote)) fail("审稿引句必须精确来自本版本已审阅场次");
        }
        project.reviews.push({ ...action.value, id: randomUUID(), createdAt: now, decisions: {} }); break;
      }
      case "decideIssue": {
        const review = project.reviews.find(item => item.id === action.reviewId) ?? fail("审稿记录不存在");
        if (!review.issues.some(item => item.id === action.issueId)) fail("问题不存在");
        if (review.decisions[action.issueId]?.reason === action.reason) return project;
        review.decisions[action.issueId] = { reason: action.reason, at: now }; break;
      }
      case "approve": {
        const revision = await validateApproval(directory, project, action.id);
        if (project.approvedId === revision.id) return project;
        project.approvedId = revision.id; project.approvals.push({ revisionId: revision.id, at: now, reason: action.reason }); break;
      }
      case "board": {
        const revision = getRevision(action.revisionId);
        if (action.values.length !== revision.scenes.length || action.values.some((board, index) => board.sceneId !== revision.scenes[index]!.sceneId)) fail("预演须按当前版本覆盖全部场次");
        if (action.values.reduce((sum, item) => sum + item.duration, 0) > 600) fail("当前预演最多 10 分钟，请拆分为单集或段落");
        for (const board of action.values) for (const media of [board.image, board.audio]) if (media) await readSource(directory, media.path, 100 * 1024 * 1024);
        if (action.values.some(board => board.image && !/^image\//.test(board.image.mimeType) || board.audio && !/^audio\//.test(board.audio.mimeType))) fail("预演素材类型不正确");
        project.boards[action.revisionId] = action.values; break;
      }
      case "preview":
        getRevision(action.revisionId);
        if (action.sourceKey !== storyPreviewKey(project, action.revisionId)) fail("预演方案已改变，输出仅保留为素材，请重新渲染", 409);
        if (action.media.mimeType !== "video/mp4") fail("预演须为 MP4");
        await readSource(directory, action.media.path, 250 * 1024 * 1024);
        project.previews.push({ revisionId: action.revisionId, sourceKey: action.sourceKey, media: action.media, id: randomUUID(), createdAt: now });
        break;
      case "release": {
        getRevision(action.value.revisionId);
        if (action.value.previewId && !project.previews.some(item => item.id === action.value.previewId && item.revisionId === action.value.revisionId)) fail("发布记录与预演版本不匹配");
        if (action.value.media) await readSource(directory, action.value.media.path, 250 * 1024 * 1024);
        if (!action.value.media && !action.value.previewId && !action.value.url) fail("请关联实际发布视频、预演或发布链接");
        if (action.value.completions !== null && action.value.starts !== null && action.value.completions > action.value.starts) fail("完整观看数不能大于开始观看数，请核对统计口径");
        const existing = project.releases.find(item => item.id === action.value.id);
        if (existing && JSON.stringify(existing) === JSON.stringify(action.value)) return project;
        if (existing) fail("发布反馈已保存；补充观测请新增记录，保留旧数据");
        project.releases.push(action.value); break;
      }
      case "learning":
        if (action.value.releaseIds.some(id => !project.releases.some(item => item.id === id))) fail("复盘只能引用已保存的真实反馈");
        project.learnings.push({ ...action.value, id: randomUUID(), createdAt: now }); break;
    }
    project.version++;
    const result = storyProjectSchema.parse(project);
    await writeAtomic(path, JSON.stringify(result, null, 2), { exclusive: project.version === 1 });
    return result;
  } finally { release(); }
}
