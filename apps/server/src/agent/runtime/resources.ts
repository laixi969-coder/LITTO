import { t } from "@/lib/i18n";
import { readFile } from "@toonflow/file";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "@/agent/runtime/prompt";
import { loadAgentSkills } from "@/agent/skills";
import { loadProductionSkillContext } from "@/agent/skills/production";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isMemoryEnabled, readDocument } from "@/utils/personalization";
import conf from "@/utils/conf";
import { selectedModel } from "@/utils/modelSelection";
import { currentTenant } from "@/utils/tenant";

export async function createAgentResources(cwd: string, tools: ToolDefinition[], settings = SettingsManager.inMemory(), instructions = "", task = "") {
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
  const productionSkills = await loadProductionSkillContext(cwd, tools, task);
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
      productionSkills,
      `## 默认模型\n${JSON.stringify(Object.fromEntries((["text", "image", "imageEdit", "video", "audio"] as const).map(kind => [kind, selectedModel(kind) ?? null])))}\n${currentTenant()
        ? "此账号统一使用超级管理员设置的默认模型。直接查询并使用对应模型，不得让用户选择模型、接入 API 或修改默认值。尚未设置或模型不可用时告知联系超级管理员处理；selectModel 仅返回当前平台默认值，不向用户发起选择。"
        : "以上是本轮开始时的选择快照；本轮通过 requestProductionDecision(selectModel) 保存后，以工具返回及 listMediaModels 的最新选择为准，不因旧快照为 null 再次询问。图片、视频和音频分别选择一次，后续同类任务直接复用，包括逐张出图和逐镜图生视频。仅尚未选择、选择已不可用或用户明确要求更换时，在聊天中调用 selectModel；主动改选才传 reconsider:true。不可自行换平台或回退到其他模型；节点默认值和技能推荐不能覆盖用户选择。"}`,
      globalAgents.content.trim() ? `## 全局协作规范（AGENTS.md）\n${globalAgents.content}` : "",
      memory.content.trim() ? `## 全局长期记忆\n以下是跨对话保存的偏好与事实，使用前核对适用项目，以用户本轮要求为准。\n<global_memory>\n${memory.content}\n</global_memory>` : "",
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager: settings, resourceLoader };
}
