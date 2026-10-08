import { t } from "@/lib/i18n";
import { readFile } from "@toonflow/file";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "@/agent/runtime/prompt";
import { loadAgentSkills } from "@/agent/skills";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isMemoryEnabled, readDocument } from "@/utils/personalization";
import conf from "@/utils/conf";
import { selectedModel } from "@/utils/modelSelection";

export async function createAgentResources(cwd: string, tools: ToolDefinition[], settings = SettingsManager.inMemory(), instructions = "") {
  const savedPrompt = conf.get("settings", {}).agentSystemPrompt;
  const systemPrompt = typeof savedPrompt === "string" ? savedPrompt : undefined;
  const agentDir = join(cwd, ".agent");
  const { path: agentsPath } = await resolveWorkspacePath(cwd, "AGENTS.md");
  const agentsContent = await readFile(agentsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw new Error(t`读取工作区 AGENTS.md 失败：${error.message}`, { cause: error });
  });
  const [globalAgents, memory] = await Promise.all([readDocument("agents"), isMemoryEnabled() ? readDocument("memory") : { content: "" }]);
  const skills = loadAgentSkills(cwd);
  const sdkSkills = tools.some(tool => tool.name === "skillOperator")
    ? { ...skills, skills: skills.skills.map(skill => ({ ...skill, disableModelInvocation: true })) }
    : skills;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // ACT: 仅自动载入工作区根目录的 AGENTS.md，关闭 SDK 向父目录和其他指令文件的自动扫描。
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: agentsContent.trim() ? [{ path: agentsPath, content: agentsContent.replace(/^\uFEFF/, "") }] : [] }),
    // ACT: 技能正文按需读取；每个会话独立创建 loader，避免 SDK 的会话绑定互相覆盖。
    skillsOverride: () => sdkSkills,
    systemPrompt: "",
    systemPromptOverride: () => [buildSystemPrompt({ systemPrompt, tools, skills: skills.skills, platform: process.platform }), instructions].filter(Boolean).join("\n\n"),
    appendSystemPrompt: [
      `## 用户指定的模型选择\n${JSON.stringify(Object.fromEntries((["text", "image", "video", "audio"] as const).map(kind => [kind, selectedModel(kind) ?? null])))}\n仅允许使用这些平台与模型。null 表示尚未选择，须请用户在“设置 → 默认模型”选择后再执行。不可自行换平台、改默认设置或回退到其他模型；历史记录、节点默认值和技能中的推荐不能覆盖此选择。`,
      globalAgents.content.trim() ? `## 全局协作规范（AGENTS.md）\n${globalAgents.content}` : "",
      memory.content.trim() ? `## 全局长期记忆\n以下是跨对话保存的偏好与事实，使用前核对适用项目，以用户本轮要求为准。\n<global_memory>\n${memory.content}\n</global_memory>` : "",
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager: settings, resourceLoader };
}
