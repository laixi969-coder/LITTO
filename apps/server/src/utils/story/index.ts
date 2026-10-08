import { readFile, stat, writeAtomic } from "@toonflow/file";
import { createHash, randomUUID } from "node:crypto";
import { storyActionSchema, storyProjectSchema, newStoryProject, storyStale, storyPreviewKey, storyBoard, validateStoryDraft, type StoryProject, type StorySource } from "@toonflow/tool-scene-list/storyProject";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { currentTenant } from "@/utils/tenant";

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
export async function applyStoryAction(directory: string, expectedVersion: number, input: unknown, human = false) {
  if (currentTenant()?.role === "VIEWER") fail("只读成员不能修改故事项目", 403);
  const parsed = storyActionSchema.safeParse(input);
  if (!parsed.success) fail(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；"));
  const action = parsed.data;
  if (!human && ["confirmSource", "chooseDirection", "decideIssue", "approve", "release"].includes(action.type)) fail("此操作需要用户在故事工作台中决定", 403);
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
        source.confirmed = true; break;
      }
      case "directions":
        if (new Set(action.values.map(item => item.id)).size !== action.values.length) fail("创意方向 ID 重复");
        project.directions = action.values; project.directionId = undefined; break;
      case "chooseDirection":
        if (!project.directions.some(item => item.id === action.id)) fail("创意方向不存在");
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
        review.decisions[action.issueId] = { reason: action.reason, at: now }; break;
      }
      case "approve": {
        const revision = getRevision(action.id);
        await checkSources(directory, project.sources);
        if (storyStale(project, revision)) fail("故事依据已更新，请产生新版本并重新审阅", 409);
        const reviews = project.reviews.filter(item => item.revisionId === revision.id);
        const coverage = new Set(reviews.flatMap(item => item.coverage));
        if (revision.scenes.some(scene => !coverage.has(scene.sceneId))) fail("还有场次未审阅，请先完成审稿");
        if (reviews.some(review => review.issues.some(issue => issue.category === "contradiction" && !review.decisions[issue.id]))) fail("存在未处置的明确矛盾，请修改或记录保留理由");
        if (project.sources.some(source => source.purpose === "fact" && !source.confirmed)) fail("作为事实使用的资料尚未确认");
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
        if (project.releases.some(item => item.id === action.value.id)) fail("发布反馈已保存；补充观测请新增记录，保留旧数据");
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
