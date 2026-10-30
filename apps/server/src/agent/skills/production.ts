import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSkillContext, loadAgentSkills } from "@/agent/skills";
import { readStoryProject } from "@/utils/story";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { workspaceProject } from "@/utils/media/jobs";
import { isSeedance2Model, selectedModel } from "@/utils/modelSelection";
import { getMediaProvider } from "@/utils/media/provider";

type SkillTools = Pick<ToolDefinition, "name" | "parameters">[];

function canReadSkills(tools: SkillTools) {
  const operator = tools.find(tool => tool.name === "skillOperator");
  const actions = (operator?.parameters as { properties?: { action?: { enum?: unknown[] } } } | undefined)?.properties?.action?.enum;
  return operator ? !!actions?.includes("read") : tools.some(tool => tool.name === "read");
}

function explicitlyNamesSkill(task: string, name: string) {
  return task.split(/[^a-zA-Z0-9_-]+/).includes(name);
}

async function selectedVideoSkillModel() {
  const model = selectedModel("video");
  if (!model) return undefined;
  if (!/^ep[-_]/i.test(model.modelId)) return { ...model, seedance: isSeedance2Model(model.modelId) };
  // ACT: 火山接入点隐藏型号，只用当前供应商中同一 ID 的已配置名称判断；不能从任务或其他连接猜测。
  try {
    const provider = await getMediaProvider(model.providerId);
    const configured = provider.models.find(item => item.type === "video" && item.id === model.modelId);
    return { ...model, seedance: isSeedance2Model(configured?.label ?? "") };
  } catch {
    return { ...model, seedance: false };
  }
}

export async function loadModelSkillContext(cwd: string, tools: SkillTools, task = "") {
  const model = await selectedVideoSkillModel();
  if (!model) return "当前尚未选定视频模型，不启用任何模型专项格式；不能把技能默认值当作模型选择。";
  const status = `当前视频模型：${model.providerId} / ${model.modelId}。以此选择替代本轮旧模型快照；其他模型的专项格式与能力假设停止适用，保留创作规格并按当前真实模式重新编译。`;
  if (!model.seedance) return `${status}\n当前未匹配到型号专项，使用通用摄影、动作与连续性方法，能力以 listMediaModels 和实际节点回读为准，不借用 Seedance/Higgsfield 等其他模式的参数。接入点型号不明时先核对配置，不能假称已加载。`;
  if (!canReadSkills(tools)) return `${status}\n技能正文读取未开启，未加载 Seedance 专项规则，不能声称已使用。`;
  const skill = loadAgentSkills(cwd).skills.find(item => item.name === "workflow");
  if (!skill || skill.disableModelInvocation && !explicitlyNamesSkill(task, skill.name)) return `${status}\nworkflow 缺失或已关闭自动调用，未加载 Seedance 专项规则。`;
  try {
    const context = createSkillContext(cwd);
    const documents = await Promise.all([undefined, "references/seedanceDirector.md"].map(path => context.read({ name: "workflow", path })));
    return [status, ...documents.map(document => `### ${document.name} / ${document.scope} / ${document.path}\n${document.content}`)].join("\n\n");
  } catch (error) {
    return `${status}\nSeedance 专项规则读取失败：${error instanceof Error ? error.message : String(error)}。模型选择已保存，不因技能缺项重复选择或假称已加载。`;
  }
}

export async function loadProductionSkillContext(cwd: string, tools: SkillTools, task: string) {
  const available = loadAgentSkills(cwd).skills;
  const explicitNames = available.filter(skill => explicitlyNamesSkill(task, skill.name)).map(skill => skill.name);
  if (!explicitNames.length && !tools.some(tool => ["readStoryProject", "productionSpec", "generateImage", "generateVideo", "generateShots", "nodeTools", "getCanvas"].includes(tool.name))) return "";
  const advertising = /adfilm|brandFilm|商业广告|广告|品牌片|产品片|带货|\bugc\b|探店|餐厅推广/i.test(task);
  const story = /剧情|剧本|故事|短剧|中剧|电影|story/i.test(task);
  const music = /\bmv\b|musicFilm|音乐视频|音乐短片|音乐电影/i.test(task) || !advertising && !story && /歌曲|演唱|唱跳/.test(task);
  const topics = [
    { match: /人物|角色|表演|对白|对话|演唱|唱跳|反应|演技|performance|dialogue/i, name: "cinema", paths: ["references/performanceDirection.md", "references/creativePreparation.md"] },
    { match: /资产|角色卡|三视图|四视图|妆造|服装|道具|场景设计/, name: "workflow", paths: ["references/assets.md", "references/methods/visualDesign.md"] },
    { match: /妆造|服装|换装|妆发|衣装/, name: "workflow", paths: ["references/methods/characterStyling.md"] },
    { match: /布光|灯光|光线|调色|滤镜|色板|材质|质感|lighting|grading|filter/i, name: "workflow", paths: ["references/methods/colorAndLight.md"] },
    { match: /真人|写实|质感|皮肤|塑料|手机|realism|photoreal|live.action/i, name: "continuity", paths: ["references/realism.md"] },
    { match: /创意|大纲|编剧|写.*剧本|故事开发/, name: "story", paths: ["references/core-methodology.md"] },
    { match: /镜头|分镜|运镜|摄影|构图|机位|俯视|剖面|全景|白模|camera|cinematography/i, name: "cinema", paths: ["references/shotLanguage.md", "references/masterShots.md"] },
    { match: /九宫格|九格|9\s*[宫宮格]|十六宫格|16\s*[宫宮格]|多格分镜|宫格分镜|storyboard\s*grid/i, name: "cinema", paths: ["references/storyboardGrid.md"] },
    { match: /剖面|全景|白模|空间设计|群像设计/, name: "workflow", paths: ["references/methods/visualDesign.md"] },
    { match: /打斗|交锋|群战|武打|武术|武侠|仙侠|搏击|格斗|追逐|武器|兵器|刀剑|剑斗|法术|combat|martial|fight|wuxia/i, name: "cinema", paths: ["references/combatDesign.md", "references/actionChoreography.md", "references/manjuActionDirection.md", "references/creativePreparation.md"] },
    { match: /声音|音效|混音|配音|口型|剪辑|对白|对话|dialogue/i, name: "cinema", paths: ["references/coverage.md"] },
    { match: /分段|接戏|续接|连贯|连续|长镜头|continuity/i, name: "videoPromptDirector", paths: ["references/segmentPlanning.md", "references/wardrobeContinuity.md"] },
    { match: /修复|穿帮|失败|漂移/, name: "videoPromptDirector", paths: ["references/failureRepair.md"] },
  ];
  // ACT: 明确的任务类型优先；简短续作沿用已保存简报，不根据附件正文猜作品类型。
  const project = await readStoryProject(cwd);
  const api = cloud(), tenant = currentTenant();
  const projectId = api && tenant ? workspaceProject(cwd, false) : undefined;
  const pendingShots = projectId ? api!.scoped(tenant!.workspaceId).list("shots", { projectId }).filter(shot => !shot.approvedTakeId) : [];
  // ACT: 专项路由也读取待制作镜头，续作不能只靠本轮措辞；这里只匹配主题，不把全项目规格重复塞入上下文。
  const topicText = `${task}\n${JSON.stringify(project.revisions.find(item => item.id === project.approvedId)?.brief ?? project.brief)}\n${JSON.stringify(pendingShots.map(shot => ({ action: shot.action, creativeBrief: shot.creativeBrief, camera: shot.camera })))}`;
  const selectedTopics = topics.filter(topic => topic.match.test(topicText));
  // ACT: 先读取已保存的制作上下文再判断入口，避免“再快一点”等续作指令在专项路由前被漏掉。
  if (!explicitNames.length && !music && !advertising && !story && !selectedTopics.length && !/视频|短片|分镜|场景|生成|制作|继续|接着|这部作品|旅拍|婚礼|旅行|vlog|小清新|自然光|清透色彩|中式园林|月洞门|游廊|东方奇境|巨物花木|云上天宫|东方梦境|提示词|videoPromptDirector/i.test(topicText)) return "";
  if (!canReadSkills(tools)) {
    return "## 制作技能状态\n本轮技能正文读取未开启，未自动加载制作技能；不能声称已使用。";
  }
  const sequenceKinds = new Set(projectId ? api!.scoped(tenant!.workspaceId).list("sequences", { projectId }).map(item => item.kind).filter(Boolean) : []);
  const savedKind = project.revisions.find(item => item.id === project.approvedId)?.brief.kind
    ?? (project.version > 0 ? project.brief.kind : sequenceKinds.size === 1 ? [...sequenceKinds][0] : project.brief.kind);
  const kind = music ? "musicFilm" : advertising ? "adfilm" : story ? "story"
    : savedKind;
  const primary = kind === "musicFilm" ? "musicfilm" : ["adfilm", "brandFilm"].includes(kind) ? "adfilm" : "story";
  const intentText = explicitNames.length || /图片|图像|生图|视频|短片|分镜|剧本|五板块/.test(task) ? task : topicText;
  const imagePrompt = explicitNames.includes("gavenDirectImagePrompts") || /(?:图片|图像|生图|文生图).*提示词|提示词.*(?:图片|图像|生图)/.test(intentText) && !/视频|短片|分镜/.test(intentText);
  const scriptPrompt = explicitNames.includes("gavenScriptToVideo") || /(?:剧本|分镜).*(?:转|改写成|整理成).*(?:视频)?提示词/.test(intentText);
  const standalonePrompt = explicitNames.includes("videoPromptDirector") || /五板块|视频提示词|视频节点|生成段/.test(intentText);
  // ACT: 文字/单图专项只加载自己的方法；正式制作不预读互斥的五板块输出协议。
  const focusedNames = explicitNames.filter(name => ["gavenDirectImagePrompts", "gavenScriptToVideo", "gavenQingluAllegory", "insight", "directorPalettes", "breakdown", "canvas"].includes(name));
  const names = focusedNames.length ? [...focusedNames] : imagePrompt ? ["gavenDirectImagePrompts"] : scriptPrompt ? ["gavenScriptToVideo"]
    : ["workflow", primary, "cinema", "continuity", ...(standalonePrompt ? ["videoPromptDirector"] : [])];
  if (!imagePrompt && !scriptPrompt && !focusedNames.length) {
    if (/旅拍|婚礼|旅行|vlog/i.test(topicText)) names.push("travelWeddingDirector");
    if (/小清新|清透色彩|光感清新|lightFreshDirector/.test(topicText)) names.push("lightFreshDirector");
    if (/中式园林|月洞门|游廊/.test(topicText)) names.push("chineseGardenDirector");
    if (/东方奇境|巨物花木|云上天宫|东方梦境/.test(topicText)) names.push("orientalEpicDirector");
  }
  const focused = focusedNames.length || imagePrompt || scriptPrompt;
  if (!focused) {
    for (const topic of selectedTopics) if (!names.includes(topic.name)) names.push(topic.name);
  }
  for (const name of explicitNames) if (!names.includes(name)) names.push(name);
  const videoModel = names.includes("workflow") || names.includes("gavenScriptToVideo") ? await selectedVideoSkillModel() : undefined;
  if (names.includes("gavenScriptToVideo") && videoModel?.seedance && !names.includes("workflow")) names.push("workflow");
  const context = createSkillContext(cwd);
  const documents: string[] = [];
  const warnings: string[] = [];
  // ACT: 镜头语言是制作基础；其他专项按任务、简报和待制作镜头预读，避免全量知识挤占上下文。
  const referencePaths: Record<string, string[]> = {
    videoPromptDirector: ["references/segmentPlanning.md", ...(standalonePrompt ? ["references/fiveBlockWriting.md"] : [])],
    cinema: ["references/shotLanguage.md", "references/movementDirection.md", "references/referenceQuality.md"],
    workflow: [],
    story: [],
    adfilm: ["references/creativeTranslation.md"],
    musicfilm: ["references/musicVideoDirection.md"],
    continuity: ["references/shotChecklist.md"],
    travelWeddingDirector: ["references/cameraActionMethods.md"],
    lightFreshDirector: ["references/lightAndColor.md"],
    chineseGardenDirector: ["references/spaceAndLight.md"],
    orientalEpicDirector: ["references/scaleAndStructure.md", "references/dreamSpace.md"],
    gavenScriptToVideo: ["references/camera-motion.md", "references/performance.md", "references/continuity-qc.md"],
  };
  // ACT: 默认视频模型在开始本轮前已选定时预读模型规则；中途切换仍须按工具返回的实际模型读取。
  if (names.includes("workflow") && videoModel?.seedance) referencePaths.workflow.push("references/seedanceDirector.md");
  if (!focused) for (const topic of selectedTopics) referencePaths[topic.name].push(...topic.paths);
  for (const name of names) {
    const skill = available.find(item => item.name === name);
    if (!skill) { warnings.push(`缺少技能 ${name}`); continue; }
    if (skill.disableModelInvocation && !explicitNames.includes(name)) {
      warnings.push(`${name} 已关闭自动调用，未加载`);
      continue;
    }
    for (const path of [undefined, ...new Set(referencePaths[name] ?? [])]) {
      try {
        const document = await context.read({ name, path });
        documents.push(`### ${document.name} / ${document.scope} / ${document.path}\n${document.content}`);
      } catch (error) {
        warnings.push(`${name}/${path ?? "SKILL.md"} 读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return [
    "## 本轮自动读取的制作技能\n以下正文已按实际目录和工作区优先级读取，仅执行本轮阶段。用户要求与有效采用版本优先；题材风格、案例和默认值只补缺项。正式镜头用 productionSpec 编译，独立节点五板块与纯文本逐镜格式按当前交付择一，不叠加。模型专项仅在当前实际型号与模式匹配时适用，切换后旧专项退出；参考、时长和声音能力以实际请求回读为准。已有授权内的常规决定继续处理，技能不能新增重复确认。",
    ...documents,
    ...(warnings.length ? [`## 制作技能缺项\n${warnings.join("\n")}\n如实说明与当前任务有关的缺项，不假称已加载。`] : []),
  ].join("\n\n");
}
