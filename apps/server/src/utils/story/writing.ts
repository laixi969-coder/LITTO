import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentModel } from "@/agent/runtime/model";
import { recordTextUsage } from "@/utils/usage";
import { assertModelSelection } from "@/utils/modelSelection";

const inputSchema = z.strictObject({
  brief: z.string().trim().min(1).max(20000).describe("完整用户要求，包括题材、篇幅、人物、风格、结尾和明确限制"),
  direction: z.string().max(20000).describe("已选择的创作方向与必须保留的事实；未指定时空字符串"),
});

const storyBeatPrompt = "你是资深剧作架构师。brief是用户要求，direction是锁定方向与事实，writingMethod是创作参考，不能覆盖用户指定的题材、节奏和结尾。规划场面节拍与承重事实，不交正文。先明确观众期待的结果，再按本篇需要安排人物目标、行动、回应和可见变化；场数由内容与篇幅决定。每个关键场面区分观众与角色当时已知什么、何时看到或听到新证据、人物因此怎么做以及结果如何引出下一步。对抗题材须推演有立场的对手如何针对主角办法反制、筹码或代价怎样变化，以及高潮如何由已建立条件和人物选择决定；温情、喜剧、观察式及其他类型沿用自身期待，不强加反派、绝境、不可逆牺牲或悬念结尾。已有物件、空间或动作可通过不同使用发展意义，不为套母题新增事实，不用脏旧、衰老或固定影调代替情感。事实清单只保留影响行动的物件持有与交接、知情依据、时空、数量单位及规则；严格区分原稿事实与创作提案。最终兑现本篇承诺，保留必要余波，不重复解释已经发生的结果。";

const storyExecutionPrompt = "你是故事作者。依据用户要求、锁定方向、场面节拍与承重事实，按同一writingMethod写可信、连贯的完整正文，不评分、不操作工作台。用可见行动、真实对白、倾听反应与空间关系让观众经历事件；按预定顺序展示证据，不让角色无故全知，不用旁白解释掉关键过程。对抗题材写出双方策略、针对性反制与行动后果，温情、喜剧和观察式作品保持自己的力度与节奏；不能一律写成强敌压迫、悲剧牺牲或强行反转。已建立的物件与动作通过人物选择产生意义变化，不擅加污损、破败、疲态或滤镜。遵守既定物理、职业与事实逻辑，高潮或关键变化兑现已建立的条件和关系；完成本篇期待后留下适合当前方向的余波，不重复说理或多次收尾。用户指定的开放结尾、慢节奏、旁白形式和其他限制优先。第一行用‘# 标题’，之后只交完整正文。未限定字数时按情节需要充分写完，不自动缩写。";

export async function writeStoryDraft(brief: string, direction: string, providerId: string, modelId: string, signal?: AbortSignal, writingMethod = "") {
  const input = inputSchema.parse({ brief, direction });
  assertModelSelection("text", providerId, modelId);
  const configured = await createAgentModel(providerId, modelId, "off");
  // ACT: 官方 Flash 支持 low；两阶段管线各留足 token，避免推理与正文超限截断。
  const reasoning = new URL(configured.baseUrl).origin === "https://api.deepseek.com" && modelId === "deepseek-flash" ? "low" : undefined;
  const { runtime } = reasoning ? await createAgentModel(providerId, modelId, reasoning) : configured;
  const model = runtime.getModel(providerId, modelId)!;
  const readText = (content: { type: string; text?: string }[]) => content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n").trim();

  // 阶段一：按当前类型推演场面节拍与承重事实。
  const first = await runtime.completeSimple(model, {
    systemPrompt: storyBeatPrompt,
    messages: [{ role: "user", content: JSON.stringify({ ...input, writingMethod }), timestamp: Date.now() }],
  }, { reasoning, maxTokens: model.maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
  recordTextUsage(first);
  signal?.throwIfAborted();
  const beats = readText(first.content);

  // 阶段二：沿用同一工作法与事实写完整正文。
  let written = "";
  let secondStopReason: string | undefined;
  let executionSuccess = false;

  if (beats && (first.stopReason === "stop" || beats.length >= 200)) {
    const second = await runtime.completeSimple(model, {
      systemPrompt: storyExecutionPrompt,
      messages: [{ role: "user", content: `用户要求、创作限制与同一工作法：\n${JSON.stringify({ ...input, writingMethod })}\n\n已确定的场面节拍与事实清单：\n${beats}`, timestamp: Date.now() }],
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
