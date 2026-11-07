import { z } from "zod";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { recordTextUsage } from "@/utils/usage";

export const musicDraftSchema = z.strictObject({
  title: z.string().min(1),
  sound: z.string().min(1),
  mechanics: z.union([z.array(z.string().min(1)), z.string().min(1)]).describe("关键人物能力边界及道具的唯一操作方式，未知的专业操作换成普通事件"),
  scenes: z.array(z.strictObject({
    actions: z.array(z.strictObject({
      action: z.string().min(1).describe("本段完整可视听正文，含触发、行动及回应；直接用于交付，不另写一份正文"),
      seconds: z.number().positive().describe("本段全部串行动作、移动、阅读与反应需要的画面秒数，不可缩短估计凑数"),
    })).min(1).max(12),
    hold: z.string().min(1).describe("余下时间停留在哪个已建立的画面或表演状态，不新增未计时的操作与位移"),
  })).min(1).max(30),
});

type MusicDraft = z.infer<typeof musicDraftSchema>;

export async function repairMusicScenes(runtime: ModelRuntime, model: Model<Api>, brief: string, draft: MusicDraft, slots: number[], issues: Awaited<ReturnType<typeof reviewMusicExecution>>["issues"], signal?: AbortSignal) {
  const targets = new Set(issues.map(issue => issue.scene - 1));
  for (const [index, scene] of draft.scenes.entries()) if (scene.actions.reduce((sum, action) => sum + Math.round(action.seconds * 1000), 0) > Math.round(slots[index]! * 1000)) targets.add(index);
  const indices = [...targets].sort((a, b) => a - b);
  const scenes = [...draft.scenes];
  const submissions: { scene: number; value: unknown }[] = [];
  // ACT: 每次只修一个场次；同一原稿快照上的独立场次最多并发2个，整稿复查跨场衔接。
  for (let start = 0; start < indices.length; start += 2) {
    const repaired = await Promise.allSettled(indices.slice(start, start + 2).map(async index => {
      const schema = musicDraftSchema.shape.scenes.element;
      const response = await runtime.completeSimple(model, {
        systemPrompt: "你只负责修正给定的一个MV场次，其他场次由程序原样保留。只调用submitMusicScene，actions写修好后的本场完整可视听段落及真实耗时，hold写已建立画面的停留。每段围绕一次主要行动及直接反应，不把多项串行动作藏在同一句；全场动作秒数必须低于budgetSeconds，给观众反应留时间。删去重复操作与不必要的往返，不靠改小秒数或删几个形容词凑数；必要的加工/打印/迁移过程可以用明确可辨的时间省略，只呈现开始和完成状态，不拍瞬间完成的全过程。进出场状态与相邻场次衔接，已有物件的交接必须可见。只用已有角色、设备和规则，不新增工具、权限或场外万能帮助。保留人物目标和关键选择，允许重构不成立的中间步骤，不能只在说明中声称问题已修好。sound是声轨约束：原曲唯一时删除可听铃声、对白、音效，演唱画面只接原曲，不另录人声。无时间码不指定某句必须在几秒唱完。",
        messages: [{ role: "user", content: JSON.stringify({ brief, sound: draft.sound, mechanics: draft.mechanics, scene: index + 1, budgetSeconds: slots[index], current: draft.scenes[index], before: draft.scenes[index - 1], after: draft.scenes[index + 1], issues: issues.filter(issue => issue.scene === index + 1) }), timestamp: Date.now() }],
        tools: [{ name: "submitMusicScene", description: "只提交当前场次的完整正文动作与停留，不能用理由代替正文", parameters: z.toJSONSchema(schema) }],
      }, { maxTokens: Math.min(model.maxTokens, 4096), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
        ...(model.id === "qwen3.8-flash" && model.api === "openai-completions" ? { onPayload: (payload: unknown) => ({ ...payload as object, tool_choice: { type: "function", function: { name: "submitMusicScene" } } }) } : {}),
      });
      recordTextUsage(response);
      signal?.throwIfAborted();
      const call = response.content.find(part => part.type === "toolCall" && part.name === "submitMusicScene");
      const value = call?.type === "toolCall" ? call.arguments : undefined;
      const parsed = schema.safeParse(value);
      if (!["stop", "toolUse"].includes(response.stopReason) || !parsed.success) throw new Error(`场${index + 1}修订未完整返回（${response.stopReason}${response.errorMessage ? `：${response.errorMessage}` : ""}）`, { cause: { scene: index + 1, value } });
      return { index, scene: parsed.data, value };
    }));
    const errors: string[] = [];
    for (const result of repaired) {
      if (result.status === "rejected") { errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason)); continue; }
      scenes[result.value.index] = result.value.scene;
      submissions.push({ scene: result.value.index + 1, value: result.value.value });
    }
    if (errors.length) throw new Error(errors.join("；"), { cause: { completedScenes: submissions } });
  }
  return { draft: { ...draft, scenes }, submissions };
}

export function musicCapacityIssues(draft: MusicDraft, slots: number[]) {
  const issues: string[] = [];
  if (draft.scenes.length !== slots.length) issues.push(`必须沿用计划的 ${slots.length} 场，当前 ${draft.scenes.length} 场`);
  for (const [index, scene] of draft.scenes.entries()) {
    const used = scene.actions.reduce((sum, action) => sum + Math.round(action.seconds * 1000), 0);
    const budget = Math.round((slots[index] ?? 0) * 1000);
    if (used > budget) issues.push(`场${index + 1}动作合计 ${used / 1000} 秒，预算 ${budget / 1000} 秒，超出 ${(used - budget) / 1000} 秒；删并事件或明确省略故事时间，不可等比例压缩耗时`);
  }
  return issues;
}

export function renderMusicDraft(draft: MusicDraft, slots: number[]) {
  const format = (value: number) => Number(value.toFixed(3));
  return [`# ${draft.title}`, draft.sound, "以下为暂定画面预算，非实测歌词卡点。", ...draft.scenes.map((scene, index) => {
    const used = scene.actions.reduce((sum, action) => sum + Math.round(action.seconds * 1000), 0) / 1000;
    const remaining = format((slots[index] ?? 0) - used);
    return [`## 场 ${index + 1}（约 ${slots[index]} 秒）`, ...scene.actions.map(action => action.action), ...(remaining > 0 ? [scene.hold] : []), `画面预算：${scene.actions.map((action, actionIndex) => `段${actionIndex + 1} ${action.seconds}秒`).join("；")}；留白 ${remaining} 秒。`].join("\n\n");
  }), `总预算：${format(slots.reduce((sum, seconds) => sum + seconds, 0))} 秒。`, "执行约束：", ...(Array.isArray(draft.mechanics) ? draft.mechanics : [draft.mechanics])].join("\n\n");
}

export async function reviewMusicExecution(runtime: ModelRuntime, model: Model<Api>, brief: string, draft: MusicDraft, slots: number[], signal?: AbortSignal) {
  const schema = z.strictObject({
    reviewedScenes: z.array(z.number().int().min(1).max(slots.length)),
    issues: z.array(z.strictObject({
      scene: z.number().int().min(1).max(slots.length),
      paragraph: z.number().int().nonnegative().describe("对应actions的段落编号，从1开始；0指本场留白或必要事件缺失"),
      problem: z.string().min(1),
      correction: z.string().min(1).describe("指出需删除、替换或补足的行为与依据，保留已成立的故事"),
    })).max(64),
  });
  const response = await runtime.completeSimple(model, {
    systemPrompt: "你是独立执行编辑，只根据用户要求与当前完整稿核对能否执行，不替作者辩护，不凭mechanics的自我保证放行，也不评个人审美。没有校正歌词时间码时，不得凭通常唱法推测某句需要多少秒，也不要求每场或开头必须有歌手。无额外可听对白不等于禁止未发声的说话动作或暗示通话；只有明确添加声音或关键因果依赖听不见的台词才报错。留白由程序从slots减去动作耗时得到，不能另行假设留白还需几秒而判合计超量，也不能建议把相同动作压秒凑数。逐场核对所有actions和hold：1.已有能力/伤病/行动限制与后来行为是否矛盾，角色不能凭象征物获得技能资格。2.道具操作机制、手脚占用、持有人、位置与前后状态是否一致；跨工种工具不能因外形相似就代替专业工序；蒸煮冷却等必要过程不能瞬间完成，未知的承重专业前提要求换成普通可理解的事件，不为故事编造操作依据。不能凭职业印象假定尺寸、重量、资格或制度；没有直接矛盾的普通行为不报错，虚构场所自设规则可成立但前后须一致。3.每段连续动作、走动、看字及反应能否在该seconds内发生并被看懂；标出把多项串行动作挤进短秒数的具体段，留白不能暗藏新操作。故事时间可以省略，但正文必须明确跳切及前后状态，不能让一句'片刻后'掩盖同一连续动作的超时。4.声音声明与实际发声、原曲连续性一致；声明安排的固定歌手演唱须在实际段落发生，独立演唱空间可以只有歌手一人，不把这种空场误判为无人而不能演唱。5.核对人数、关系证据、关键选择的前因和结尾兑现；缺失时指出具体场次，不要求套反派、悲剧或职业转变。只调用submitMusicExecutionReview，reviewedScenes列实际逐场审阅编号；issues只报有当前动作或用户要求依据的问题，paragraph填写具体段落编号。建议须优先删并、简化或使用已建立的资源，不要建议临时新增设备、规则、权限或象征物来修补，不能把审美解读当事实矛盾。没有实质问题返回空issues，不能把自评当成实拍证明。",
    messages: [{ role: "user", content: JSON.stringify({ brief, draft, slots }), timestamp: Date.now() }],
    tools: [{ name: "submitMusicExecutionReview", description: "逐场核对动作、容量和事实矛盾，不改写故事", parameters: z.toJSONSchema(schema) }],
  }, { maxTokens: Math.min(model.maxTokens, 6144),
    ...(model.id === "qwen3.8-flash" && model.api === "openai-completions" ? { onPayload: (payload: unknown) => ({ ...payload as object, tool_choice: { type: "function", function: { name: "submitMusicExecutionReview" } } }) } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
  recordTextUsage(response);
  signal?.throwIfAborted();
  const call = response.content.find(part => part.type === "toolCall" && part.name === "submitMusicExecutionReview");
  let value: unknown = call?.type === "toolCall" ? call.arguments : undefined;
  if (!value) {
    const text = response.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { value = JSON.parse(text); } catch { /* 非结构化判词不能当作审读通过。 */ }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...value };
    for (const key of ["reviewedScenes", "issues"]) {
      const field = Reflect.get(value as object, key);
      if (typeof field === "string") try { Reflect.set(value as object, key, JSON.parse(field)); } catch { /* 仍按原结构校验。 */ }
    }
  }
  const parsed = schema.safeParse(value);
  if (!["stop", "toolUse"].includes(response.stopReason) || !parsed.success) throw new Error(`执行审读未完整返回（${response.stopReason}${response.errorMessage ? `：${response.errorMessage}` : ""}）${parsed.success ? "" : parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")}`, { cause: { content: response.content, stopReason: response.stopReason } });
  if (new Set(parsed.data.reviewedScenes).size !== slots.length || parsed.data.issues.some(issue => issue.paragraph > draft.scenes[issue.scene - 1]!.actions.length)) throw new Error("执行审读未覆盖全部场次或段落引用无效");
  const verificationSchema = z.strictObject({
    checks: z.array(z.strictObject({
      issue: z.number().int().min(1).max(Math.max(1, parsed.data.issues.length)),
      verdict: z.enum(["supported", "unsupported", "unverified"]),
      scene: z.number().int().min(1).max(slots.length),
      paragraph: z.number().int().nonnegative(),
      basis: z.string().min(1),
    })),
  });
  let verification: z.infer<typeof verificationSchema>["checks"] = [];
  if (parsed.data.issues.length) {
    // 沿用故事审读的事实复核：仅有当前正文支持的错误退回修改，待排练/待对齐项保留为备注。
    const audit = await runtime.completeSimple(model, {
      systemPrompt: "你只核对执行编辑判词的事实依据，不重新评审美，不补写故事。brief、draft、slots是事实来源，claims是待验证的判词；逐条用submitMusicExecutionFacts提交checks。supported仅限明确的事实矛盾、用户要求缺失或明显不可能完成的连续工序；unsupported用于判词误读、额外假设及个人偏好；无法从文字确定的排练耗时、声音校准或歌词精确对齐用unverified并保留备注，不能假称已验收。每条给真实scene和paragraph（0为hold或该场缺失要求），程序回填依据原文。必须核对每个issue编号，不得跳过。特别核对：'仍可见'承接先前可见，不是矛盾；不同地点/时段的镜头转换与明确跳切允许省略常规移动，不要求把运输全拍出来；两人搬箱不证明一人不能搬，不得编造重量。空场独唱可只有歌手，独立演唱段允许服装与剧情不同；接听后继续保持通话不等于增加可听对白，未说的话不能当成实际发声；无时间码不能猜某句唱几秒。普通递接与拿起动作不因多个动词就必然超时，但多幅装箱、多人工序或设备瞬时完成要按实际动作核查。明确的新增可听铃声与原曲唯一音轨冲突、实际持物互斥、能力限制被违反仍须supported。建议中要新增设备/规则/权限不是正文已有事实，不能据此要求作者配合错误判词。",
      messages: [{ role: "user", content: JSON.stringify({ brief, draft, slots, claims: parsed.data.issues.map((issue, index) => ({ id: index + 1, ...issue })) }), timestamp: Date.now() }],
      tools: [{ name: "submitMusicExecutionFacts", description: "核对全部执行判词的原文依据，区分明确错误与待实拍确认项", parameters: z.toJSONSchema(verificationSchema) }],
    }, { maxTokens: Math.min(model.maxTokens, 6144), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
      ...(model.id === "qwen3.8-flash" && model.api === "openai-completions" ? { onPayload: (payload: unknown) => ({ ...payload as object, tool_choice: { type: "function", function: { name: "submitMusicExecutionFacts" } } }) } : {}),
    });
    recordTextUsage(audit);
    signal?.throwIfAborted();
    const auditCall = audit.content.find(part => part.type === "toolCall" && part.name === "submitMusicExecutionFacts");
    const checked = verificationSchema.safeParse(auditCall?.type === "toolCall" ? auditCall.arguments : undefined);
    if (!["stop", "toolUse"].includes(audit.stopReason) || !checked.success) throw new Error(`执行判词事实复核未完成（${audit.stopReason}${audit.errorMessage ? `：${audit.errorMessage}` : ""}）`);
    verification = checked.data.checks;
    if (verification.length !== parsed.data.issues.length || new Set(verification.map(item => item.issue)).size !== parsed.data.issues.length || verification.some(item => item.paragraph > draft.scenes[item.scene - 1]!.actions.length)) throw new Error("执行判词事实复核未完整覆盖或引用无效");
  }
  return {
    reviewedScenes: parsed.data.reviewedScenes,
    issues: parsed.data.issues.filter((_, index) => verification.find(check => check.issue === index + 1)?.verdict === "supported"),
    notes: parsed.data.issues.filter((_, index) => verification.find(check => check.issue === index + 1)?.verdict === "unverified"),
    verification: verification.map(check => ({ ...check, evidence: check.paragraph ? draft.scenes[check.scene - 1]!.actions[check.paragraph - 1]!.action : draft.scenes[check.scene - 1]!.hold })),
    initialIssues: parsed.data.issues,
  };
}
