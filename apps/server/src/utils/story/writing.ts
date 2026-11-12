import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentModel } from "@/agent/runtime/model";
import { recordTextUsage } from "@/utils/usage";
import { assertModelSelection } from "@/utils/modelSelection";
import { musicDraftSchema, repairMusicScenes, musicCapacityIssues, renderMusicDraft, reviewMusicExecution } from "@/utils/story/musicExecution";

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
    durationSeconds: z.number().positive().describe("建议画面时长，作为场次分配权重；程序按全曲时长分配固定预算，再写动作，不能当作实测卡点"),
  })).min(1).max(30),
  decisiveChoice: z.string().min(1).describe("高潮的具体选择；前面哪次互动建立了愿望与顾虑，哪次结果促成改法，行动真正改变了什么"),
  payoff: z.string().min(1).describe("结尾亲眼兑现开场哪个期待；不只用签表、微笑或走向远方宣告成长"),
  plausibility: z.string().min(1).describe("关键行动是否符合已建立能力、物理及现实条件；未核实的职业制度或专业操作不能成为解局前提，改用可直观理解的条件"),
  musicOrder: z.string().min(1).describe("按原曲已知歌词顺序连续使用；未知时不分配虚构主副歌，说明待对齐部分"),
});

const storyBeatPrompt = "依据上面按作品类型加载的创作方法及用户要求，内部规划场面节拍和承重事实，不交完整正文。沿用已选方向与锁定内容；按本篇需要组织行动、应对、变化、信息顺序、时空和持物。不能把节拍或元数据当作已经写出的戏。工作台保存与采用由主助手处理，本次不操作工作台。";

const storyExecutionPrompt = "依据同一作品创作方法、用户要求、已定方向及场面计划写完整故事或剧本。实际正文须落实计划中的独立戏剧场景，交付前按方法逐场自检。严格遵守用户指定格式；没有格式要求时可用 # 标题开头，之后只交完整正文，不附分析、评分或自检表。本次只负责正文，保存与采用由主助手处理。";

const musicBeatPrompt = "本次是 MV。先从 brief 提取真实歌曲顺序、总时长、允许的声音通道及固定歌手/演员关系；不把猜测的主副歌名称当作事实。先构思一个观众会关心结果的具体事件，让人物在开场就行动。主要人物各有所求，主角的尝试引来具体回应，帮助的来路和局限预先成立；高潮是前面行动造成的选择与结果，不靠突然提供解法。逐场记录：观众实际看见什么证据、人物如何回应、结果为何迫使下一步、结尾选择的愿望与转机在哪里发生。无对白时，不用读唇或作者解释替代证据。再按连续原曲分配段落，只标已知的歌词顺序；同一句重复出现按出现次数区分，后段不能重播前段歌词。无时间码只给连续覆盖全曲的大致百分比，明确是画面预算而非实测对齐。每段估算串行动作、阅读、位移、反应和音乐留白所需容量；装不下先减事件或合并重复信息，不靠加快动作解决。未指定故事方向时内部比较不同事件的观看期待后选一套展开，不向用户重复征求选项。纯表演方向沿用音乐与舞台任务，不强加剧情。";

const musicExecutionPrompt = "本次是 MV。正文只写观众能看到或被允许听到的事件，按人物实际行动展示证据和选择，不用‘意思是、观众明白、他知道、她终于释怀’解释未拍出的因果。无额外对白时不添加发声、试麦、旁白或读唇解码；必要的无声交流须靠简单可辨的行动完成。歌词与原曲位置连续前进，不因切到歌手重新从头唱。允许剧情倒叙，原曲顺序不随倒叙重排。沿用蓝图的画面预算，保留反应与选择所需停留，修掉超量串行动作；歌词无时间码时不虚构主副歌、前奏或尾奏位置。歌手可独立表演或兼任一个剧情角色，其他人物继续有自己的行动。交完整可视听正文，简短注明声音约束和暂定画面预算，不交分析、评分或制作配置。";

const musicRevisionPrompt = "你是本篇 MV 的作者，进行一次完整稿修订。brief 的用户要求和 direction 的锁定事实优先，beats 和 draft 都是可修订草稿。只对照实际正文核查并修复：1.移除作者解释、不可听对白、读唇和细小文字后，观众是否仍能理解目标、证据与变化；缺证据须重写相关行动，不能只删解释。2.关键决定是否由先前展示的愿望、可行办法、眼前转机和回应促成；帮助是否有来路，主角是否参与解局；不能用签表、远望、微笑自动代表成长。3.开场是否让人关心一个具体结果，中段的行动是否改变下一步，高潮是否兑现前文；弱处改事件及其必要前因，不靠增加灾难、反派或固定反转凑刺激。4.原曲歌词按输入顺序及实际重复次数单向使用，演唱切入不能重新唱过前文歌词；无时间码不虚构段落位置，必要时去掉未经验证的逐句卡点，只保留顺序和画面预算。5.逐段串行动作、位移、阅读、反应和停留能否容纳在总时长内；删并重复信息，不压缩关键动作，不用平均分配掩盖超时。6.固定歌手和其他演员身份、服装状态、持物与出入场一致，声轨遵守用户限制。保留已成立的戏及原有风格，只修实际问题与依赖；不要为了审核把故事写成说明书。没有问题就完整保留原文。第一行用‘# 标题’，之后只交修订后的完整可视听正文，不输出审稿报告或自评通过。";

export async function writeStoryDraft(brief: string, direction: string, providerId: string, modelId: string, signal?: AbortSignal, writingMethod = "", musicFilm = false, resume?: { plan: unknown; text: string; draft: unknown }) {
  if (!writingMethod.trim()) throw new Error("当前作品的创作方法未加载，请启用相应技能读取后重试；未使用其他默认写法生成");
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
  if (resume && !musicFilm) throw new Error("只有 MV 执行检查支持恢复已保留稿件");
  if (resume) {
    const draft = musicDraftSchema.parse(resume.draft);
    revisionDraft = { ...draft, scenes: Object.fromEntries(draft.scenes.map((scene, index) => [`scene${index + 1}`, scene])) };
  }
  const revisionHistory: unknown[] = [];
  const executionReviews: Awaited<ReturnType<typeof reviewMusicExecution>>[] = [];
  let authorRevisionComplete = false;
  let executionReviewFailure: unknown;
  let planBudgetAdjusted = false;

  // 阶段一：按当前类型推演场面节拍与承重事实。
  let beats = resume ? JSON.stringify(musicPlanSchema.parse(resume.plan)) : "";
  let firstStopReason: string | undefined;
  let planIssue: string | undefined;
  let planCorrectionAttempted = false;
  // ACT: 结构或预算失败只允许定向修正一次，保留原计划，不无限重抽故事。
  for (let attempt = 0; !resume && attempt < (musicFilm ? 2 : 1); attempt++) {
    planCorrectionAttempted = attempt > 0;
    const started = performance.now();
    const first = await runtime.completeSimple(model, {
      systemPrompt: musicFilm ? `${writingMethod}\n\n${storyBeatPrompt}\n${musicBeatPrompt}\n只调用 submitMusicStoryPlan，先完成场面推演，不写正文。各段提交建议时长作为分配权重，程序按全曲时长固定各场预算后再写动作；按事件需要分配，不把歌曲机械三等分。避免把整个故事简化为主角遇到一个小技术故障、旁人指点后成功、最后填表决定新生活；日常题材也须让人物之间真正有牵挂与变化。内在矛盾要通过具体互动发生，不规定必须激烈或悲剧。故事若依赖读者代补关系、关键决定仅由小技巧成功推出，就在提交前重构承重场面。` : `${writingMethod}\n\n${storyBeatPrompt}`,
      messages: [{ role: "user", content: JSON.stringify({ ...input, ...(attempt > 0 ? { previousPlan: beats, correction: `${planIssue}。保留已有故事、人物与事件，只修正上述结构或预算错误；不得改全曲时长来凑总数。重新提交完整计划。` } : {}) }), timestamp: Date.now() }],
      ...(musicFilm ? { tools: [{ name: "submitMusicStoryPlan", description: "提交MV场面计划，只做结构推演与画面时间预算，不生成媒体", parameters: z.toJSONSchema(musicPlanSchema) }] } : {}),
    }, { reasoning, maxTokens: model.maxTokens,
      ...(musicFilm && model.id === "qwen3.8-flash" && model.api === "openai-completions" ? { onPayload: (payload: unknown) => ({ ...payload as object, tool_choice: { type: "function", function: { name: "submitMusicStoryPlan" } } }) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
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
      if (!["stop", "toolUse"].includes(first.stopReason)) planIssue = `MV 场面计划未完整返回（${first.stopReason}${first.errorMessage ? `：${first.errorMessage}` : ""}），未继续写作`;
      else if (!parsed.success) planIssue = `MV 场面计划结构不完整：${parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")}`;
      else {
        const total = parsed.data.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0);
        planBudgetAdjusted ||= Math.abs(total - parsed.data.durationSeconds) > 0.001;
        // ACT: 只分配构思阶段的场次比例；不缩短正文动作耗时，超量动作后续须删并或改写。
        let cumulative = 0, allocated = 0;
        for (const beat of parsed.data.beats) {
          cumulative += beat.durationSeconds;
          const end = Math.round(cumulative / total * Math.round(parsed.data.durationSeconds * 1000));
          beat.durationSeconds = (end - allocated) / 1000;
          allocated = end;
        }
        beats = JSON.stringify(parsed.data);
        planIssue = parsed.data.beats.some(beat => beat.durationSeconds <= 0) ? "场次分配小于一毫秒，需合并无有效容量的场次" : undefined;
      }
    }
    // ACT: 超时或请求错误不是计划内容错误，重复请求无法定向修复且会再次等待完整超时。
    if (!planIssue || !["stop", "toolUse"].includes(first.stopReason)) break;
  }

  // 阶段二：沿用同一工作法与事实写完整正文。
  let written = resume ? z.string().trim().min(1).parse(resume.text) : "";
  let secondStopReason: string | undefined;
  let revisionStopReason: string | undefined;
  let initialText: string | undefined;
  let executionSuccess = !!resume;

  if (!resume && beats && (musicFilm ? !planIssue : firstStopReason === "stop" || beats.length >= 200)) {
    const started = performance.now();
    const second = await runtime.completeSimple(model, {
      systemPrompt: `${writingMethod}\n\n${storyExecutionPrompt}${musicFilm ? `\n${musicExecutionPrompt}` : ""}`,
      messages: [{ role: "user", content: `用户要求、创作限制与同一工作法：\n${JSON.stringify(input)}\n\n已确定的场面节拍与事实清单：\n${beats}`, timestamp: Date.now() }],
    }, { reasoning, maxTokens: model.maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
    stageDurations.push({ stage: "draft", durationMs: Math.round(performance.now() - started) });
    recordTextUsage(second);
    signal?.throwIfAborted();
    secondStopReason = second.stopReason;
    written = readText(second.content);
    executionSuccess = (second.stopReason === "stop" || !musicFilm && second.stopReason === "toolUse") && !!written;
  }

  // ACT: 容量或独立执行审读发现问题后，只对当前稿定向修正至多两次，每次复查，不重抽故事。
  if (musicFilm && executionSuccess) {
    initialText = written;
    executionSuccess = false;
    const plan = musicPlanSchema.parse(JSON.parse(beats));
    const slots = plan.beats.map(beat => beat.durationSeconds);
    // 固定键逐场提交，避免兼容模型忽略数组长度后漏掉场次、错配其后全部预算。
    const submissionSchema = musicDraftSchema.extend({ scenes: z.strictObject(Object.fromEntries(slots.map((_, index) => [`scene${index + 1}`, musicDraftSchema.shape.scenes.element]))) });
    let feedback: unknown = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      try {
        if (!resume || attempt > 0) {
          const correcting = attempt > 0 && musicDraftSchema.safeParse(revisionDraft).success;
          if (correcting) {
            const corrected = await repairMusicScenes(runtime, model, input.brief, musicDraftSchema.parse(revisionDraft), slots, executionReviews.at(-1)?.issues ?? [], signal);
            stageDurations.push({ stage: "executionSceneCorrections", durationMs: Math.round(performance.now() - started) });
            revisionHistory.push({ sceneRepairs: corrected.submissions });
            revisionDraft = { ...corrected.draft, scenes: Object.fromEntries(corrected.draft.scenes.map((scene, index) => [`scene${index + 1}`, scene])) };
          } else {
            const revision = await runtime.completeSimple(model, {
              tools: [{ name: "submitMusicDraft", description: "提交完整正文，每个固定scene键必须填写", parameters: z.toJSONSchema(submissionSchema) }],
              systemPrompt: `${writingMethod}\n\n${musicRevisionPrompt.replace("第一行用‘# 标题’，之后只交修订后的完整可视听正文，不输出审稿报告或自评通过。", "只调用submitMusicDraft。actions.action是交付正文，不另填正文或场时长。每段只围绕一次主要操作及直接反应，不把多个串行动作挤在同一句。hold只描述已建立画面的停留。未知专业解局改为普通事件，保留人物能力限制；必要的工序和位移可以用明确可辨的跳切省略时间，不能瞬间完成全过程。原曲唯一时不要写可听对白、铃声和音效；无校正时间码不指定逐句唱点。")}`,
              messages: [{ role: "user", content: JSON.stringify({ ...input, beats: plan, slots: slots.map((seconds, index) => ({ scene: `scene${index + 1}`, seconds })), draft: written, feedback, output: "scenes填对象并交齐所有scene键，每场动作总耗时不得超过预算。为反应留时间；超量删并，不按比例缩短估计。保留人物关系和观看期待，不新增设备、规则、权限或象征物补洞。" }), timestamp: Date.now() }],
            }, { reasoning, maxTokens: model.maxTokens,
              ...(model.id === "qwen3.8-flash" && model.api === "openai-completions" ? { onPayload: (payload: unknown) => ({ ...payload as object, tool_choice: { type: "function", function: { name: "submitMusicDraft" } } }) } : {}),
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
            stageDurations.push({ stage: "revision", durationMs: Math.round(performance.now() - started) });
            recordTextUsage(revision);
            signal?.throwIfAborted();
            revisionStopReason = revision.stopReason;
            const call = revision.content.find(part => part.type === "toolCall" && part.name === "submitMusicDraft");
            revisionDraft = call?.type === "toolCall" ? call.arguments : readText(revision.content);
            revisionHistory.push(revisionDraft);
            if (!["stop", "toolUse"].includes(revision.stopReason)) {
              planIssue = `MV 修订请求未完成（${revision.stopReason}${revision.errorMessage ? `：${revision.errorMessage}` : ""}），已保留初稿`;
              break;
            }
          }
        } else revisionHistory.push(revisionDraft);
        const parsed = submissionSchema.safeParse(revisionDraft);
        if (!parsed.success) {
          planIssue = `修订稿结构不完整：${parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")}`;
          feedback = planIssue;
          continue;
        }
        const draft = { ...parsed.data, scenes: slots.map((_, index) => parsed.data.scenes[`scene${index + 1}`]!) };
        revisionDraft = draft;
        const capacity = musicCapacityIssues(draft, slots);
        authorRevisionComplete = !capacity.length;
        const reviewStarted = performance.now();
        let review;
        try { review = await reviewMusicExecution(runtime, model, input.brief, draft, slots, signal); }
        finally { stageDurations.push({ stage: attempt ? "executionRecheck" : "executionReview", durationMs: Math.round(performance.now() - reviewStarted) }); }
        executionReviews.push(review);
        if (capacity.length || review.issues.length) {
          planIssue = [...capacity, ...review.issues.map(issue => `场${issue.scene}段${issue.paragraph}：${issue.problem}`)].join("；");
          feedback = { capacity, execution: review.issues };
          continue;
        }
        written = renderMusicDraft(draft, slots);
        if (review.notes.length) written += `\n\n待排练或音轨校准事项：\n${review.notes.map(note => `- 场${note.scene}段${note.paragraph}：${note.problem}`).join("\n")}`;
        executionSuccess = true;
        planIssue = undefined;
        break;
      } catch (error) {
        signal?.throwIfAborted();
        revisionStopReason = "error";
        executionReviewFailure = error instanceof Error ? error.cause : undefined;
        planIssue = `MV 修订或执行审读失败：${error instanceof Error ? error.message : String(error)}；已保留初稿`;
        break;
      }
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
    ...(musicFilm ? { initialText, revisionDraft, revisionHistory, executionReviews, executionNotes: executionReviews.at(-1)?.notes ?? [], executionReviewFailure, stageDurations, resumedExecution: !!resume, planCorrectionAttempted, planBudgetAdjusted, authorRevisionComplete, executionReviewComplete: executionSuccess, writingStopReason: secondStopReason } : {}),
    revised: executionSuccess,
    skillApplied: !!writingMethod.trim(),
    draftingStopReason: firstStopReason,
    revisionStopReason: musicFilm ? revisionStopReason : secondStopReason,
    complete: executionSuccess,
    withinRange,
    warning: executionSuccess ? (executionReviews.at(-1)?.notes.length ? "文字级检查完成，仍有待排练或音轨校准事项，见executionNotes" : undefined) : planIssue ?? (initialText ? "MV 作者修订未完成，已保留初稿，不可作为成品交付" : firstStopReason === "stop" && beats ? "正文连贯写作未完成，不可作为成品交付" : "节拍架构推演未完成，不可作为完整故事交付")
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
      const { initialDraft, initialText, revisionDraft, revisionHistory, executionReviews, executionReviewFailure, ...delivery } = details;
      return { content: [{ type: "text", text: JSON.stringify(delivery) }], details };
    },
  };
}
