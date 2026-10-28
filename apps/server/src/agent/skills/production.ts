import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSkillContext, loadAgentSkills } from "@/agent/skills";
import { readStoryProject } from "@/utils/story";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { workspaceProject } from "@/utils/media/jobs";

export async function loadProductionSkillContext(cwd: string, tools: Pick<ToolDefinition, "name" | "parameters">[], task: string) {
  if (!tools.some(tool => ["readStoryProject", "productionSpec", "generateImage", "generateVideo", "generateShots"].includes(tool.name))) return "";
  const music = /\bmv\b|musicFilm|音乐视频|音乐短片|歌曲|演唱|唱跳/i.test(task);
  const advertising = /adfilm|brandFilm|商业广告|广告|品牌片|产品片|带货|\bugc\b|探店|餐厅推广/i.test(task);
  const story = /剧情|剧本|故事|短剧|中剧|电影|story/i.test(task);
  if (!music && !advertising && !story && !/视频|短片|分镜|人物|角色|场景|道具|生成|制作|继续|接着|这部作品|表演|布光|灯光|光线|妆造|服装|运镜|剪辑|调色|色板|材质|质感|配音|口型|声音|音效|混音|修复|穿帮|漂移|资产|三视图|四视图|打斗|交锋|群战|武打|旅拍|婚礼|旅行|vlog|videoPromptDirector/i.test(task)) return "";

  const operator = tools.find(tool => tool.name === "skillOperator");
  const actions = (operator?.parameters as { properties?: { action?: { enum?: unknown[] } } } | undefined)?.properties?.action?.enum;
  if (operator ? !actions?.includes("read") : !tools.some(tool => tool.name === "read")) {
    return "## 制作技能状态\n本轮技能正文读取未开启，未自动加载制作技能；不能声称已使用。";
  }

  // ACT: 明确的任务类型优先；简短续作沿用已保存简报，不根据附件正文猜作品类型。
  const project = await readStoryProject(cwd);
  const api = cloud(), tenant = currentTenant();
  const projectId = api && tenant ? workspaceProject(cwd, false) : undefined;
  const sequenceKinds = new Set(projectId ? api!.scoped(tenant!.workspaceId).list("sequences", { projectId }).map(item => item.kind).filter(Boolean) : []);
  const savedKind = project.revisions.find(item => item.id === project.approvedId)?.brief.kind
    ?? (project.version > 0 ? project.brief.kind : sequenceKinds.size === 1 ? [...sequenceKinds][0] : project.brief.kind);
  const kind = music ? "musicFilm" : advertising ? "adfilm" : story ? "story"
    : savedKind;
  const primary = kind === "musicFilm" ? "musicfilm" : ["adfilm", "brandFilm"].includes(kind) ? "adfilm" : "story";
  const primaryNames = [story && "story", advertising && "adfilm", music && "musicfilm"].filter((name): name is string => !!name);
  const names = ["workflow", ...(primaryNames.length ? primaryNames : [primary]), "cinema", "continuity", "videoPromptDirector"];
  if (/旅拍|婚礼|旅行|vlog/i.test(task)) names.push("travelWeddingDirector");
  if (/小清新|自然光|清透色彩/.test(task)) names.push("lightFreshDirector");
  if (/中式园林|月洞门|游廊/.test(task)) names.push("chineseGardenDirector");
  const available = loadAgentSkills(cwd).skills;
  const context = createSkillContext(cwd);
  const documents: string[] = [];
  const warnings: string[] = [];
  // ACT: 明确任务只预读相关模板；简短续作由各技能正文按当前镜头取用，避免全量知识挤占上下文。
  const referencePaths: Record<string, string[]> = {
    videoPromptDirector: ["references/cleanPortrait.md", "references/fiveBlockWriting.md"],
    cinema: ["references/movementDirection.md", "references/referenceQuality.md"],
    workflow: [],
    story: [],
    adfilm: ["references/creativeTranslation.md"],
    musicfilm: ["references/musicVideoDirection.md"],
    continuity: ["references/shotChecklist.md"],
    travelWeddingDirector: ["references/cameraActionMethods.md"],
  };
  if (/人物|角色|表演|对白|对话|演唱|唱跳|反应|演技/.test(task)) referencePaths.cinema.push("references/performanceDirection.md");
  if (/资产|角色卡|三视图|四视图|妆造|服装|道具|场景设计/.test(task)) referencePaths.workflow.push("references/assets.md");
  if (/布光|灯光|光线|调色|色板|材质|质感/.test(task)) referencePaths.workflow.push("references/methods/colorAndLight.md");
  if (/创意|大纲|编剧|写.*剧本|故事开发/.test(task)) referencePaths.story.push("references/core-methodology.md");
  if (/打斗|交锋|群战|武打/.test(task)) referencePaths.cinema.push("references/combatDesign.md");
  if (/声音|音效|混音|配音|口型|剪辑/.test(task)) referencePaths.cinema.push("references/coverage.md");
  if (/修复|穿帮|失败|漂移/.test(task)) referencePaths.videoPromptDirector.push("references/failureRepair.md");
  for (const name of names) {
    const skill = available.find(item => item.name === name);
    if (!skill) { warnings.push(`缺少技能 ${name}`); continue; }
    if (skill.disableModelInvocation && !task.includes(name)) {
      warnings.push(`${name} 已关闭自动调用，未加载`);
      continue;
    }
    for (const path of [undefined, ...(referencePaths[name] ?? [])]) {
      try {
        const document = await context.read({ name, path });
        documents.push(`### ${document.name} / ${document.scope} / ${document.path}\n${document.content}`);
      } catch (error) {
        warnings.push(`${name}/${path ?? "SKILL.md"} 读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return [
    "## 本轮自动读取的制作技能\n以下正文已按实际目录和工作区优先级读取，可直接应用；仅执行本轮阶段，用户要求与已确认项目设定优先。参考绑定和生成参数仍以工具实际回读为准。",
    ...documents,
    ...(warnings.length ? [`## 制作技能缺项\n${warnings.join("\n")}\n如实说明与当前任务有关的缺项，不假称已加载。`] : []),
  ].join("\n\n");
}
