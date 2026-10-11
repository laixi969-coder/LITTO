import { z } from "zod";
import { creativeBriefSchema, type ShotInput } from "./schema.ts";

const stylingSchema = z.object({
  makeup: z.string().trim().min(1), hair: z.string().trim().min(1),
  costume: z.string().trim().min(1), accessories: z.string().trim().min(1),
});

// ACT: 这里只校验设计是否可执行，不用关键词、分数或服饰繁简冒充审美判断。
export function creativeDirectionIssues(shot: ShotInput, assets: { id: string; name: string; type: string; attributes?: Record<string, unknown> }[]) {
  const characters = assets.filter(asset => asset.type === "Character");
  if (!shot.creativeBrief && !characters.length && !assets.some(asset => asset.type === "Product") && !shot.advertising) return [];
  const parsed = creativeBriefSchema.safeParse(shot.creativeBrief);
  if (!parsed.success) return ["请由导演补充 creativeBrief：创作目标、可见视觉设计、产品展示或攻防编排（如适用）和对白计划；不要让用户填写技术表单"];
  const issues: string[] = [];
  for (const asset of characters) {
    if (!stylingSchema.safeParse(asset.attributes?.styling).success) issues.push(`${asset.name} 缺少 attributes.styling 的 makeup、hair、costume、accessories 设计；可明确自然妆或无配饰及其理由，不默认素衣或华服`);
  }
  const brief = parsed.data;
  if (brief.kind === "combat" && !brief.combat) issues.push("武打镜头须先设计 combat 的局面转折、标志性动作、攻防因果与摄影覆盖，不能只填写强度或激烈形容词");
  const duration = shot.generationDuration ?? shot.duration;
  const characterIds = new Set(characters.map(asset => asset.id));
  const assetIds = new Set(assets.map(asset => asset.id));
  for (const beat of brief.combat?.beats ?? []) {
    if (!assetIds.has(beat.attackerId) || !assetIds.has(beat.defenderId) || beat.attackerId === beat.defenderId) issues.push("攻防双方须为本镜实际出场的不同资产");
  }
  for (const line of brief.dialogue.lines) {
    if (!characterIds.has(line.speakerId)) issues.push("对白说话人须为本镜的真实角色资产");
    if (line.end <= line.start || line.end > duration) issues.push("对白起止时间须在本段生成时长内，并为发声及口型留出时间");
  }
  if (brief.dialogue.lines.length && brief.dialogue.mode === "native" && shot.musicVideo && shot.musicVideo.audioMode !== "generated") issues.push("原生对白与静音/原曲方案冲突；保留台词，修改声音方案或明确后期配音对口型路径");
  return [...new Set(issues)];
}

export const creativeReviewSchema = z.object({
  verdict: z.enum(["pass", "revise"]),
  styling: z.string().trim().min(10).max(2000),
  staging: z.string().trim().min(10).max(2000),
}).strict();
