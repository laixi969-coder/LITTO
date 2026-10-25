import { resolveDialogueMode } from "@toonflow/tool-media-generation/runtime";
import { z } from "zod";
import { creativeBriefSchema, type ShotInput } from "./schema.ts";
import { techniqueIssues } from "@toonflow/tool-media-generation/filmTechniques";

const stylingSchema = z.object({
  makeup: z.string().trim().min(1), hair: z.string().trim().min(1),
  costume: z.string().trim().min(1), accessories: z.string().trim().min(1),
});

// ACT: 这里只校验设计是否可执行，不用关键词、分数或服饰繁简冒充审美判断。
export function creativeDirectionIssues(shot: ShotInput, assets: { id: string; name: string; type: string; attributes?: Record<string, unknown> }[]) {
  const visibleIds = new Set(shot.visibleAssetIds ?? shot.assetIds);
  const characters = assets.filter(asset => asset.type === "Character" && visibleIds.has(asset.id));
  if (!shot.creativeBrief && !characters.length && !assets.some(asset => asset.type === "Product") && !shot.advertising) return techniqueIssues(shot);
  const parsed = creativeBriefSchema.safeParse(shot.creativeBrief);
  if (!parsed.success) return ["请由导演补充 creativeBrief：创作目标、可见视觉设计、产品展示或攻防编排（如适用）和对白计划；不要让用户填写技术表单"];
  const issues: string[] = techniqueIssues(shot);
  for (const asset of characters) {
    if (!stylingSchema.safeParse(asset.attributes?.styling).success) issues.push(`${asset.name} 缺少 attributes.styling 的 makeup、hair、costume、accessories 设计；可明确自然妆或无配饰及其理由，不默认素衣或华服`);
  }
  const brief = parsed.data;
  if (characters.length && (brief.kind === "performance" || brief.kind === "combat")) {
    if (!shot.action?.trim() || !shot.performance?.gesture?.trim() || !shot.performance?.timing?.trim()) issues.push("人物戏须明确行动目标、可见表演、触发与反应节拍；情绪标签不能代替表演");
    if (!Object.values(shot.blocking ?? {}).some(value => value.trim()) || !shot.camera?.design?.subjectPath?.trim()) issues.push("人物戏须明确相对位置与人物路径；有意不移动时写明停留位置、注意对象和叙事作用，不用摄影机运动代替人物行为");
    if (!shot.camera?.design?.purpose?.trim() || !shot.camera?.design?.cut?.trim() || !shot.camera?.design?.timing?.trim()) issues.push("人物戏须明确镜头传递的信息、局部行动节拍及剪辑入出依据，不能用固定时长填满空动作");
  }
  if (brief.kind === "combat" && !brief.combat) issues.push("武打镜头须先设计 combat 的局面转折、标志性动作、攻防因果与摄影覆盖，不能只填写强度或激烈形容词");
  const timeline = shot.camera?.design?.timeline ?? shot.musicVideo?.timeline;
  if (brief.kind === "combat") {
    const design = shot.camera?.design;
    if (!design?.mode || !timeline?.length) issues.push("动作戏须明确 singleTake/multiShot 和唯一执行时间线，将空间交代、避让、交锋、位移及结果落到本镜实际节拍；不能用笼统打斗代替");
    if (!design?.start?.trim() || !design.end?.trim() || !design.invariants?.length) issues.push("动作戏须保存起止空间状态和保持项：人物、退路、障碍物、持物与运动方向；承接前镜真实末态，不重置站位");
    if (!shot.camera?.position?.trim() || !shot.lighting?.worldSource?.trim()) issues.push("动作戏须明确摄影机相对位置和场景光源，换机位时保持空间及实际光源关系");
  }
  const duration = shot.generationDuration ?? shot.duration;
  const characterIds = new Set(assets.filter(asset => asset.type === "Character").map(asset => asset.id));
  const assetIds = visibleIds;
  for (const beat of brief.combat?.beats ?? []) {
    if (!assetIds.has(beat.attackerId) || !assetIds.has(beat.defenderId) || beat.attackerId === beat.defenderId) issues.push("攻防双方须为本镜实际出场的不同资产");
    if (beat.timelineIndex === undefined || !timeline?.[beat.timelineIndex]) issues.push("每个攻防节拍须用 timelineIndex 绑定唯一执行时间线中的有效节拍，由助手补齐；同一时段可有多人并行动作，不另编冲突秒数");
  }
  for (const line of brief.dialogue.lines) {
    if (!characterIds.has(line.speakerId)) issues.push("对白说话人须为本镜的真实角色资产");
    if (line.lipSync === "visible" && !visibleIds.has(line.speakerId)) issues.push("画内说话人须在出镜资产中；画外声音使用 offscreen");
    if (line.end <= line.start || line.end > duration) issues.push("对白起止时间须在本段生成时长内，并为发声及口型留出时间");
  }
  if (resolveDialogueMode(shot) === "native" && shot.musicVideo && shot.musicVideo.audioMode !== "generated") issues.push("原生对白与静音/原曲方案冲突；保留台词，修改声音方案或明确后期配音对口型路径");
  return [...new Set(issues)];
}

export const creativeReviewSchema = z.object({
  verdict: z.enum(["pass", "revise"]),
  styling: z.string().trim().min(10).max(2000),
  staging: z.string().trim().min(10).max(2000),
}).strict();
