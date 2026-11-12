import { z } from "zod";
import { musicSceneFields } from "./schema";
import { visualBoardSchema } from "./visualReference";
import { storyLogicSchema, storyLogicGuide } from "./storyLogic";

const text = (max = 2000) => z.string().trim().max(max);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const storyPath = z.string().min(1).max(1024).refine(value => !/^[\\/]/.test(value) && !/[\\:\x00-\x1f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== ".."), "须为工作区内的相对文件路径");
export const storyBriefSchema = z.strictObject({
  kind: z.enum(["story", "serial", "adfilm", "brandFilm", "shortDramaCommerce", "musicFilm"]),
  serialFormat: z.enum(["short", "medium"]).optional().describe("连载形态：短剧或中剧；duration 为单集目标秒数"),
  episodeCount: z.number().int().min(1).max(100).optional(),
  cast: z.array(z.strictObject({ assetId: id, libraryId: id, actorName: text(120).min(1), roleName: text(120).min(1) })).max(20).optional().describe("用户从角色库选用并已导入本项目的演员与饰演人物；沿用 assetId 的身份和定妆，不重复建角或重生成"),
  productImages: z.array(z.strictObject({ name: text(260).min(1), path: storyPath, mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]) })).max(20).optional().describe("商业广告或短剧带货的已上传商品图片；path 为当前工作区相对路径，用于外观、包装与结构参考"),
  productPreparation: z.enum(["original", "cutout", "threeViews"]).optional().describe("商品准备方式：保留原图、抠图保留原视角，或三视图参考板；实际生成沿用当前模型与授权，不把AI补全的角度当成真实结构"),
  idea: text(10000), audience: text(), channel: text(200), intent: text(), genre: text(200), tone: text(500), ending: text(500), duration: z.number().finite().min(1).max(3600), constraints: text(4000),
});
export const storySourceSchema = z.strictObject({
  id, name: text(260).min(1), path: storyPath, textPath: storyPath.optional(), mimeType: text(150).min(1),
  purpose: z.enum(["fact", "style", "reference"]),
  observations: z.array(z.strictObject({ statement: text().min(1), quote: text(2000), locator: text(300).min(1) })).max(50),
  coverage: text(2000), unknowns: z.array(text(500)).max(50),
});
export const storyDirectionSchema = z.strictObject({ id, title: text(100).min(1), premise: text().min(1), audienceReason: text().min(1), signatureScene: text().min(1), risk: text().min(1) });
export const storyFrameworkSchema = z.strictObject({
  title: text(150).min(1),
  format: text(300).min(1).describe("沿用用户指定的电影、短片或剧集形式及篇幅，不自行更改"),
  content: text(20000).min(1).describe("可读的故事框架：一句话故事、人物及锁定事实、主要段落或三幕、信息揭示与伏笔、结尾；不是完整正文"),
});
export const storyExpansionSchema = z.enum(["sample", "episodes", "draft"]);
export const storyExpansionLabels = { sample: "先写代表场次", episodes: "展开分集大纲", draft: "展开完整正文" };
export const storySceneSchema = z.strictObject({
  sceneId: z.string().regex(/^s\d{2,3}$/), title: text(150).min(1), text: text(12000).min(1),
  episodeNumber: z.number().int().min(1).max(100).optional().describe("连载场次所属集号；跨集仍保留唯一 sceneId"),
  goal: text(1000), obstacle: text(1000), change: text(1000), knowledge: text(2000),
  causes: z.array(z.string().regex(/^s\d{2,3}$/)).max(30),
  speech: text(6000).describe("仅实际朗读文字，逐句换行；不含角色名前缀、冒号标签、通道标记或表演说明。角色与通道保留在 text 中，无朗读则留空"),
  duration: z.number().finite().min(1).max(180),
  ...musicSceneFields,
});
const canonSchema = z.strictObject({ id, entity: text(150).min(1), statement: text(1500).min(1), sceneId: z.string().regex(/^s\d{2,3}$/) });
const threadSchema = z.strictObject({ id, question: text(1500).min(1), setupSceneId: z.string().regex(/^s\d{2,3}$/), payoffSceneId: z.string().regex(/^s\d{2,3}$/).optional(), status: z.enum(["open", "paid", "abandoned"]), reason: text(1000) });
export const storyDraftSchema = z.strictObject({ title: text(150).min(1), outline: text(12000), scenes: z.array(storySceneSchema).min(1).max(100), canon: z.array(canonSchema).max(300), threads: z.array(threadSchema).max(100) });
export const storyIssueSchema = z.strictObject({
  id, sceneId: z.string().regex(/^s\d{2,3}$/), category: z.enum(["contradiction", "comprehension", "taste"]),
  quote: text(2000).min(1), problem: text(2000).min(1), basis: text(2000).min(1), suggestion: text(2000).min(1),
});
const storyEvidenceSchema = z.strictObject({
  sceneId: z.string().regex(/^s\d{2,3}$/), quote: text(2000).min(1),
  verdict: z.enum(["pass", "revise", "unverified"]), basis: text(2000).min(10),
});
export const storyReviewSchema = z.strictObject({
  revisionId: id, summary: text(3000).min(1), coverage: z.array(z.string().regex(/^s\d{2,3}$/)).min(1).max(100), issues: z.array(storyIssueSchema).max(100),
  logic: storyLogicSchema.optional().describe("数量与关键规则的逐项核对。引句取全部场次正文按顺序用两个换行连接的文本；规则故事必须提供，不能用因果总评代替对象与边界验证"),
  quality: z.strictObject({
    causality: storyEvidenceSchema.describe("核对实际因果；异常故事核对触发、范围、限制及全部关键使用，不需要幻想规则时检查现实行动条件"),
    payoff: storyEvidenceSchema.describe("核对开头主要期待与结尾实际行动的对应；开放结尾也须说明已经完成的主体事件，不能只换到新谜团"),
  }).optional().describe("可选的因果与结尾审读。引用正文原句与场次并给出依据；局部审稿可不填"),
});
const media = z.strictObject({ path: storyPath, mimeType: text(150).min(1) });
export const storyBoardSchema = z.strictObject({ sceneId: z.string().regex(/^s\d{2,3}$/), duration: z.number().finite().min(1).max(180), image: media.optional(), audio: media.optional() });
export const storyReleaseSchema = z.strictObject({
  id, revisionId: id, previewId: id.optional(), media: media.optional(), channel: text(200).min(1), url: z.union([z.literal(""), z.url().refine(value => /^https?:\/\//.test(value))]),
  publishedAt: text(100).min(1), audience: text(1000).min(1), distribution: z.enum(["organic", "paid", "mixed"]),
  variant: text(200).min(1), spend: z.number().finite().nonnegative().nullable(), currency: text(30),
  impressions: z.number().int().nonnegative().nullable(), starts: z.number().int().nonnegative().nullable(), completions: z.number().int().nonnegative().nullable(),
  shares: z.number().int().nonnegative().nullable(), follows: z.number().int().nonnegative().nullable(), clicks: z.number().int().nonnegative().nullable(), conversions: z.number().int().nonnegative().nullable(),
  observationWindow: text(300).min(1), metricDefinitions: text(2000).min(1), evidence: text(3000).min(1), notes: text(4000),
});

const source = storySourceSchema.extend({ fingerprint: text(100).min(1), confirmed: z.boolean() });
const revision = storyDraftSchema.extend({ id, createdAt: z.string(), parentId: id.optional(), brief: storyBriefSchema, directionId: id.optional(), direction: storyDirectionSchema.optional(), sourceFingerprints: z.record(z.string(), z.string()) });
const review = storyReviewSchema.extend({ id, createdAt: z.string(), decisions: z.record(z.string(), z.strictObject({ reason: text(2000).min(1), at: z.string() })) });
const learningSchema = z.strictObject({ releaseIds: z.array(id).min(1).max(50), observation: text(3000).min(1), limitations: text(2000).min(1), hypothesis: text(2000).min(1), nextExperiment: text(2000).min(1) });
export const storyProjectSchema = z.strictObject({
  littoStory: z.literal(1), version: z.number().int().nonnegative(), brief: storyBriefSchema,
  visualBoard: visualBoardSchema.default([]),
  sources: z.array(source).max(100), directions: z.array(storyDirectionSchema).max(3), directionId: id.optional(),
  frameworks: z.array(storyFrameworkSchema.extend({ id, createdAt: z.string(), basis: z.string() })).max(100).default([]),
  frameworkApproval: z.strictObject({ id, step: storyExpansionSchema }).optional(),
  expansions: z.array(z.strictObject({ frameworkId: id, step: z.enum(["sample", "episodes"]), text: text(30000).min(1), createdAt: z.string() })).max(100).default([]),
  revisions: z.array(revision).max(200), approvedId: id.optional(), reviews: z.array(review).max(300),
  boards: z.record(z.string(), z.array(storyBoardSchema).max(100)),
  previews: z.array(z.strictObject({ id, revisionId: id, sourceKey: text(100000).min(1), media, createdAt: z.string() })).max(200),
  releases: z.array(storyReleaseSchema).max(500),
  learnings: z.array(learningSchema.extend({ id, createdAt: z.string() })).max(200).default([]),
  approvals: z.array(z.strictObject({ revisionId: id, at: z.string(), reason: text(2000) })).max(300),
});
export type StoryProject = z.infer<typeof storyProjectSchema>;
export type StoryDraft = z.infer<typeof storyDraftSchema>;
export type StorySource = z.infer<typeof storySourceSchema>;
export type StoryRevision = StoryProject["revisions"][number];

export const storyTextEditsSchema = z.array(z.strictObject({ before: z.string().min(1).max(12000), after: z.string().max(12000) })).min(1).max(40);
export const storyActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("visualBoard"), values: visualBoardSchema }),
  z.strictObject({ type: z.literal("brief"), value: storyBriefSchema }),
  z.strictObject({ type: z.literal("source"), value: storySourceSchema }),
  z.strictObject({ type: z.literal("confirmSource"), id }),
  z.strictObject({ type: z.literal("directions"), values: z.array(storyDirectionSchema).min(2).max(3) }),
  z.strictObject({ type: z.literal("chooseDirection"), id }),
  z.strictObject({ type: z.literal("framework"), value: storyFrameworkSchema }),
  z.strictObject({ type: z.literal("confirmFramework"), id, step: storyExpansionSchema }),
  z.strictObject({ type: z.literal("expansion"), frameworkId: id, step: z.enum(["sample", "episodes"]), text: text(30000).min(1) }),
  z.strictObject({ type: z.literal("draft"), value: storyDraftSchema, parentId: id.optional().describe("仅传已有故事版本的 id，不是方向 id；第一版省略。保存后从返回的 revisions 中读取新版本 id") }),
  z.strictObject({ type: z.literal("review"), value: storyReviewSchema }),
  z.strictObject({ type: z.literal("decideIssue"), reviewId: id, issueId: id, reason: text(2000).min(1) }),
  z.strictObject({ type: z.literal("approve"), id, reason: text(2000) }),
  z.strictObject({ type: z.literal("rewrite"), revisionId: id, sceneId: z.string(), before: text(12000).min(1), after: storySceneSchema }),
  z.strictObject({ type: z.literal("patch"), revisionId: id, sceneId: z.string(), before: z.string().min(1).max(12000),
    edits: storyTextEditsSchema,
    speechEdits: z.array(z.strictObject({ before: z.string().min(1).max(6000), after: z.string().max(6000) })).min(1).max(40).optional(),
  }).describe("只改指定词句：before为当前整场原文，edits逐项给唯一原句和替换文字；程序保留其他正文与字段。对白改后另核对speech，不用整场rewrite绕过锁稿"),
  z.strictObject({ type: z.literal("board"), revisionId: id, values: z.array(storyBoardSchema).min(1).max(100) }),
  z.strictObject({ type: z.literal("preview"), revisionId: id, sourceKey: text(100000).min(1), media }),
  z.strictObject({ type: z.literal("release"), value: storyReleaseSchema }),
  z.strictObject({ type: z.literal("learning"), value: learningSchema }),
]);
export type StoryAction = z.infer<typeof storyActionSchema>;
export function applyStoryTextEdits(text: string, edits: { before: string; after: string }[]) {
  for (const edit of edits) {
    const index = text.indexOf(edit.before);
    if (!edit.before || index < 0 || text.indexOf(edit.before, index + 1) >= 0) throw new Error("替换原句不存在或不唯一，请扩大引句范围以定位，未修改原稿");
    text = text.slice(0, index) + edit.after + text.slice(index + edit.before.length);
  }
  return text;
}
export const storyDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("confirmFramework"), id }).describe("展示指定框架，让用户确认并选择下一步；不得自动确认"),
  z.strictObject({ type: z.literal("confirmSource"), id }),
  z.strictObject({ type: z.literal("chooseDirection"), reconsider: z.boolean().optional() }).describe("展示已保存的全部方向供选择，不要传 id；已有选择直接复用"),
  z.strictObject({ type: z.literal("decideIssue"), reviewId: id, issueId: id, reason: text(2000).min(1) }),
  z.strictObject({ type: z.literal("release"), value: storyReleaseSchema }),
]);
export function storyActionParameters(type: StoryAction["type"]) {
  return z.toJSONSchema(storyActionSchema.options.find(option => option.shape.type.value === type)!, { io: "input", target: "draft-07" });
}
export function newStoryProject(): StoryProject {
  return { littoStory: 1, version: 0, visualBoard: [], brief: { kind: "story", idea: "", audience: "", channel: "", intent: "", genre: "", tone: "", ending: "", duration: 60, constraints: "" }, frameworks: [], expansions: [], sources: [], directions: [], revisions: [], reviews: [], boards: {}, previews: [], releases: [], learnings: [], approvals: [] };
}
export function storyFrameworkBasis(project: StoryProject) {
  return JSON.stringify([project.brief, project.directions.find(item => item.id === project.directionId), project.sources.map(item => [item.id, item.fingerprint, item.confirmed])]);
}
export function storyFrameworkReady(project: StoryProject) {
  const framework = project.frameworks.at(-1);
  return !!framework && framework.id === project.frameworkApproval?.id && framework.basis === storyFrameworkBasis(project);
}
export function storyBoard(project: StoryProject, revisionId: string) {
  const revision = project.revisions.find(item => item.id === revisionId);
  return project.boards[revisionId] ?? revision?.scenes.map(scene => ({ sceneId: scene.sceneId, duration: scene.duration })) ?? [];
}
export function storyPreviewKey(project: StoryProject, revisionId: string) { return JSON.stringify([revisionId, storyBoard(project, revisionId)]); }
export function storyStale(project: StoryProject, revision: StoryRevision) {
  return JSON.stringify(revision.brief) !== JSON.stringify(project.brief) || revision.directionId !== project.directionId
    || JSON.stringify(revision.direction) !== JSON.stringify(project.directions.find(item => item.id === project.directionId))
    || Object.keys(revision.sourceFingerprints).length !== project.sources.length
    || project.sources.some(source => revision.sourceFingerprints[source.id] !== source.fingerprint);
}
export function storyImpact(previous: StoryRevision, next: StoryRevision) {
  const changed = new Set([...previous.scenes, ...next.scenes].filter(scene => JSON.stringify(previous.scenes.find(item => item.sceneId === scene.sceneId)) !== JSON.stringify(next.scenes.find(item => item.sceneId === scene.sceneId))).map(scene => scene.sceneId));
  // ACT: 事实/线索尚无完整的逐场使用映射，变化时保守重做全版预演；未来可按实体依赖缩小范围。
  if (JSON.stringify([previous.canon, previous.threads]) !== JSON.stringify([next.canon, next.threads])) {
    for (const scene of [...previous.scenes, ...next.scenes]) changed.add(scene.sceneId);
  }
  const dependent = new Set<string>();
  next.scenes.forEach((scene, index) => { if (previous.scenes[index]?.sceneId !== scene.sceneId) changed.add(scene.sceneId); });
  let more = true;
  while (more) { more = false; for (const scene of next.scenes) if (!changed.has(scene.sceneId) && !dependent.has(scene.sceneId) && scene.causes.some(id => changed.has(id) || dependent.has(id))) { dependent.add(scene.sceneId); more = true; } }
  return { changed: [...changed], dependent: [...dependent] };
}
export function validateStoryDraft(draft: StoryDraft, brief?: StoryProject["brief"]) {
  const episodic = draft.scenes.some(scene => scene.episodeNumber !== undefined) || brief?.kind === "serial" && !!brief.serialFormat;
  if (episodic) {
    let previous = 0;
    for (const scene of draft.scenes) {
      const episode = scene.episodeNumber;
      if (!episode || episode < previous || brief?.episodeCount && episode > brief.episodeCount) throw new Error("分集场次须填写有效集号，按集排列且不超过计划集数；倒叙在本集正文注明");
      previous = episode;
    }
  }
  const ids = new Set(draft.scenes.map(scene => scene.sceneId));
  if (ids.size !== draft.scenes.length) throw new Error("场次 ID 不能重复");
  for (const scene of draft.scenes) if (scene.causes.some(id => !ids.has(id) || id === scene.sceneId)) throw new Error(`${scene.sceneId} 的因果引用无效`);
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error(`场次 ${id} 存在循环因果，请核对事件依据`);
    if (visited.has(id)) return;
    visiting.add(id);
    draft.scenes.find(scene => scene.sceneId === id)!.causes.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  ids.forEach(visit);
  for (const fact of draft.canon) if (!ids.has(fact.sceneId)) throw new Error(`事实 ${fact.id} 缺少对应场次`);
  for (const thread of draft.threads) {
    if (!ids.has(thread.setupSceneId) || thread.payoffSceneId && !ids.has(thread.payoffSceneId)) throw new Error(`线索 ${thread.id} 引用了不存在的场次`);
    if (thread.status === "paid" && !thread.payoffSceneId || thread.status === "abandoned" && !thread.reason) throw new Error("已兑现线索须有落点，放弃线索须有理由");
    if (thread.status !== "paid" && thread.payoffSceneId) throw new Error("未兑现或放弃的线索不能同时登记已兑现场次");
  }
  for (const items of [draft.canon, draft.threads]) if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("事实与线索各自的 ID 不能重复");
}

export const shortDramaWritingGuide = `连载数据与交接：仅对 brief.kind=serial 使用 serialFormat=short|medium、episodeCount、单集 duration 和逐场 episodeNumber。sceneId 跨集唯一，单个版本最多100场，超出时说明本次保存范围。已有集数、单集时长和修改范围沿用用户要求。跨集状态、事实与伏笔用 canon/threads 延续。
制作按集创建带 kind、episodeNumber、storyRevisionId 的 sequence，复用项目资产和音色；接戏用 continuityFromShotId 明确引用本项目更早镜头，服装、伤势、持物写 intendedStateDelta。真实参考须实际发送，成片仍需看片。创作与审稿统一使用当前 story 技能。`;

export const musicFilmWritingGuide = `MV 数据与执行：仅对 brief.kind=musicFilm 使用，创作与审稿统一遵守当前 story 技能。纯演唱和抽象段落按音乐、表演和意象组织，叙事段逐场检查；用户已选方向与定稿优先。
保留原曲歌词顺序及重复次数，演唱切入接原曲当前位置；无可靠时间码不虚构精确卡点。musicRange/syncMode/lyricLines 保存段落、同步方式及原歌词。speech 只存额外朗读的对白或旁白，不重复录入原曲。
固定歌手与剧情角色分别记录，兼任时沿用同一身份；画外演唱不代表歌手在场。遵守已定声音通道，无额外对白时不靠不可听对白或读唇解码交代因果。
writeStoryDraft 可沿用已有 MV 场面计划、全曲预算分配、动作容量校验与执行修订；这些是执行要求，不能替代技能的创作自检。durationSeconds 是创作预算，不是实测时长；executionNotes 保留未核实的排练和音轨校准项。complete/authorRevisionComplete/executionReviewComplete 不证明实拍或观众效果。
逐场 text 保留行动、触发与反应，knowledge 区分人物和观众所知，causes 不机械引用紧邻的独立演唱场。采用后的 storyContext 和正文落实到 action/performance/musicVideo.timeline，核对编译预览与实际接戏。`;

export const storyWritingGuide = `MILI MILI 工作台保存协议：创作和审稿标准使用本次按作品类型加载的创作方法，以下仅说明结构与持久化。
资料、参考作品和模型生成的候选不能冒充已确认事实；没有读取的内容保持未知。沿用当前 brief、已选方向和采用版本，不为补流程重写。
draft 保存 title、outline、scenes、canon、threads。sceneId 稳定；text 是完整正文，goal/obstacle/change/knowledge/causes 对应正文依据。speech 只存实际朗读原句，不含角色名、通道或表演说明。canon/threads 的事实、伏笔和来源场次可追溯。
审稿只针对指定 revisionId，coverage 记录真实审阅场次，问题含精确原句、依据、类别和最小改法。quality 与 logic 按实际需要填写，不能编造依据。审稿结论供用户或获授权代理采用时参考，未核实不冒充通过。
整场改写用 rewrite，指定词句用 patch 并按需同步 speechEdits；保存新版本、保留其余内容与旧稿。采用与决定沿用原有权限和确认流程，已确认内容不重复询问。
${storyLogicGuide}
调用提供的结构化保存工具，校验失败按错误修正；普通文字回复不等于已保存。`;
