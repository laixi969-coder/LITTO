import { z } from "zod";

// 实体 id 由模型自取，如 c1、loc1、p1；场次 id 形如 s01。拆解只引用 id，不按名称匹配。
const entityId = z.string().regex(/^[a-z][a-z0-9]{0,31}$/, "实体 id 只能用小写字母开头的字母和数字，如 c1、loc2");
const sceneId = z.string().regex(/^s\d{2,3}$/, "场次 id 形如 s01");
const text = (max: number) => z.string().trim().max(max);
const entity = z.object({ id: entityId, name: text(60).min(1), description: text(400).default("") });

export const musicSceneFields = {
  musicRange: text(80).optional().describe("仅 MV：歌曲段落名或有依据的时间范围；无时间码时写段落与大致占比"),
  syncMode: z.enum(["free", "beat", "phrase", "lyric", "energy"]).optional(),
  lyricLines: z.array(text(200)).max(40).optional().describe("仅 MV：本场对应的原歌词，不为迁就剧情改词"),
};

export const sceneListSchema = z.object({
  storyRevisionId: text(80).optional().describe("故事工作台已采用的版本 ID；有故事项目时必填"),
  title: text(80).min(1),
  kind: z.enum(["story", "musicFilm"]).default("story"),
  volume: z.enum(["micro", "short", "medium", "long"]).describe("micro≈1 分钟；short≈3–5 分钟；medium=单集；long=长篇"),
  characters: z.array(entity).max(40),
  locations: z.array(entity).min(1).max(40),
  props: z.array(entity).max(80).default([]),
  wardrobe: z.array(entity.extend({ characterId: entityId.optional() })).max(80).default([]),
  // 场次字段用 strictObject：模型写成 characters 之类的近义字段时直接指出，而不是被静默丢弃后误报"实体未出场"。
  scenes: z.array(z.strictObject({
    sceneId,
    // 序号与数组位置重复，模型常从 0 开始编；保存时按位置重新编号，填不填都行。
    order: z.unknown().optional().transform(() => 0),
    locationId: entityId,
    timeOfDay: text(40).min(1),
    characterIds: z.array(entityId).default([]),
    propIds: z.array(entityId).default([]),
    wardrobeIds: z.array(entityId).default([]),
    emotionBeat: text(200).min(1),
    narrativeFunction: text(300).min(1).describe("这场让观众获得什么：建立、揭示、反应、对比、过渡"),
    durationHint: text(80).min(1),
    risk: text(400).default("").describe("模型难以稳定生成的内容及原因，没有则留空"),
    ...musicSceneFields,
  })).min(1).max(200),
  overLimitReason: text(400).optional().describe("人物或场景数超出体量上限时，说明必须保留的叙事理由"),
});
export type SceneList = z.infer<typeof sceneListSchema>;

// 与 story 技能「面向拍摄的约束」一致；中篇及以上不设硬上限。
const volumeLimits: Partial<Record<SceneList["volume"], { characters: number; locations: number }>> = {
  micro: { characters: 3, locations: 2 },
  short: { characters: 5, locations: 4 },
};

// 只对本工具的校验使用中文提示；zod 由宿主共享，不改全局语言。
const zhCN = z.locales.zhCN().localeError;

// 模型调用工具时常把数组或对象整体写成一段 JSON 字符串；顶层字段先尝试解析，解析不了再交给校验报错。
function unwrapJsonStrings(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return [key, value];
    try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
  }));
}

function zodIssues(error: z.ZodError) {
  return error.issues.map(issue => `${issue.path.join(".") || "参数"}：${issue.message}`);
}

export function validateSceneList(input: unknown): { value?: SceneList; issues: string[] } {
  const parsed = sceneListSchema.safeParse(unwrapJsonStrings(input), { error: zhCN });
  if (!parsed.success) return { issues: zodIssues(parsed.error) };
  const value = parsed.data;
  const issues: string[] = [];
  const kinds = new Map<string, string>();
  for (const [kind, list] of [["人物", value.characters], ["场景", value.locations], ["道具", value.props], ["服装", value.wardrobe]] as const) {
    for (const item of list) {
      if (kinds.has(item.id)) issues.push(`实体 id ${item.id} 重复（已用于${kinds.get(item.id)}）`);
      kinds.set(item.id, kind);
    }
  }
  const ids = (list: { id: string }[]) => new Set(list.map(item => item.id));
  const characterIds = ids(value.characters), locationIds = ids(value.locations), propIds = ids(value.props), wardrobeIds = ids(value.wardrobe);
  for (const item of value.wardrobe) if (item.characterId && !characterIds.has(item.characterId)) issues.push(`服装 ${item.id} 的 characterId ${item.characterId} 不在人物列表里`);
  const seenScenes = new Set<string>();
  const used = new Set<string>();
  value.scenes.forEach((scene, index) => {
    if (seenScenes.has(scene.sceneId)) issues.push(`场次 id ${scene.sceneId} 重复`);
    seenScenes.add(scene.sceneId);
    scene.order = index + 1;
    const check = (list: string[], pool: Set<string>, label: string) => {
      for (const id of list) {
        if (!pool.has(id)) issues.push(`场次 ${scene.sceneId} 引用了不存在的${label} ${id}`);
        used.add(id);
      }
    };
    check([scene.locationId], locationIds, "场景");
    check(scene.characterIds, characterIds, "人物");
    check(scene.propIds, propIds, "道具");
    check(scene.wardrobeIds, wardrobeIds, "服装");
  });
  for (const [id, kind] of kinds) if (!used.has(id)) issues.push(`${kind} ${id} 没有出现在任何场次里，删掉它或补进对应场次`);
  const limit = volumeLimits[value.volume];
  if (limit && !value.overLimitReason && (characterIds.size > limit.characters || locationIds.size > limit.locations)) {
    issues.push(`体量 ${value.volume} 最多 ${limit.characters} 个人物、${limit.locations} 个场景，现在是 ${characterIds.size} 个人物、${locationIds.size} 个场景；请合并人物或场景，确需保留时在 overLimitReason 写明理由`);
  }
  return issues.length ? { issues } : { value, issues };
}

// 世界与影调是给人看的草案，模型常把关键词写成数组；合并成一句话，不当作错误。
const noteValue = z.union([text(400), z.array(text(100)).max(20).transform(items => items.join("、"))]);

const assetTypes = { characters: ["Character"], locations: ["Environment"], wardrobe: ["Wardrobe"], props: ["Prop", "Product", "Vehicle", "Creature"] } as const;

export const breakdownSchema = z.object({
  sceneListVersion: z.number().int().min(1).describe("readSceneList 返回的 version；场次表改动后须重新拆解"),
  assets: z.array(z.object({
    entityId,
    type: z.enum(["Character", "Wardrobe", "Environment", "Prop", "Product", "Vehicle", "Creature"]),
    name: text(60).min(1),
    invariants: z.array(text(200).min(1)).min(1).max(20).describe("跨场次必须保持不变的特征"),
    allowedVariations: z.array(text(200)).max(20).default([]),
    stateChanges: z.array(z.object({ sceneId, change: text(300).min(1) })).max(40).default([]).describe("剧情导致的变化，如受伤、换装、破损"),
    notes: text(400).default(""),
  })).min(1),
  skipped: z.array(z.object({ entityId, reason: text(300).min(1) })).default([]).describe("场次表里不单列为资产的实体及理由"),
  world: z.record(z.string(), noteValue).default({}),
  look: z.record(z.string(), noteValue).default({}),
  gaps: z.array(text(300)).max(40).default([]).describe("剧本没写但制作必须决定的事项"),
});

export function validateBreakdown(input: unknown, sceneList: SceneList & { version: number }) {
  const parsed = breakdownSchema.safeParse(unwrapJsonStrings(input), { error: zhCN });
  if (!parsed.success) return { issues: zodIssues(parsed.error) };
  const value = parsed.data;
  const issues: string[] = [];
  if (value.sceneListVersion !== sceneList.version) issues.push(`场次表已更新到版本 ${sceneList.version}，请先 readSceneList 再按最新版本拆解`);
  const category = new Map<string, keyof typeof assetTypes>();
  for (const key of Object.keys(assetTypes) as (keyof typeof assetTypes)[]) for (const item of sceneList[key]) category.set(item.id, key);
  const covered = new Set<string>();
  for (const asset of value.assets) {
    const key = category.get(asset.entityId);
    if (!key) { issues.push(`资产 ${asset.name} 引用的实体 id ${asset.entityId} 不在场次表里`); continue; }
    if (!(assetTypes[key] as readonly string[]).includes(asset.type)) issues.push(`资产 ${asset.entityId} 的类型应为 ${assetTypes[key].join(" 或 ")}，而不是 ${asset.type}`);
    if (covered.has(asset.entityId)) issues.push(`实体 ${asset.entityId} 被拆成了多项资产；同一实体的不同状态写进 stateChanges`);
    covered.add(asset.entityId);
  }
  for (const item of value.skipped) {
    if (!category.has(item.entityId)) issues.push(`skipped 里的 ${item.entityId} 不在场次表里`);
    if (covered.has(item.entityId)) issues.push(`${item.entityId} 同时出现在 assets 和 skipped 里`);
    covered.add(item.entityId);
  }
  // 模型常自造 id；把场次表里真实的 id 列出来，让它照着改，而不是反复猜。
  if (issues.some(issue => issue.includes("不在场次表里"))) {
    const names = { characters: "人物", locations: "场景", wardrobe: "服装", props: "道具" } as const;
    issues.push(`只能引用场次表里已有的实体 id：${[...category].map(([id, key]) => `${id} ${sceneList[key].find(item => item.id === id)!.name}（${names[key]}）`).join("、")}`);
  }
  const missing = [...category.keys()].filter(id => !covered.has(id));
  if (missing.length) issues.push(`场次表里这些实体既没拆成资产也没写不单列的理由：${missing.join("、")}`);
  const sceneIds = new Set(sceneList.scenes.map(scene => scene.sceneId));
  for (const asset of value.assets) for (const change of asset.stateChanges) {
    if (!sceneIds.has(change.sceneId)) issues.push(`资产 ${asset.entityId} 的状态变化引用了不存在的场次 ${change.sceneId}`);
  }
  if (issues.length) return { issues };
  // 出场场次由场次表推导，不让模型重复填写，避免两边不一致。
  const appearances = (id: string) => sceneList.scenes.filter(scene => scene.locationId === id
    || scene.characterIds.includes(id) || scene.propIds.includes(id) || scene.wardrobeIds.includes(id)).map(scene => scene.sceneId);
  return { value: { ...value, assets: value.assets.map(asset => ({ ...asset, sceneIds: appearances(asset.entityId) })) }, issues };
}
