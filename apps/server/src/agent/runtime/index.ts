import { z } from "zod";
import { recordTextUsage } from "@/utils/usage";
import { basename } from "node:path";
import { readFile, stat, unlink } from "@toonflow/file";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CanvasContext, QuestionContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent, AgentMention, AgentToolCall } from "@/agent/runtime/types";
import { agentMentionsSchema, mentionPrompt, snapshotMentions, validateMentionTokens } from "@/agent/runtime/mentions";
import { describeModelError, readAiReferences, referenceContent } from "@/utils/ai";
import { createAgentTools } from "@/agent/tools";
import { createAgentResources } from "@/agent/runtime/resources";
import { loadModelSkillContext, loadStoryWritingContext } from "@/agent/skills/production";
import { createAgentModel } from "@/agent/runtime/model";
import { installRequestBudget } from "@/agent/runtime/requestBudget";
import { createSubAgentTool } from "@/agent/tools/subAgent";
import { createMemoryTool } from "@/agent/tools/memory";
import { createReportTool } from "@/agent/tools/report";
import { runDelegatedAgent } from "@/agent/runtime/delegation";
import {
  agentAttachmentsSchema, getActiveAgentSession, getAgentStats, getParentSessionFile, getSubAgentInfo,
  getToolResultText, registerAgentSession, updateSubAgent,
  type ActiveAgentSession,
} from "@/agent/runtime/sessions";
import { isMemoryEnabled } from "@/utils/personalization";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { t } from "@/lib/i18n";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requiresStoryRuleValidation, type StoryLogic } from "@toonflow/tool-scene-list/storyLogic";
import { createStoryPlanning } from "@/utils/story/planning";
import { reviewStoryText } from "@/utils/story/review";
import { createStoryWriter } from "@/utils/story/writing";

type AgentOptions = {
  prompt: string;
  attachments?: z.infer<typeof agentAttachmentsSchema>;
  mentions?: AgentMention[];
  cwd: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  sessionFile?: string;
  resendFrom?: string;
  steeringOnly?: boolean;
  canvas?: CanvasContext;
  question?: QuestionContext;
  signal?: AbortSignal;
  onCancel?: () => void;
  instructions?: string;
  prepareTools?: (tools: ToolDefinition[]) => ToolDefinition[];
};

export async function run(
  {
    prompt,
    attachments = [],
    mentions = [],
    cwd,
    providerId,
    modelId,
    thinkingLevel = "off",
    sessionFile,
    resendFrom,
    steeringOnly,
    canvas,
    question,
    signal,
    onCancel,
    instructions = "",
    prepareTools,
  }: AgentOptions,
  send: (event: AgentEvent) => void
) {
  mentions = agentMentionsSchema.parse(mentions);
  validateMentionTokens(prompt, mentions);
  if (!prompt.trim() && !attachments.length && !mentions.length) throw Object.assign(new Error("请输入消息、提及或添加附件"), { status: 400 });
  const attachmentContents: (z.infer<typeof agentAttachmentsSchema>[number] & { content?: string })[] = [];
  for (const attachment of attachments) {
    const { path } = await resolveWorkspacePath(cwd, attachment.path);
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) {
      throw Object.assign(new Error("附件必须是工作区内非空且不超过 100 MB 的文件"), { status: 400 });
    }
    if (attachment.mimeType !== "text/plain") { attachmentContents.push(attachment); continue; }
    // ACT: 与文本引用保持同一上限，完整读取并保存到模型上下文，超限直接拒绝而不截断。
    if (info.size > 400000) throw Object.assign(new Error("文本附件最多支持 100000 个字符，请缩小内容后重试"), { status: 400 });
    const bytes = await readFile(path, { signal });
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw Object.assign(new Error("文本附件必须是 UTF-8 纯文本"), { status: 400 }); }
    if (bytes.length > 400000 || content.length > 100000) throw Object.assign(new Error("文本附件最多支持 100000 个字符，请缩小内容后重试"), { status: 400 });
    attachmentContents.push({ ...attachment, content });
  }
  if (resendFrom && !sessionFile) throw Object.assign(new Error("重发需要指定原对话"), { status: 400 });
  signal?.throwIfAborted();
  const { path: sessionsDir } = await resolveWorkspacePath(cwd, ".agent/sessions", true);
  const sessionPath = sessionFile ? (await resolveWorkspacePath(sessionsDir, sessionFile)).path : undefined;
  const active = sessionPath ? getActiveAgentSession(sessionPath) : undefined;
  if (active) {
    if (resendFrom) throw Object.assign(new Error("对话运行时不能重发历史消息"), { status: 409 });
    if (!active.session?.isStreaming) throw Object.assign(new Error("对话正在准备或结束回复，请稍后发送"), { status: 409 });
    if (attachments.length || mentions.length) throw Object.assign(new Error("请等当前回复结束后发送附件或提及"), { status: 400 });
    // ACT: steer 同步入队，不经过 prompt 的异步预处理，避免收尾竞态另起一轮执行。
    await active.session.steer(prompt.trim());
    send({ type: "accepted" });
    return;
  }
  if (steeringOnly) throw Object.assign(new Error("上一轮对话已结束，请重新发送消息"), { status: 409 });
  const { provider, runtime } = await createAgentModel(providerId, modelId, thinkingLevel);
  if (sessionPath) {
    const file = await stat(sessionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw Object.assign(new Error("会话不存在，请重新打开对话"), { status: 404 });
      throw error;
    });
    if (!file.isFile()) throw Object.assign(new Error("会话必须是普通文件"), { status: 400 });
  }
  // ACT: SDK 新会话先分配文件名、首条回复才落盘；只锁所属文件，允许不同对话同时运行。
  const newHistory = sessionPath ? undefined : SessionManager.create(cwd, sessionsDir);
  const release = lockWorkspaceFiles([sessionPath ?? newHistory!.getSessionFile()!]);
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const finished = Promise.withResolvers<void>();
  let unregister = () => {};
  let mentionFiles: string[] = [];
  let messageAccepted = false;
  try {
    const history = newHistory ?? SessionManager.open(sessionPath!, sessionsDir, cwd);
    const file = basename(history.getSessionFile()!);
    const parentFile = getParentSessionFile(history);
    const child = getSubAgentInfo(history)?.data;
    const liveTools = new Map<string, AgentToolCall>();
    // ACT: 只依据指令首行判定直出交稿；后续可能包含待审稿件或引用简报，不能当成本轮意图。
    let taskIntent = prompt.split("\n", 1)[0] ?? "";
    if (/^(?:继续|接着|重写|续写|改写|再写|完成)/.test(taskIntent) && !/分析|点评|审稿|评分|停止|暂停/.test(taskIntent)) {
      const previous = history.getBranch().flatMap(entry => {
        if (entry.type !== "message" || entry.message.role !== "user") return [];
        const content = entry.message.content;
        return [typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n")];
      }).findLast(content => /故事|剧本|短剧/.test(content.split("\n", 1)[0] ?? "") && /写|创作|生成|成稿/.test(content.split("\n", 1)[0] ?? ""));
      if (previous) taskIntent = `${previous.split("\n", 1)[0]}\n本轮要求：${taskIntent}`;
    }
    const storyTask = `${taskIntent}\n${prompt.split("\n").slice(1).join("\n")}`;
    const ruleTask = requiresStoryRuleValidation(storyTask);
    const directStoryTask = /故事|剧本|短剧/.test(taskIntent) && /写|创作|生成|成稿/.test(taskIntent) && !/工作台|场次表|分镜|保存|审稿|点评|评分|分析|只改|局部/.test(taskIntent);
    const enforceStoryDelivery = directStoryTask || (ruleTask || /故事/.test(taskIntent)) && /写一篇|写一个|创作|成稿/.test(taskIntent) && /(?:只|仅)(?:交|要|输出)[^。；\n]*(?:正文|故事|文字)/.test(taskIntent) && !/(?:只|仅)(?:审|评|分析)/.test(taskIntent);
    const storyTextEvents = new Map<string, { blockId: string; content: string }>();
    const publish = send;
    send = event => {
      // ACT: 纯文字直出先保留草稿事件，只有同一稿完成数量、证据和独立审读才交付；历史草稿仍保留。
      if (enforceStoryDelivery && event.type === "text") {
        if (event.done) storyTextEvents.set(event.blockId, { blockId: event.blockId, content: event.content ?? "" });
        return;
      }
      if (event.type === "tool") {
        const tool = { ...liveTools.get(event.tool.id), ...event.tool };
        if (tool.status !== "running") delete tool.question;
        liveTools.set(tool.id, tool);
      }
      publish(event);
    };
    const active: ActiveAgentSession = {
      history, send, tools: liveTools,
      entryOffset: history.getEntries().length,
      abort: () => { controller.abort(); onCancel?.(); return finished.promise; },
    };
    unregister = registerAgentSession(history.getSessionFile()!, active);
    let tools = await createAgentTools(cwd, canvas, question, signal);
    if (isMemoryEnabled()) {
      const memoryTool = createMemoryTool();
      if (tools.some(tool => tool.name === memoryTool.name)) throw new Error("工具名称 memory 已被内置全局记忆工具占用");
      tools.push(memoryTool);
    }
    if (parentFile && child) {
      if (tools.some(tool => tool.name === "report")) throw new Error("工具名称 report 已被内置上报工具占用");
      tools.push(createReportTool(cwd, parentFile, file, child.name, send));
    }
    tools.push(await createSubAgentTool({
      cwd, tools, canvas, modelRuntime: runtime, model: runtime.getModel(providerId, modelId), thinkingLevel,
      runTask: (name, task, taskSignal, onProgress) => runDelegatedAgent({
        cwd, parentFile: file, name, task, providerId, modelId, thinkingLevel, canvas, signal: taskSignal, autonomousDecisions: question?.autonomousDecisions, send, onProgress,
      }),
    }));
    if (/故事|剧本|剧情|短剧|爽剧|悬疑剧|剧集|story/i.test(taskIntent)) tools.push(createStoryWriter(providerId, modelId, toolSignal => loadStoryWritingContext(cwd, tools, taskIntent, toolSignal)));
    if (prepareTools) tools = prepareTools(tools);
    const planning = enforceStoryDelivery ? createStoryPlanning(storyTask, providerId, modelId) : undefined;
    const storyReviews = new Map<string, Awaited<ReturnType<typeof reviewStoryText>>>();
    const storyReviewClaims = new Map<string, string>();
    const storyLengths = new Map<string, { countMode?: string; minCharacters?: number; maxCharacters?: number }>();
    if (planning) tools.push({ ...planning.tool, async execute(...args) {
      storyReviews.clear();
      storyReviewClaims.clear();
      storyLengths.clear();
      return planning.tool.execute(...args);
    } });
    let reviewAttempts = 0;
    // ACT: 同轮最多审五次，为规则、决定与关系修改留出余量，同时限制付费自评；正文和规则记录均相同时复用结果。
    if (ruleTask || planning) tools = tools.map(tool => tool.name !== "prepareStoryText" ? tool : {
      ...tool,
      async execute(id, params, ...rest) {
        if (planning && !planning.current()) {
          const details = { ready: false, message: "尚未通过结构比选；先调用compareStoryPlans，不能跳过或用自评分代替" };
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        }
        const result = await tool.execute(id, { ...params as Record<string, unknown>, ...(ruleTask ? { requireRuleValidation: true } : {}) }, ...rest);
        const prepared = result.details as { text: string; ready: boolean; countMode?: string; minCharacters?: number; maxCharacters?: number };
        if (!prepared.ready) return result;
        const ruleClaims = (params as { logic?: StoryLogic }).logic?.rules ?? [];
        const claimsKey = JSON.stringify(ruleClaims);
        if (storyReviewClaims.get(prepared.text) !== claimsKey) {
          storyReviews.delete(prepared.text);
          storyLengths.delete(prepared.text);
        }
        let semanticReview = storyReviews.get(prepared.text);
        if (!semanticReview) {
          if (reviewAttempts >= 5) semanticReview = { verdict: "unverified", issues: [], message: "本轮五次审读仍未通过，请如实交代未完成项，不再自报通过或无限重试" };
          else {
            reviewAttempts++;
            try {
              // ACT: 审读不继承作者的深度思考配置，避免长推理耗尽时限；同稿未核实时允许在预算内重试。
              const reviewer = await createAgentModel(providerId, modelId, "off");
              semanticReview = await reviewStoryText(reviewer.runtime, reviewer.runtime.getModel(providerId, modelId)!, planning ? storyTask : prompt, prepared.text, ruleClaims, signal!);
            } catch (error) {
              if (signal?.aborted) throw error;
              semanticReview = { verdict: "unverified", issues: [], message: "独立审读请求失败或超过三分钟，不能宣称通过" };
            }
          }
          if (semanticReview.verdict !== "unverified") {
            storyReviews.set(prepared.text, semanticReview);
            storyReviewClaims.set(prepared.text, claimsKey);
          }
        }
        if (planning && "revision" in semanticReview && semanticReview.revision === "structure") {
          planning.reject();
          storyReviews.clear();
          storyReviewClaims.clear();
          storyLengths.clear();
        }
        if (semanticReview.verdict === "pass") storyLengths.set(prepared.text, prepared);
        const details = { ...prepared, semanticReview, ready: semanticReview.verdict === "pass" };
        return { ...result, details, content: [{ type: "text", text: JSON.stringify(details) }] };
      },
    });
    // ACT: 在最终工具权限确定后补回本轮新模型规则；切换成功不等于旧系统上下文自动刷新。
    tools = tools.map(tool => tool.name !== "requestProductionDecision" ? tool : {
      ...tool,
      async execute(...args) {
        const result = await tool.execute(...args);
        const input = args[1] as { operation?: string; data?: string | { kind?: string } };
        if (input.operation !== "selectModel" || !(result.details as { applied?: boolean } | undefined)?.applied) return result;
        const data = typeof input.data === "string" ? JSON.parse(input.data) : input.data;
        if (data?.kind !== "video") return result;
        const rules = await loadModelSkillContext(cwd, tools, prompt);
        return { ...result, content: [...result.content, { type: "text" as const, text: rules }] };
      },
    });
    const resources = await createAgentResources(cwd, tools, undefined, child
      ? `## 子 Agent 职责\n你正在执行委派任务：${JSON.stringify({ name: child.name, task: child.task })}。遵守当前工作区规则与授权，用户可以进入此子会话补充要求。重要进展与最终结论使用 report 上报父 Agent。`
      : instructions, prompt);
    const resendEntry = resendFrom ? history.getBranch().find((item) => item.id === resendFrom) : undefined;
    if (resendFrom && (resendEntry?.type !== "message" || resendEntry.message.role !== "user")) {
      throw Object.assign(new Error("重发消息不在当前对话中，请重新打开对话"), { status: 400 });
    }
    const savedMentions = resendFrom ? history.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "toonflowUserMessage" && (entry.data as { messageId?: string })?.messageId === resendFrom) : undefined;
    const previousMentions = savedMentions?.type === "custom" ? agentMentionsSchema.safeParse((savedMentions.data as { mentions?: unknown })?.mentions) : undefined;
    const snapshots = await snapshotMentions(cwd, mentions, previousMentions?.success ? previousMentions.data : [], signal);
    mentionFiles = snapshots.created;
    mentions = agentMentionsSchema.parse(snapshots.mentions);
    const previous = history.buildSessionContext();
    if (previous.model && (previous.model.provider !== providerId || previous.model.modelId !== modelId))
      history.appendModelChange(providerId, modelId);
    if (previous.messages.length && previous.thinkingLevel !== thinkingLevel) history.appendThinkingLevelChange(thinkingLevel);
    const { session } = await createAgentSession({
      cwd,
      ...resources,
      modelRuntime: runtime,
      model: runtime.getModel(providerId, modelId),
      thinkingLevel,
      sessionManager: history,
      tools: tools.map((tool) => tool.name),
      customTools: tools,
    });
    active.session = session;
    installRequestBudget(session);

    const streamFunction = session.agent.streamFunction;
    session.agent.streamFunction = async (...args) => {
      const compacting = session.isCompacting;
      const stream = await streamFunction(...args);
      // ACT: 摘要落盘前拒绝空正文，压缩、重试和普通回复仍由 SDK 处理。
      if (compacting) {
        const response = await stream.result();
        if (response.stopReason === "stop" && !response.content.some(part => part.type === "text" && part.text.trim())) {
          throw new Error("模型返回了空摘要，已保留原上下文");
        }
      }
      return stream;
    };

    // ACT: 提及图片和视频复用媒体协议转换，会话只保存工作区快照路径。
    const mediaContents = new Map<string, ReturnType<typeof readAiReferences>>();
    const onPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, requestModel) => {
      const body = (await onPayload?.(payload, requestModel) ?? payload) as Record<string, unknown>;
      sendUserMessage();
      const mediaMessages = new Map<string, { id: string; references: Parameters<typeof readAiReferences>[1] }>();
      for (const entry of history.getBranch()) {
        if (entry.type !== "custom" || !["toonflowAttachments", "toonflowUserMessage"].includes(entry.customType)) continue;
        const parsed = z.object({ messageId: z.string(), attachments: agentAttachmentsSchema, mentions: agentMentionsSchema.optional() }).safeParse(entry.data);
        if (!parsed.success) continue;
        const references: Parameters<typeof readAiReferences>[1] = [
          ...parsed.data.attachments.filter(item => item.mimeType.startsWith("video/")).map(item => ({ dataType: "VIDEO" as const, value: { url: item.path, mimeType: item.mimeType } })),
          ...(parsed.data.mentions ?? []).filter(item => ["IMAGE", "MASK", "VIDEO"].includes(item.dataType)).map(item => ({
            dataType: item.dataType === "VIDEO" ? "VIDEO" as const : "IMAGE" as const, value: item.value as { url: string; mimeType: string },
          })),
        ];
        const message = history.getEntry(parsed.data.messageId);
        if (!references.length || message?.type !== "message" || message.message.role !== "user") continue;
        const content = message.message.content;
        for (const part of typeof content === "string" ? [{ type: "text", text: content }] : content) {
          if (part.type === "text") mediaMessages.set(part.text, { id: entry.id, references });
        }
      }
      if (!mediaMessages.size) return body;
      const field = provider.protocol === "openai-responses" ? "input" : "messages";
      const textType = provider.protocol === "openai-responses" ? "input_text" : "text";
      const messages = body[field] as { role?: string; content?: string | { type: string; text?: string }[] }[];
      return { ...body, [field]: await Promise.all(messages.map(async message => {
        if (message.role !== "user") return message;
        const parts = typeof message.content === "string" ? [{ type: textType, text: message.content }] : message.content;
        if (!parts?.some(part => part.type === textType && mediaMessages.has(part.text ?? ""))) return message;
        const content = await Promise.all(parts.map(async part => {
          const source = part.type === textType && part.text ? mediaMessages.get(part.text) : undefined;
          if (!source) return [part];
          if (!mediaContents.has(source.id)) mediaContents.set(source.id, readAiReferences(cwd, source.references, signal));
          return referenceContent(provider.protocol, part.text!, await mediaContents.get(source.id)!);
        }));
        return { ...message, content: content.flat() };
      })) };
    };

    const resumeLeafId = history.getLeafId();
    let userMessageId = history.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    function sendUserMessage() {
      const branch = history.getBranch();
      const offset = branch.findIndex(item => item.id === userMessageId);
      for (const entry of branch.slice(offset + 1).filter(item => item.type === "message" && item.message.role === "user")) {
        userMessageId = entry.id;
        const firstMessage = !messageAccepted;
        messageAccepted = true;
        if (firstMessage && (attachments.length || mentions.length || prompt.trimStart().startsWith("/skill:"))) {
          history.appendCustomEntry("toonflowUserMessage", { messageId: entry.id, content: prompt.trim(), attachments, mentions });
          if (!history.getSessionName() && history.getBranch().filter((item) => item.type === "message" && item.message.role === "user").length === 1) {
            history.appendSessionInfo((prompt.trim().replace(/\{\{mention:([^{}]+)\}\}/g, (text, id: string) => {
              const mention = mentions.find(item => item.id === id);
              return mention ? `@${mention.label}` : text;
            }) || attachments[0]?.name || mentions[0]?.label || "新对话").slice(0, 60));
          }
        }
        const saved = history.getBranch().findLast(item => item.type === "custom" && item.customType === "toonflowUserMessage" && (item.data as { messageId?: string })?.messageId === entry.id);
        const original = saved?.type === "custom" ? saved.data as { content: string; attachments: z.infer<typeof agentAttachmentsSchema>; mentions?: AgentMention[] } : undefined;
        const content = entry.type === "message" && entry.message.role === "user" ? entry.message.content : "";
        send({ type: "userMessage", id: entry.id, content: original?.content ?? (typeof content === "string" ? content : getToolResultText(content)), attachments: original?.attachments, mentions: original?.mentions });
      }
    }
    let firstTokenAt: number | undefined;
    let modelError: string | undefined;
    let limited = false;
    let compactionError: string | undefined;
    let messageIndex = 0;
    const toolBlocks = new Map<string, string>();
    const timing = { outputTokens: 0, decodeMs: 0 };
    session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        send({ type: "compaction", active: event.type === "compaction_start" });
        if (event.type === "compaction_end" && event.errorMessage) {
          compactionError = t`上下文压缩失败：${event.errorMessage}`;
        }
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        sendUserMessage();
        messageIndex++;
        firstTokenAt = undefined;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
          if (update.delta) firstTokenAt ??= performance.now();
        }
        if ("contentIndex" in update) {
          const blockId = `${messageIndex}:${update.contentIndex}`;
          if (update.type === "text_start" || update.type === "thinking_start") {
            const part = update.partial.content[update.contentIndex];
            send({
              type: update.type === "text_start" ? "text" : "thinking",
              blockId,
              content: part?.type === "thinking" && part.redacted ? part.thinking : "",
            });
          }
          if (update.type === "text_delta" || update.type === "thinking_delta") {
            send({ type: update.type === "text_delta" ? "text" : "thinking", blockId, delta: update.delta });
          }
          if (update.type === "text_end" || update.type === "thinking_end") {
            send({ type: update.type === "text_end" ? "text" : "thinking", blockId, content: update.content, done: true });
          }
          if (update.type === "toolcall_start" || update.type === "toolcall_end") {
            const part = update.type === "toolcall_end" ? update.toolCall : update.partial.content[update.contentIndex];
            if (part?.type === "toolCall") {
              toolBlocks.set(part.id, blockId);
              send({ type: "tool", blockId, tool: { id: part.id, name: part.name, args: part.arguments, status: "running" } });
            }
          }
        }
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        const tool = { id: event.toolCallId, name: event.toolName };
        send({
          type: "tool",
          blockId: toolBlocks.get(event.toolCallId) ?? event.toolCallId,
          tool:
            event.type === "tool_execution_start"
              ? { ...tool, args: event.args, status: "running" }
              : { ...tool, status: event.isError ? "error" : "success", result: getToolResultText(event.result.content) },
        });
      }
      if (event.type === "tool_execution_update") {
        send({
          type: "tool",
          blockId: toolBlocks.get(event.toolCallId) ?? event.toolCallId,
          tool: { id: event.toolCallId, name: event.toolName, status: "running", result: getToolResultText(event.partialResult.content) },
        });
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        event.message.content.forEach((part, index) => {
          const blockId = `${messageIndex}:${index}`;
          if (part.type === "text" || part.type === "thinking") {
            send({ type: part.type, blockId, content: part.type === "text" ? part.text : part.thinking, done: true });
          } else if (part.type === "toolCall") {
            toolBlocks.set(part.id, blockId);
            send({ type: "tool", blockId, tool: { id: part.id, name: part.name, args: part.arguments, status: "running" } });
          }
        });
        recordTextUsage(event.message);
        if (firstTokenAt !== undefined && event.message.usage.output > 0) {
          const decodeMs = performance.now() - firstTokenAt;
          if (decodeMs > 0) {
            timing.outputTokens += event.message.usage.output;
            timing.decodeMs += decodeMs;
          }
        }
        firstTokenAt = undefined;
        modelError = event.message.stopReason === "error" ? describeModelError(event.message.errorMessage)
          : event.message.stopReason === "length" ? "模型回复因长度限制被截断，未能完整生成回答。" : undefined;
        limited = event.message.stopReason === "length";
      }
    });
    const abort = () => {
      void session.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    let failure: unknown;
    try {
      signal?.throwIfAborted();
      if (parentFile && child) {
        const agent = { ...child, file, parentFile, providerId, modelId, thinkingLevel, status: "running" as const, result: undefined };
        await updateSubAgent(cwd, parentFile, agent);
        send({ type: "subAgent", agent });
      }
      if (resendEntry) {
        // ACT: 只截断 SDK 当前分支；旧记录留在 JSONL 中，不再进入当前上下文。
        if (resendEntry.parentId) history.branch(resendEntry.parentId);
        else history.resetLeaf();
        history.appendModelChange(providerId, modelId);
        history.appendThinkingLevelChange(thinkingLevel);
        session.agent.state.messages = history.buildSessionContext().messages;
        userMessageId = history.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id;
      }
      send({ type: "session", file: basename(history.getSessionFile()!) });
      // ACT: 文本附件完整内容进入模型上下文，界面仍保存工作区引用；视频在请求时加载，图片由 read 按需读取。
      const content = attachments.length
        ? `${mentionPrompt(prompt, mentions)}\n\n附件已保存到工作区，path 为相对路径，可用于节点选择素材。音频仅提供文件引用，需用可用的 ffprobe / ffmpeg 读取或处理，不代表已经听过音频。以下 JSON 包含文件信息，文本附件的 content 为完整正文：\n${JSON.stringify(
            attachmentContents
          )}`.trim()
        : mentionPrompt(prompt, mentions);
      // SDK 仅以空格分隔技能名；兼容换行输入与追加的附件说明。
      await session.prompt(content.replace(/^(\/skill:\S+)\s+/, "$1 "));
      if (compactionError) throw new Error(compactionError);
      if (modelError) throw Object.assign(new Error(modelError), limited ? { code: "AGENT_LENGTH" } : {});
      if (enforceStoryDelivery) for (let attempt = 0; attempt < 2; attempt++) {
        const blocks = [...storyTextEvents.values()];
        const messageId = blocks.at(-1)?.blockId.split(":")[0];
        const finalBlocks = blocks.filter(block => block.blockId.split(":")[0] === messageId);
        const text = finalBlocks.map(block => block.content).join("\n\n").trim();
        const lines = text.split(/\r?\n/), heading = lines[0] ?? "";
        const bodies = [text];
        if (lines[1]?.trim() === "" && heading.length <= 80 && (/^(?:#|\*\*|《)/.test(heading) || !/[。！？]/.test(heading))) bodies.push(lines.slice(2).join("\n"));
        const sameText = (value: string) => value.replace(/\s/g, "");
        const approved = [...storyReviews].some(([draft, review]) => {
          if (review.verdict !== "pass") return false;
          const draftLines = draft.split(/\r?\n/);
          const draftHeading = draftLines[0] ?? "";
          const normalizeHeading = (value: string) => value.replace(/^\s*(?:#+\s*|\*\*)?《?/, "").replace(/》?(?:\*\*)?\s*$/, "").trim();
          const matchingTitle = !draftLines[1]?.trim() && !lines[1]?.trim() && draftHeading.length <= 80 && heading.length <= 80
            && /^(?:《|#|\*\*)/.test(heading) && !/[。！？]/.test(draftHeading)
            && normalizeHeading(draftHeading) === normalizeHeading(heading);
          const draftBody = matchingTitle ? draftLines.slice(2).join("\n") : draft;
          const finalBody = matchingTitle ? lines.slice(2).join("\n") : undefined;
          const matched = matchingTitle ? sameText(finalBody!) === sameText(draftBody) : bodies.some(body => sameText(body) === sameText(draft));
          const length = storyLengths.get(draft);
          const count = length?.countMode === "characters" ? [...draftBody.replace(/\s/g, "")].length : (draftBody.match(/[\p{Letter}\p{Number}]/gu) ?? []).length;
          return matched && count >= (length?.minCharacters ?? 0) && count <= (length?.maxCharacters ?? Infinity);
        });
        if (approved) {
          for (const block of finalBlocks) publish({ type: "text", ...block, done: true });
          break;
        }
        if (attempt) throw new Error("本轮故事交稿未通过审读，或交稿与已核对正文不一致；草稿及审读记录已保留，未作为合格正文交付");
        storyTextEvents.clear();
        await session.sendCustomMessage({ customType: "storyDeliveryCheck", content: "交付校验未通过：最终正文必须与本轮prepareStoryText返回ready:true的text一致（允许单独标题和换行排版）。先完成数量、规则证据与独立审读，再原样交付通过稿。不要另写未经核对的句子；没有通过时不得宣称完成。", display: false }, { triggerTurn: true });
        if (compactionError) throw new Error(compactionError);
        if (modelError) throw Object.assign(new Error(modelError), limited ? { code: "AGENT_LENGTH" } : {});
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      try {
        // ACT: 用户停止时 SDK 队列可能尚未投递；保留已确认接收的文字，重开子会话也不会丢失。
        const pending = session.clearQueue();
        for (const content of [...pending.steering, ...pending.followUp]) {
          history.appendMessage({ role: "user", content, timestamp: Date.now() });
          sendUserMessage();
        }
        sendUserMessage();
        if (resendEntry && !messageAccepted && resumeLeafId) {
          history.branch(resumeLeafId);
          // 分支指针本身不落盘，追加当前模型配置以保存恢复位置。
          history.appendModelChange(providerId, modelId);
          session.agent.state.messages = history.buildSessionContext().messages;
        }
        // ACT: 只记录有首个内容增量的生成耗时，旧历史和未计时输出不参与速度统计。
        if (timing.decodeMs > 0) history.appendCustomEntry("toonflowTiming", timing);
        send({ type: "stats", stats: getAgentStats(history), contextUsage: session.getContextUsage() });
        if (parentFile && child) {
          const entry = history.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
          const last = entry?.type === "message" ? entry.message : undefined;
          const result = failure instanceof Error && !limited ? failure.message : last?.role === "assistant" ? getToolResultText(last.content.filter(part => part.type === "text")) : "";
          const status = signal?.aborted ? "cancelled" : limited ? "limited" : failure ? "error" : "completed";
          const agent = { ...child, file, parentFile, providerId, modelId, thinkingLevel, status, result } as const;
          await updateSubAgent(cwd, parentFile, agent);
          send({ type: "subAgent", agent });
        }
      } finally {
        session.dispose();
      }
    }
  } finally {
    unregister();
    release();
    finished.resolve();
    if (!messageAccepted) await Promise.all(mentionFiles.map(path => unlink(path)));
  }
}

export * from "@/agent/runtime/sessions";
export { agentMentionsSchema } from "@/agent/runtime/mentions";
