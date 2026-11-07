import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentModel } from "@/agent/runtime/model";
import { recordTextUsage } from "@/utils/usage";
import { assertModelSelection } from "@/utils/modelSelection";

const inputSchema = z.strictObject({
  brief: z.string().trim().min(1).max(20000).describe("完整用户要求，包括题材、篇幅、人物、风格、结尾和明确限制"),
  direction: z.string().max(20000).describe("已选择的创作方向与必须保留的事实；未指定时空字符串"),
});

const musicPlanSchema = z.strictObject({
  durationSeconds: z.number().positive().describe("brief 给定的全曲时长；未知时仅填明确标为估算的创作时长"),
  openingPromise: z.string().min(1).describe("开场已发生的行动，让观众关心哪个尚未确定的具体结果；不是主题或情绪"),
  characters: z.array(z.strictObject({
    name: z.string().min(1),
    desire: z.string().min(1),
    involvement: z.string().min(1).describe("为什么参与，自己的行动怎样改变别人；说明谁是固定歌手"),
    relationshipEvidence: z.string().min(1).describe("观众通过哪次具体互动辨认关键关系与牵挂；不能只在计划中宣称伴侣、师生或朋友"),
    establishedAbility: z.string().min(1).describe("已具备的相关能力与边界；需要在正文展示什么，结尾不能突然掌握未建立的技能"),
  })).min(1).max(40),
  beats: z.array(z.strictObject({
    action: z.string().min(1).describe("谁采取什么具体办法；不写完整正文"),
    response: z.string().min(1).describe("他人或环境如何回应，改变了什么可行办法"),
    consequence: z.string().min(1).describe("本次结果为何引出下一步；表演或留白说明它承接什么及回去后的状态"),
    visibleEvidence: z.string().min(1).describe("不靠作者解释、不可听对白或读唇，观众实际看到什么就能理解"),
    durationSeconds: z.number().positive().describe("行动、位移、阅读、反应和留白合计的画面预算秒数，不是音乐实测卡点"),
  })).min(1).max(30),
  decisiveChoice: z.string().min(1).describe("高潮的具体选择；前面哪次互动建立了愿望与顾虑，哪次结果促成改法，行动真正改变了什么"),
  payoff: z.string().min(1).describe("结尾亲眼兑现开场哪个期待；不只用签表、微笑或走向远方宣告成长"),
  plausibility: z.string().min(1).describe("关键行动是否符合已建立能力、物理及现实条件；未核实的职业制度或专业操作不能成为解局前提，改用可直观理解的条件"),
  musicOrder: z.string().min(1).describe("按原曲已知歌词顺序连续使用；未知时不分配虚构主副歌，说明待对齐部分"),
});

const musicDraftSchema = z.strictObject({
  title: z.string().min(1),
  sound: z.string().min(1),
  mechanics: z.union([z.array(z.string().min(1)), z.string().min(1)]).describe("各关键道具唯一操作方式、操作者、手脚占用和空间条件；未知专业动作改用普通事件"),
  scenes: z.array(z.strictObject({
    text: z.string().min(1).describe("完整可视听正文，不新增预算外动作"),
    actions: z.array(z.strictObject({ action: z.string().min(1), seconds: z.number().positive() })).min(1),
    pauseSeconds: z.number().nonnegative(),
    seconds: z.number().positive(),
  })).min(1).max(20),
});

const storyBeatPrompt = "你是资深剧作架构师。brief是用户要求，direction是锁定方向与事实，writingMethod是创作参考，不能覆盖用户指定的题材、节奏和结尾。规划场面节拍与承重事实，不交正文。先明确观众期待的结果，再按本篇需要安排人物目标、行动、回应和可见变化；场数由内容与篇幅决定。每个关键场面区分观众与角色当时已知什么、何时看到或听到新证据、人物因此怎么做以及结果如何引出下一步。对抗题材须推演有立场的对手如何针对主角办法反制、筹码或代价怎样变化，以及高潮如何由已建立条件和人物选择决定；温情、喜剧、观察式及其他类型沿用自身期待，不强加反派、绝境、不可逆牺牲或悬念结尾。已有物件、空间或动作可通过不同使用发展意义，不为套母题新增事实，不用脏旧、衰老或固定影调代替情感。事实清单只保留影响行动的物件持有与交接、知情依据、时空、数量单位及规则；严格区分原稿事实与创作提案。最终兑现本篇承诺，保留必要余波，不重复解释已经发生的结果。";

const storyExecutionPrompt = "你是故事作者。依据用户要求、锁定方向、场面节拍与承重事实，按同一writingMethod写可信、连贯的完整正文，不评分、不操作工作台。用可见行动、真实对白、倾听反应与空间关系让观众经历事件；按预定顺序展示证据，不让角色无故全知，不用旁白解释掉关键过程。对抗题材写出双方策略、针对性反制与行动后果，温情、喜剧和观察式作品保持自己的力度与节奏；不能一律写成强敌压迫、悲剧牺牲或强行反转。已建立的物件与动作通过人物选择产生意义变化，不擅加污损、破败、疲态或滤镜。遵守既定物理、职业与事实逻辑，高潮或关键变化兑现已建立的条件和关系；完成本篇期待后留下适合当前方向的余波，不重复说理或多次收尾。用户指定的开放结尾、慢节奏、旁白形式和其他限制优先。第一行用‘# 标题’，之后只交完整正文。未限定字数时按情节需要充分写完，不自动缩写。";

const musicBeatPrompt = "本次是 MV。先从 brief 提取真实歌曲顺序、总时长、允许的声音通道及固定歌手/演员关系；不把猜测的主副歌名称当作事实。先构思一个观众会关心结果的具体事件，让人物在开场就行动。主要人物各有所求，主角的尝试引来具体回应，帮助的来路和局限预先成立；高潮是前面行动造成的选择与结果，不靠突然提供解法。逐场记录：观众实际看见什么证据、人物如何回应、结果为何迫使下一步、结尾选择的愿望与转机在哪里发生。无对白时，不用读唇或作者解释替代证据。再按连续原曲分配段落，只标已知的歌词顺序；同一句重复出现按出现次数区分，后段不能重播前段歌词。无时间码只给连续覆盖全曲的大致百分比，明确是画面预算而非实测对齐。每段估算串行动作、阅读、位移、反应和音乐留白所需容量；装不下先减事件或合并重复信息，不靠加快动作解决。未指定故事方向时内部比较不同事件的观看期待后选一套展开，不向用户重复征求选项。纯表演方向沿用音乐与舞台任务，不强加剧情。";

const musicExecutionPrompt = "本次是 MV。正文只写观众能看到或被允许听到的事件，按人物实际行动展示证据和选择，不用‘意思是、观众明白、他知道、她终于释怀’解释未拍出的因果。无额外对白时不添加发声、试麦、旁白或读唇解码；必要的无声交流须靠简单可辨的行动完成。歌词与原曲位置连续前进，不因切到歌手重新从头唱。允许剧情倒叙，原曲顺序不随倒叙重排。沿用蓝图的画面预算，保留反应与选择所需停留，修掉超量串行动作；歌词无时间码时不虚构主副歌、前奏或尾奏位置。歌手可独立表演或兼任一个剧情角色，其他人物继续有自己的行动。交完整可视听正文，简短注明声音约束和暂定画面预算，不交分析、评分或制作配置。";

const musicRevisionPrompt = "你是本篇 MV 的作者，进行一次完整稿修订。brief 的用户要求和 direction 的锁定事实优先，beats 和 draft 都是可修订草稿。只对照实际正文核查并修复：1.移除作者解释、不可听对白、读唇和细小文字后，观众是否仍能理解目标、证据与变化；缺证据须重写相关行动，不能只删解释。2.关键决定是否由先前展示的愿望、可行办法、眼前转机和回应促成；帮助是否有来路，主角是否参与解局；不能用签表、远望、微笑自动代表成长。3.开场是否让人关心一个具体结果，中段的行动是否改变下一步，高潮是否兑现前文；弱处改事件及其必要前因，不靠增加灾难、反派或固定反转凑刺激。4.原曲歌词按输入顺序及实际重复次数单向使用，演唱切入不能重新唱过前文歌词；无时间码不虚构段落位置，必要时去掉未经验证的逐句卡点，只保留顺序和画面预算。5.逐段串行动作、位移、阅读、反应和停留能否容纳在总时长内；删并重复信息，不压缩关键动作，不用平均分配掩盖超时。6.固定歌手和其他演员身份、服装状态、持物与出入场一致，声轨遵守用户限制。保留已成立的戏及原有风格，只修实际问题与依赖；不要为了审核把故事写成说明书。没有问题就完整保留原文。第一行用‘# 标题’，之后只交修订后的完整可视听正文，不输出审稿报告或自评通过。";

export async function writeStoryDraft(brief: string, direction: string, providerId: string, modelId: string, signal?: AbortSignal, writingMethod = "", musicFilm = false) {
  const input = inputSchema.parse({ brief, direction });
  assertModelSelection("text", providerId, modelId);
  const configured = await createAgentModel(providerId, modelId, "off");
  // ACT: 官方 Flash 支持 low；每阶段留足 token，避免推理与正文超限截断。
  const reasoning = new URL(configured.baseUrl).origin === "https://api.deepseek.com" && modelId === "deepseek-flash" ? "low" : undefined;
  const { runtime } = reasoning ? await createAgentModel(providerId, modelId, reasoning) : configured;
  const model = runtime.getModel(providerId, modelId)!;
  const readText = (content: { type: string; text?: string }[]) => content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n").trim();
  const stageDurations: { stage: string; durationMs: number }[] = [];
  let revisionDraft: unknown;

  // 阶段一：按当前类型推演场面节拍与承重事实。
  let beats = "";
  let firstStopReason: string | undefined;
  let planIssue: string | undefined;
  let planCorrectionAttempted = false;
  // ACT: 结构或预算失败只允许定向修正一次，保留原计划，不无限重抽故事。
  for (let attempt = 0; attempt < (musicFilm ? 2 : 1); attempt++) {
    planCorrectionAttempted = attempt > 0;
    const started = performance.now();
    const first = await runtime.completeSimple(model, {
      systemPrompt: musicFilm ? `${storyBeatPrompt}\n${musicBeatPrompt}\n只调用 submitMusicStoryPlan，先完成场面推演，不写正文。各段预算之和必须等于全曲时长，按事件容量分配，不把歌曲机械三等分。避免把整个故事简化为主角遇到一个小技术故障、旁人指点后成功、最后填表决定新生活；日常题材也须让人物之间真正有牵挂与变化。内在矛盾要通过具体互动发生，不规定必须激烈或悲剧。故事若依赖读者代补关系、关键决定仅由小技巧成功推出，就在提交前重构承重场面。` : storyBeatPrompt,
      messages: [{ role: "user", content: JSON.stringify({ ...input, writingMethod, ...(attempt > 0 ? { previousPlan: beats, correction: `${planIssue}。保留已有故事、人物与事件，只修正上述结构或预算错误；不得改全曲时长来凑总数。重新提交完整计划。` } : {}) }), timestamp: Date.now() }],
      ...(musicFilm ? { tools: [{ name: "submitMusicStoryPlan", description: "提交MV场面计划，只做结构推演与画面时间预算，不生成媒体", parameters: z.toJSONSchema(musicPlanSchema) }] } : {}),
    }, { reasoning, maxTokens: model.maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
    stageDurations.push({ stage: attempt ? "planCorrection" : "plan", durationMs: Math.round(performance.now() - started) });
    recordTextUsage(first);
    signal?.throwIfAborted();
    firstStopReason = first.stopReason;
    const planText = readText(first.content);
    if (planText) beats = planText;
    if (musicFilm) {
      const call = first.content.find(part => part.type === "toolCall" && part.name === "submitMusicStoryPlan");
      let value: unknown = call?.type === "toolCall" ? call.arguments : undefined;
      if (!value && planText) try { value = JSON.parse(planText.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* 正文不能冒充结构计划。 */ }
      const parsed = musicPlanSchema.safeParse(value);
      if (value !== undefined) beats = JSON.stringify(value);
      if (!["stop", "toolUse"].includes(first.stopReason)) planIssue = `MV 场面计划未完整返回（${first.stopReason}），未继续写作`;
      else if (!parsed.success) planIssue = `MV 场面计划结构不完整：${parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")}`;
      else {
        beats = JSON.stringify(parsed.data);
        const total = parsed.data.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0);
        planIssue = Math.abs(total - parsed.data.durationSeconds) > 1 ? `MV 场面预算合计 ${Number(total.toFixed(3))} 秒，计划全曲 ${parsed.data.durationSeconds} 秒，差额 ${Number((total - parsed.data.durationSeconds).toFixed(3))} 秒，未继续写作` : undefined;
      }
    }
    // ACT: 超时或请求错误不是计划内容错误，重复请求无法定向修复且会再次等待完整超时。
    if (!planIssue || !["stop", "toolUse"].includes(first.stopReason)) break;
  }

  // 阶段二：沿用同一工作法与事实写完整正文。
  let written = "";
  let secondStopReason: string | undefined;
  let revisionStopReason: string | undefined;
  let initialText: string | undefined;
  let executionSuccess = false;

  if (beats && (musicFilm ? !planIssue : firstStopReason === "stop" || beats.length >= 200)) {
    const started = performance.now();
    const second = await runtime.completeSimple(model, {
      systemPrompt: musicFilm ? `${storyExecutionPrompt}\n${musicExecutionPrompt}` : storyExecutionPrompt,
      messages: [{ role: "user", content: `用户要求、创作限制与同一工作法：\n${JSON.stringify({ ...input, writingMethod })}\n\n已确定的场面节拍与事实清单：\n${beats}`, timestamp: Date.now() }],
    }, { reasoning, maxTokens: model.maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
    stageDurations.push({ stage: "draft", durationMs: Math.round(performance.now() - started) });
    recordTextUsage(second);
    signal?.throwIfAborted();
    secondStopReason = second.stopReason;
    written = readText(second.content);
    executionSuccess = (second.stopReason === "stop" || !musicFilm && second.stopReason === "toolUse") && !!written;
  }

  // ACT: MV 只加一轮作者修订，含计划校正最多四次模型请求；完成不代表审稿通过。
  if (musicFilm && executionSuccess) {
    initialText = written;
    executionSuccess = false;
    const started = performance.now();
    try {
      const revision = await runtime.completeSimple(model, {
        tools: [{ name: "submitMusicDraft", description: "提交完整正文与逐场执行预算", parameters: z.toJSONSchema(musicDraftSchema) }],
        systemPrompt: `${musicRevisionPrompt.replace("第一行用‘# 标题’，之后只交修订后的完整可视听正文，不输出审稿报告或自评通过。", "只调用 submitMusicDraft 提交修订后的完整正文与预算，不输出审稿报告或自评通过。")}\n另检查承重前提：计划里写的亲密关系、专业身份和技能，必须在正文有观众可辨的依据。短时间内的成长可以是改变已会技能的用法或愿意尝试，不能把刚不会的人突然写成熟练者，不能用赠送物件代替真实资格。专业设施、工作流程和物理条件不能为结局随意失效或凭空生效；没有可靠依据时改成普通可理解的事件。若前提不成立，重构相关场面和因果，不能仅润色或把问题动作换成模糊描述。`,
        messages: [{ role: "user", content: JSON.stringify({ ...input, writingMethod, beats, draft: written, output: "最终只调用 submitMusicDraft。逐场列串行动作与真实耗时，计入阅读、位移、收尾，再留反应与选择时间。动作合计加pauseSeconds必须等于场seconds，各场合计等于计划全曲时长。装不下须删并事件，不压缩估计凑数。持续一分钟的动作不能在二十秒内连续发生，除非明确表现省略时间的跳切；故事正文、动作清单、人数与物件状态须逐项一致。正文不新增预算外动作。mechanics统一道具机制、手脚占用和空间条件；无法确认的专业操作改为普通可理解事件，不能混合不同机制或靠复杂手势解释。sound保留原曲连续与用户声音限制。" }), timestamp: Date.now() }],
      }, { reasoning, maxTokens: model.maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
      recordTextUsage(revision);
      signal?.throwIfAborted();
      revisionStopReason = revision.stopReason;
      const call = revision.content.find(part => part.type === "toolCall" && part.name === "submitMusicDraft");
      revisionDraft = call?.type === "toolCall" ? call.arguments : readText(revision.content);
      const parsed = musicDraftSchema.safeParse(call?.type === "toolCall" ? call.arguments : undefined);
      if (!parsed.success) planIssue = `修订稿结构不完整：${parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")}；已保留初稿`;
      if (parsed.success && ["stop", "toolUse"].includes(revision.stopReason)) {
        const draft = parsed.data;
        const duration = JSON.parse(beats).durationSeconds as number;
        const total = draft.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
        executionSuccess = Math.abs(total - duration) < 0.1 && draft.scenes.every(scene => Math.abs(scene.actions.reduce((sum, action) => sum + action.seconds, scene.pauseSeconds) - scene.seconds) < 0.1);
        if (executionSuccess) written = [`# ${draft.title}`, draft.sound, "以下为暂定画面预算，非实测歌词卡点。", ...draft.scenes.map((scene, index) => `## 场 ${index + 1}（约 ${scene.seconds} 秒）\n\n${scene.text}\n\n动作预算：${scene.actions.map(action => `${action.action} ${action.seconds} 秒`).join("；")}；反应留白 ${scene.pauseSeconds} 秒。`), `总预算：${total} 秒。`, "执行约束：", ...(Array.isArray(draft.mechanics) ? draft.mechanics : [draft.mechanics])].join("\n\n");
        else planIssue = "最终稿动作预算或全曲合计不一致，已保留初稿，不可作为成品交付";
      }
    } catch (error) {
      signal?.throwIfAborted();
      revisionStopReason = "error";
      planIssue = `MV 作者修订调用失败：${error instanceof Error ? error.message : String(error)}；已保留初稿`;
    } finally {
      stageDurations.push({ stage: "revision", durationMs: Math.round(performance.now() - started) });
    }
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
    ...(musicFilm ? { initialText, revisionDraft, stageDurations, planCorrectionAttempted, authorRevisionComplete: executionSuccess, writingStopReason: secondStopReason } : {}),
    revised: executionSuccess,
    skillApplied: !!writingMethod.trim(),
    draftingStopReason: firstStopReason,
    revisionStopReason: musicFilm ? revisionStopReason : secondStopReason,
    complete: executionSuccess,
    withinRange,
    warning: executionSuccess ? undefined : planIssue ?? (initialText ? "MV 作者修订未完成，已保留初稿，不可作为成品交付" : firstStopReason === "stop" && beats ? "正文连贯写作未完成，不可作为成品交付" : "节拍架构推演未完成，不可作为完整故事交付")
  };
}

export function createStoryWriter(providerId: string, modelId: string, loadInstructions: (signal?: AbortSignal) => Promise<string>, musicFilm = false): ToolDefinition {
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
      const details = await writeStoryDraft(input.brief, input.direction, providerId, modelId, signal, writingMethod, musicFilm);
      // 节拍草案留在工具详情供追溯；模型上下文只接收本次交付文本。
      const { initialDraft, initialText, revisionDraft, ...delivery } = details;
      return { content: [{ type: "text", text: JSON.stringify(delivery) }], details };
    },
  };
}
