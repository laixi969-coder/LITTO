import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentModel } from "@/agent/runtime/model";
import { recordTextUsage } from "@/utils/usage";
import { assertModelSelection } from "@/utils/modelSelection";

const inputSchema = z.strictObject({
  brief: z.string().trim().min(1).max(20000).describe("完整用户要求，包括题材、篇幅、人物、风格、结尾和明确限制"),
  direction: z.string().max(20000).describe("已选择的创作方向与必须保留的事实；未指定时空字符串"),
});

const storyBeatPrompt = "你是资深剧作架构师。为紧迫、精彩、环环相扣的故事规划戏剧攻防节拍表与承重事实清单。brief是用户要求，direction是锁定方向与事实；writingMethod是创作参考。内部推演核心危机与不可逆时限、对手立场与杀招反制链（主角行动必引来对手强力反击，绝不顺拐）、绝境抉择与不可逆代价、高潮规则决胜（前期建立的物理/职业/心理条件集中爆发决定胜负），以及决绝收束（主体事件完成当场定格，严禁在结尾总结道理、规划未来或讨论法律条文）。请输出五场因果攻防节拍（每场包含处境、攻防交锋、局面变化、真实代价）与承重事实清单（道具持有、知情差、时间物理规则），不交正文。";

const storyExecutionPrompt = "你是顶尖故事作者。根据用户要求、锁定方向以及已确定的【戏剧攻防节拍表与承重事实清单】，写出极其精彩、可信、连贯的完整故事正文，不评分、不操作工作台。沉浸视听开篇，对手压迫感拉满，对白如刀锋行动而非说理；严格遵守物理、职业与事实逻辑；高潮集中兑现前期铺垫，主体事件完成后以强烈的动作或情感余波利落定格，严禁在结尾长篇开会、解释未来或赛后总结。第一行用‘# 标题’，之后只交完整正文。未限定字数时按情节需要充分写完，不自动缩写。";

export async function writeStoryDraft(brief: string, direction: string, providerId: string, modelId: string, signal?: AbortSignal, writingMethod = "") {
  const input = inputSchema.parse({ brief, direction });
  assertModelSelection("text", providerId, modelId);
  const configured = await createAgentModel(providerId, modelId, "off");
  // ACT: 官方 Flash 支持 low；两阶段管线各留足 token，避免推理与正文超限截断。
  const reasoning = new URL(configured.baseUrl).origin === "https://api.deepseek.com" && modelId === "deepseek-flash" ? "low" : undefined;
  const { runtime } = reasoning ? await createAgentModel(providerId, modelId, reasoning) : configured;
  const model = runtime.getModel(providerId, modelId)!;
  const readText = (content: { type: string; text?: string }[]) => content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n").trim();

  // 阶段一：推演戏剧对抗攻防节拍表与承重事实账本
  const first = await runtime.completeSimple(model, {
    systemPrompt: storyBeatPrompt,
    messages: [{ role: "user", content: JSON.stringify({ ...input, writingMethod }), timestamp: Date.now() }],
  }, { reasoning, maxTokens: model.maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
  recordTextUsage(first);
  signal?.throwIfAborted();
  const beats = readText(first.content);

  // 阶段二：依据明确的攻防骨架与事实账本，全景连贯创作高张力正文
  let written = "";
  let secondStopReason: string | undefined;
  let executionSuccess = false;

  if (beats && (first.stopReason === "stop" || beats.length >= 200)) {
    const second = await runtime.completeSimple(model, {
      systemPrompt: storyExecutionPrompt,
      messages: [{ role: "user", content: `用户要求与创作限制：\n${JSON.stringify(input)}\n\n已确定的戏剧攻防节拍表与事实清单：\n${beats}`, timestamp: Date.now() }],
    }, { reasoning, maxTokens: model.maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
    recordTextUsage(second);
    signal?.throwIfAborted();
    secondStopReason = second.stopReason;
    written = readText(second.content);
    executionSuccess = (second.stopReason === "stop" || second.stopReason === "toolUse") && !!written;
  }

  const heading = written.match(/^#\s+([^\n]+)\n+/u);
  const title = heading?.[1]?.trim() || "故事正文";
  const text = heading ? written.slice(heading[0].length).trim() : written;
  const textCharacters = (text.match(/[\p{Letter}\p{Number}]/gu) ?? []).length;
  const range = brief.match(/(\d{2,5})\s*(?:至|到|[-—–~～])\s*(\d{2,5})\s*(?:个)?(?:汉字|字|字符)/u);
  const minimum = range ? Number(range[1]) : undefined, maximum = range ? Number(range[2]) : undefined;
  const withinRange = minimum && maximum && minimum <= maximum ? textCharacters >= minimum && textCharacters <= maximum : undefined;

  return {
    title,
    text,
    textCharacters,
    initialDraft: beats,
    revised: executionSuccess,
    skillApplied: !!writingMethod.trim(),
    draftingStopReason: first.stopReason,
    revisionStopReason: secondStopReason,
    complete: executionSuccess,
    withinRange,
    warning: executionSuccess ? undefined : first.stopReason === "stop" && beats ? "正文连贯写作未完成，不可作为成品交付" : "节拍架构推演未完成，不可作为完整故事交付"
  };
}

export function createStoryWriter(providerId: string, modelId: string, loadInstructions: (signal?: AbortSignal) => Promise<string>): ToolDefinition {
  let attempts = 0;
  return {
    name: "writeStoryDraft", label: "创作故事正文", description: "在独立创作上下文中完成初稿与作者修订，不继承审稿辩论；返回修订草稿，沿用现有计数与审稿交付。",
    promptGuidelines: ["完整故事创作先确定用户要求和已选方向，再用writeStoryDraft写正文。brief须包含全部明确限制，direction只传已选方向和必须保留事实，不传评分与审稿辩论。局部改写复用原稿。complete:false表示初稿或作者修订尚未完成，不得当完成稿交付；withinRange:false须如实处理篇幅；skillApplied:false表示创作技能未进入本次请求，不能声称已使用。工具返回草稿不代表审稿通过，继续既有prepareStoryText或工作台保存流程。"],
    parameters: z.toJSONSchema(inputSchema), executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = inputSchema.parse(params);
      if (attempts >= 3) throw new Error("本轮三次独立创作已耗尽，请保留稿件并说明未完成部分");
      attempts++;
      const writingMethod = await loadInstructions(signal);
      const details = await writeStoryDraft(input.brief, input.direction, providerId, modelId, signal, writingMethod);
      // 节拍草案留在工具详情供追溯；模型上下文只接收本次交付文本。
      const { initialDraft, ...delivery } = details;
      return { content: [{ type: "text", text: JSON.stringify(delivery) }], details };
    },
  };
}
