import { readFile } from "@toonflow/file";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { run } from "@/agent/runtime";
import { createAgentConversation, getToolResultText, trackAgentEvent, updateSubAgent } from "@/agent/runtime/sessions";
import { addUsage, emptyUsage, type SubAgentResult } from "@/agent/runtime/subAgent";
import { createCanvasContext } from "@/agent/bridge/canvas";
import { createQuestionContext } from "@/agent/bridge/question";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { translateError, translateMessage } from "@/lib/i18n";

export async function runDelegatedAgent(options: {
  cwd: string; parentFile: string; name: string; task: string;
  providerId: string; modelId: string; thinkingLevel: "off" | "low" | "medium" | "high";
  canvas?: CanvasContext; signal?: AbortSignal; autonomousDecisions?: boolean; send: (event: AgentEvent) => void; onProgress?: (text: string, state?: Pick<SubAgentResult, "status" | "file">) => void;
}) {
  const { cwd, parentFile, name, task, providerId, modelId, thinkingLevel, canvas, signal, onProgress } = options;
  const child = await createAgentConversation(cwd, { parentFile, name, task, providerId, modelId, thinkingLevel });
  const agent = { file: child.file, parentFile, name, task, providerId, modelId, thinkingLevel, status: "running" as const };
  await updateSubAgent(cwd, parentFile, agent);
  // 先通知父界面创建子会话，再转发流式事件，避免首批进度因目标尚不存在而丢失。
  options.send({ type: "subAgent", agent });
  let summary = "";
  const pendingQuestions = new Set<string>();
  const progress = (text: string) => onProgress?.(text, { status: pendingQuestions.size ? "inputRequired" : "running", file: child.file });
  progress("准备执行");
  const send = (event: AgentEvent) => {
    trackAgentEvent(cwd, child.file, event);
    options.send({ type: "subAgentEvent", file: child.file, event });
    if (event.type === "question") {
      pendingQuestions.add(event.toolCallId);
      progress(`等待你确认：${event.title}\n${event.question}`);
    }
    if (event.type === "thinking" && !event.delta && !event.done) progress(`${summary}\n正在思考下一步`.trim());
    if (event.type === "text" && event.content?.trim() && event.done) {
      summary = event.content.slice(-600);
      progress(summary);
    }
    if (event.type === "tool") {
      if (event.tool.status !== "running") pendingQuestions.delete(event.tool.id);
      let progress: string | undefined;
      try { progress = JSON.parse(event.tool.result ?? "null")?.progress; } catch {}
      const operation = event.tool.args?.operation ?? event.tool.args?.name;
      onProgress?.(`${summary}\n${progress || `${event.tool.status === "running" ? "正在执行" : event.tool.status === "error" ? "执行失败" : "已返回"} ${event.tool.name}${operation ? ` · ${operation}` : ""}`}`.trim(), { status: pendingQuestions.size ? "inputRequired" : "running", file: child.file });
    }
    if (event.type === "error") onProgress?.(`执行出错：${event.message}`);
  };
  const controller = new AbortController();
  const childSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const bridge = canvas ? createCanvasContext(cwd, canvas, send) : undefined;
  const questions = createQuestionContext(cwd, send, () => controller.abort(), options.autonomousDecisions);
  const result: SubAgentResult = { name, file: child.file, status: "running", result: "准备执行" };
  try {
    await run({ prompt: task, cwd, sessionFile: child.file, providerId, modelId, thinkingLevel, canvas: bridge?.context, question: questions.context, signal: childSignal, onCancel: () => controller.abort() }, send);
    result.status = childSignal.aborted ? "cancelled" : "completed";
  } catch (error) {
    result.status = childSignal.aborted ? "cancelled" : (error as { code?: string })?.code === "AGENT_LENGTH" ? "limited" : "error";
    result.result = error instanceof Error ? translateError(error) : translateMessage("子任务执行失败");
    if (result.status !== "limited") await updateSubAgent(cwd, parentFile, { ...agent, status: result.status, result: result.result });
    send({ type: "error", message: result.result });
  } finally {
    bridge?.dispose();
    questions.dispose();
    send({ type: "done" });
  }
  const { path } = await resolveWorkspacePath(cwd, `.agent/sessions/${child.file}`);
  const entries = parseSessionEntries(await readFile(path, "utf8"));
  const usage = emptyUsage();
  for (const entry of entries) {
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") && entry.message.usage) addUsage(usage, entry.message.usage);
  }
  if (result.status === "completed" || result.status === "limited") {
    const reply = entries.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    result.result = reply?.type === "message" && reply.message.role === "assistant" ? getToolResultText(reply.message.content.filter(part => part.type === "text")) : "";
    if (reply?.type === "message" && reply.message.role === "assistant" && reply.message.stopReason === "length") result.status = "limited";
  }
  return { result, usage };
}
