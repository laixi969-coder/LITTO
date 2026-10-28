import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, stat, writeAtomic } from "@toonflow/file";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QuestionAnswer, QuestionContext } from "@toonflow/tools-scaffold/runtime";
import { z } from "zod";
import { run } from "@/agent/runtime";
import { cloud } from "@/lib/cloud";
import { currentTenant, privateDataDirectory } from "@/utils/tenant";
import { selectedModel } from "@/utils/modelSelection";
import { getConfiguredModel } from "@/utils/ai";
import { listMediaModels } from "@/utils/media/generation";
import { workspaceProject } from "@/utils/media/jobs";
import { readStoryProject } from "@/utils/story";
import { getStatus } from "@/utils/ffmpeg";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { autoFilmScope } from "./scope";
import { assertVideoObservation, assertStoryObservation, cameraObservationPlan, cameraReviewsSchema, dialogueReviewsSchema, observeVideo, observeVoice, storyChecksSchema, videoObservationModel } from "./observe";
import { readVoiceProject } from "@/utils/media/voiceDecision";
import { mediaHash } from "@/utils/media/lipSync";
import { speechSourceKey } from "@toonflow/tool-media-generation/voiceProject";
import type { AutoFilmTask } from "./types";
import { assertNarrativeReady, autoFilmProgress, narrativeFailures, narrativePlan, narrativeReviewSchema, reviewNarrative } from "./narrative";

const relativePath = z.string().min(1).max(2048).refine(value => !/^[\\/]|[:\u0000-\u001f]/.test(value) && value.split(/[\\/]/).every(part => part && part !== "." && part !== ".."), "须为工作区相对路径");
export const inputSchema = z.strictObject({
  script: z.string().trim().min(1).max(100000),
  references: z.array(z.strictObject({ name: z.string().trim().min(1).max(200), path: relativePath })).max(20),
});
const choiceSchema = z.strictObject({
  answer: z.string().trim().min(1).max(8000),
  values: z.record(z.string(), z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.array(z.string())])).optional(),
  reason: z.string().trim().min(1).max(2000),
});
const stateSchema = z.object({
  id: z.uuid(), directory: z.string(), projectId: z.string(), userId: z.string(), workspaceId: z.string(),
  status: z.enum(["running", "completed", "failed", "stopped", "interrupted"]),
  createdAt: z.string(), updatedAt: z.string(), script: z.string(),
  references: z.array(z.object({ name: z.string(), path: relativePath, mimeType: z.string(), mediaId: z.string() })),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(), sequenceIds: z.array(z.string()),
  storyRevisionId: z.string().optional(),
  narrativeReviews: z.array(narrativeReviewSchema).default([]),
  generationCount: z.number().int().nonnegative(), attempts: z.record(z.string(), z.number().int().nonnegative()),
  toolCalls: z.number().int().nonnegative(), progress: z.string(), error: z.string().optional(),
  playbacks: z.array(z.object({ mediaId: z.string(), hash: z.string(), note: z.string(), planKey: z.string().optional(), storyKey: z.string().optional(), storyChecks: storyChecksSchema.optional(), dialogueReviews: dialogueReviewsSchema.optional(), cameraReviews: z.array(cameraReviewsSchema.element.extend({ fingerprint: z.string() })).optional() })),
  voicePlaybacks: z.array(z.object({ lineId: z.string(), takeId: z.string(), hash: z.string(), sourceKey: z.string(), audioRead: z.boolean(), verdict: z.enum(["pass", "revise", "unverified"]), transcript: z.string(), note: z.string() })).default([]),
  decisions: z.array(z.object({ tool: z.string(), title: z.string(), answer: z.string(), values: choiceSchema.shape.values, reason: z.string() })),
  output: z.object({ renderId: z.string(), sequenceId: z.string(), mediaId: z.string(), url: z.string() }).optional(),
});
const live = new Map<string, { controller: AbortController; finished: Promise<void> }>();
const confirmationTools = new Set(["askUser", "requestStoryApproval", "requestStoryDecision", "requestProductionDecision"]);
const allowedTools = new Set([
  "read", "write", "edit", "ls", "grep", "find", "ffprobe", "ffmpeg", "skillOperator",
  "readVisualReferences", "saveSceneList", "readSceneList", "saveBreakdown", "readStoryProject", "updateStoryProject",
  ...confirmationTools, "listMediaModels", "productionSpec", "inspectProduction", "reviewProduction", "reviewProductions",
  "generateShots", "generateImage", "generateVideo", "generateAudio",
]);
const instructions = `你正在执行用户点击启动的独立「一键自动成片」任务。用户已授权本任务内的创作、素材生成、自动选片、剪辑、配音和代理审阅，全部制作选择由你完成，无需用户回答。
遵循 workflow 的制作方法，但其中的人工选择在本次任务中由你自主完成。已有完整剧本保留剧情、原句和角色；只有梗概时补写。角色图的身份优先，按图名与剧本匹配；不明确时自行做合理分配并记录。缺失资产自行设计。无需另询画幅、风格、时长、音色、模型、分辨率或候选；沿用可用默认模型与项目规格，未设置或不可用的服务明确报告，不假装成功。
先在故事工作台保存、审阅并自动采用本任务剧本，记录稳定sceneId。创建本任务专属的新序列，sequence的storyRevisionId引用这版剧本，镜头source.sceneId关联对应场次。所有新镜头和导出归入该序列；复用适用资产，不修改其他序列与旧成片。完整交付所有输入场次，不擅自删减成长片预告。配乐与音效按内容需要安排，不能用字幕、静帧拼接或旁白替代要求的动态表演和对白。输入角色图已经登记mediaId，直接用reference和asset登记身份参考；仅需要补齐设定时生成补充图，不把用户图丢掉或随意重绘。
生成前先完成全剧分镜，调用 reviewAutoFilmStory 核对原稿→采用剧本→全部镜头。遗漏场次、原句、行动主体或因果须先修规格，不用付费生成试错。镜数与片长由完整事件、真实对白和反应决定，不固定十镜，不把每场压成一句摘要。沿用 action/performance/camera.design/creativeBrief/intendedStateDelta 共同设计：承接何结果、谁为何对谁做什么、对白在动作前中后何时发生、对手怎样反应、镜尾改变什么、如何引出下一镜。逐句保留说话人和画内/画外通道；不能为口型方便改旁白。多人同框时明确目标说话人在整个发声期的可辨认位置和嘴部覆盖；模型无法选目标脸时用符合剧情的说话者覆盖镜头，不让口型模型猜人。
分镜核对通过后配置并采用真实声音，planSpeech 实测，再统一调整对白窗口、动作反应与切点，重新 reviewAutoFilmStory；之后才生成镜头画面。规格检查不等于真实声画合格，observeAutoFilmVideo 的 storyChecks 同样有效，revise/unverified 不能改填通过。无需人工审核表示由系统自动核对完整性，不表示跳过叙事和声画校验。只修具体缺陷，复用未受影响的素材和任务；剪辑按表演落点保留完整对白，不直接把每条生成素材原长串起来，不用长时间无行动的等待填时长。
确认类工具支持 automaticChoice:{answer,values?,reason}。首次调用若返回待选题目，读完真实候选后在同一工具参数补 automaticChoice 重试，服务端校验并保存选择；不要把题目转交用户。askUser 的创作问题直接自己决定。字段表单须按题目 fields 提供 values。
关键帧必须读取实际图片。视频先用 observeAutoFilmVideo{mediaId,focus} 把完整真实视频交给已配置的视频审阅模型观察，创作模型无需自己支持视频输入。读取实际返回的时间点、表演、对白和接点证据，再使用 reviewProduction/reviewProductions 记录真实观察并采用（authorization 填用户点击启动自动成片的授权）。此模式没有人工主帧采用与用户满意度工具；不得伪造用户看过、用户满意或人类验收。selectCandidate 不能 asHero。资产、故事、声音和剪辑仍通过各自确认工具保存自动决定。
有对白先确定真实声音和时长，再安排镜头与口型；复用已成功生成的素材和任务。参考、版本、指纹、连续性和声音门禁全部有效，不准通过修改检查代码或填假观察绕过。只有实际完整看听才填 fullPlayback:true；无法观察时说明缺项并结束，不能宣称通过。
配音候选先 observeAutoFilmVoice{lineId,takeId} 完整试听，依据返回的原句核对、实际转写与表演结论 selectVoice；不要用普通 read 读取音频冒充试听，也不把试听推回用户。revise或unverified不能采用为通过，已有有效采用声音复用。
固定配音的专用口型模型独立于默认视频生成模型。先 listMediaModels{all:true} 核对 lipSync:true，再 productionSpec(readVoice) 读取并保留已有方案，通过 requestProductionDecision{operation:configureVoice,data:{project}} 保存 lipSyncProviderId/lipSyncModelId；台词绑定当前采用的声音和人物原片。这项选择已在自动制作授权内，由你填写 automaticChoice，不向用户申请更换默认模型。口型 generateVideo 使用该专用 providerId/modelId、purpose:standalone 和这一对 videos/audios，不传 shotId 或 productionFingerprint，不调用 selectModel 把默认视频模型换成口型模型。结果成功后先 observeAutoFilmVideo 完整看听、productionSpec(inspectSpeech) 核对声音，再 importSpeech 登记新候选并 reviewProduction 采用；不使用 approveTake 代替代理审阅。后配对白优先 productionSpec(syncSpeech,{shotId})，由服务端自动裁出每句真实发声窗口、处理口型并按原时间合回完整镜头；支持多句和延迟发声，不要求用户手动拆片。返回结果先完整观察，再 importSpeech 携带 assemblyId 和返回的路径、inspectionKey；不能直接叠对白冒充口型。原片须先通过视觉检查选入工作版；无声音时不填声音通过，也不提前采用为正式镜头。selectModel 返回默认模型、approveTake 被禁止都不是口型通道不可用的证据；续跑须按当前规则核对独立通道，不沿用历史对话中的无解结论。
importSpeech 只登记新候选；登记前观察用于核对口型结果，登记后须再次 observeAutoFilmVideo，按新候选与当前规格的摄影清单完整观察，再 reviewProduction。不得把登记前的空清单观察当成新候选的完整检查，也不重复生成口型结果。
摄影检查清单由 observeAutoFilmVideo 自动从当前镜头规格读取，focus 只补充重点，不替代起幅、相机路径和结束构图检查。返回的 cameraReviews 是实际观察，revise 或 unverified 不能改写成 pass；保留候选，根据具体偏差修正规格或在已有重试额度内处理。当前后台没有3D预演工具，不尝试调用画布节点，不为缺少3D阻塞普通镜头，也不声称已使用数值轨迹。
用户明确要求多场景、运镜或可见对口型时，分镜逐项标明实际场景、景别、摄影机起点路径终点、发声时间窗和可辨认嘴部的构图。结果逐项比对：改变裁切不算换场景，人物移动不证明摄影机移动，张嘴不证明音节同步，生成成功不证明质量通过。观察模型无法确认音频或与真实声音检查矛盾时，保留未验证状态并核查原片，不据此删除声音或填通过。优先修复具体失效镜头，保留原候选和对比；用户有意采用单场景、固定机位或画外音时不强制增加上述要求。
允许为失败或有明确缺陷的目标最多再试两次，总计最多120次媒体生成（含配音），重试使用新的 regenerationId，同一次重试复用该ID；先查询旧任务防止重复消耗。停止、余额不足、权限撤回或保存失败时停止，不无限重试。
镜头完成后读取 readEdit，自动剪辑并用 render 导出正式成片，等待真实 SUCCEEDED，再 inspectFinal、observeAutoFilmVideo 完整核对成片，按真实观察 agentReviewFinal。不要调用 reviewFinal 代填用户满意度。最后调用 completeAutoFilm{renderId}；只有这个工具确认完成才算交付，不能只回复制作方案或让用户点击下一步。未完成就继续工具执行；真实阻塞时给出具体原因并保存已有成果。`;

function identity(directory: string, create = false) {
  const tenant = currentTenant(), api = cloud();
  if (!tenant || !api) throw Object.assign(new Error("自动成片需要已登录的制作工作区"), { status: 403 });
  const member = api.dbGet("SELECT m.role FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND w.deleted_at IS NULL", tenant.workspaceId, tenant.userId);
  if (!member) throw Object.assign(new Error("工作区访问权限已失效"), { status: 403 });
  const projectId = workspaceProject(directory, create)!;
  const folder = join(privateDataDirectory(), "autoFilms", `project${createHash("sha256").update(directory).digest("hex")}`);
  return { tenant, api, projectId, folder, currentPath: join(folder, "current.json"), editable: member.role !== "VIEWER" };
}

async function readCurrent(directory: string) {
  const context = identity(directory);
  const pointer = await readFile(context.currentPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (pointer === null) return { ...context, task: null };
  const id = z.uuid().parse(JSON.parse(pointer).id);
  const task = stateSchema.parse(JSON.parse(await readFile(join(context.folder, `task${id.replaceAll("-", "")}.json`), "utf8")));
  if (task.directory !== directory || task.workspaceId !== context.tenant.workspaceId || task.projectId !== context.projectId) throw new Error("自动成片任务与当前项目不符");
  return { ...context, task };
}

export async function get(directory: string): Promise<AutoFilmTask | null> {
  const { task } = await readCurrent(directory);
  if (task?.output) {
    const { api, tenant } = identity(directory);
    const media = api.scoped(tenant.workspaceId).get("media", task.output.mediaId);
    if (media && !media.deletedAt) task.output.url = `/cloud${api.mediaView(media).url}`;
  }
  return task?.status === "running" && !live.has(directory)
    ? { ...task, status: "interrupted", progress: "服务已重启，制作进度已保留，点击继续制作可恢复" } : task;
}

function validateChoice(request: Parameters<QuestionContext["ask"]>[1], choice: z.infer<typeof choiceSchema>): QuestionAnswer {
  if (request.fields?.length) {
    const values = choice.values ?? {};
    for (const field of request.fields) {
      const value = values[field.field];
      if (value === undefined && !field.required) continue;
      if (field.required && (value === undefined || value === "" || Array.isArray(value) && !value.length)) throw new Error(`自动选择缺少必填项：${field.title}`);
      if (["select", "radio"].includes(field.type) && !field.options?.includes(String(value))) throw new Error(`自动选择不在选项内：${field.title}`);
      if (field.type === "checkbox" && (!Array.isArray(value) || value.some(item => !field.options?.includes(item)))) throw new Error(`自动多选无效：${field.title}`);
      if (field.type === "inputNumber" && typeof value !== "number" || field.type === "switch" && typeof value !== "boolean"
        || ["input", "textarea"].includes(field.type) && typeof value !== "string") throw new Error(`自动选择类型错误：${field.title}`);
    }
    if (Object.keys(values).some(key => !request.fields!.some(field => field.field === key))) throw new Error("自动表单包含未知字段");
  } else if (request.options?.length && !request.options.includes(choice.answer)) throw new Error("自动选择必须使用题目中的完整选项");
  return { answer: choice.answer, values: choice.values };
}

function launch(task: AutoFilmTask, folder: string) {
  const controller = new AbortController();
  let toolCalls = 0;
  const taskPath = join(folder, `task${task.id.replaceAll("-", "")}.json`);
  let writes = Promise.resolve();
  const save = () => {
    task.updatedAt = new Date().toISOString();
    const content = JSON.stringify(task, null, 2);
    writes = writes.then(() => writeAtomic(taskPath, content));
    return writes;
  };
  const choiceScope = new AsyncLocalStorage<{ tool: string; choice?: z.infer<typeof choiceSchema> }>();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6 * 3600_000)]);
  const assertActive = () => {
    signal.throwIfAborted();
    const context = identity(task.directory);
    if (!context.editable || context.projectId !== task.projectId) throw new Error("自动成片的编辑权限或项目关联已失效");
    if (task.output) throw new Error("成片已交付，本任务不再执行修改");
  };
  const countToolCall = () => {
    assertActive();
    task.toolCalls++;
    if (++toolCalls > 2000) { controller.abort(new Error("本次运行已达到2000次工具调用上限，进度已保留")); signal.throwIfAborted(); }
  };
  const question: QuestionContext = {
    decisionSource: { kind: "agent", taskId: task.id },
    async ask(_id, request, questionSignal) {
      assertActive();
      questionSignal?.throwIfAborted();
      const current = choiceScope.getStore();
      if (!current?.choice) throw new Error(`请自主决定并补充 automaticChoice 后重试；无需用户回答。待选内容：${JSON.stringify(request)}`);
      const answer = validateChoice(request, current.choice);
      task.decisions.push({ tool: current.tool, title: request.title, ...answer, reason: current.choice.reason });
      await save();
      return answer;
    },
  };
  const prepareTools = (tools: ToolDefinition[]): ToolDefinition[] => {
    const selected = tools.filter(tool => allowedTools.has(tool.name));
    for (const name of ["productionSpec", "generateImage", "generateVideo", "reviewProduction", "read", "write", "readStoryProject", "requestStoryApproval"])
      if (!selected.some(tool => tool.name === name)) throw new Error(`自动成片缺少已启用工具：${name}`);
    return [...selected.map(tool => {
      const parameters = tool.parameters as Record<string, any>;
      return {
        ...tool,
        ...(confirmationTools.has(tool.name) ? {
          parameters: { ...parameters, properties: { ...parameters.properties, automaticChoice: z.toJSONSchema(choiceSchema, { target: "draft-07" }) } },
          description: `${tool.description}\n自动成片中由AI决定：若有待选题目，补充 automaticChoice:{answer,values?,reason}，不向用户发问。`,
        } : {}),
        async execute(id, args, toolSignal, onUpdate, context) {
          countToolCall();
          const { automaticChoice, ...input } = args as Record<string, any>;
          if (tool.name === "requestProductionDecision" && (["reviewFinal", "reviewOutput", "approveTake", "publishAsset", "libraryReference"].includes(input.operation) || input.operation === "selectCandidate" && input.data?.asHero))
            throw new Error("自动模式不代填用户满意度或修改跨项目角色库；关键帧和视频请用 reviewProduction，成片用 productionSpec(agentReviewFinal)");
          if (tool.name === "requestStoryDecision" && input.decision?.type === "release") throw new Error("自动成片不执行发布或填写发布反馈");
          if (tool.name === "productionSpec" && ["publishAsset", "favoriteAsset"].includes(input.operation)) throw new Error("本任务只制作当前项目，不修改跨项目角色库");
          const { api, tenant } = identity(task.directory), scope = api.scoped(tenant.workspaceId);
          const operationData = input.data ?? {};
          if (tool.name === "productionSpec" && ["render", "agentReviewFinal"].includes(input.operation)) await assertNarrativeReady(task);
          if (tool.name === "productionSpec" && input.operation === "agentReviewFinal") {
            const render = scope.get("renders", operationData.renderId), media = render && scope.get("media", render.mediaId);
            const snapshot = await narrativePlan(task);
            assertStoryObservation(task.playbacks.findLast(item => item.mediaId === media?.id && item.hash === media?.hash && item.storyKey === snapshot.key), "final");
          }
          if (tool.name === "requestProductionDecision" && input.operation === "selectVoice" && automaticChoice) {
            const index = /^采用配音 (\d+)$/.exec(automaticChoice.answer)?.[1];
            if (index) {
              const { project } = await readVoiceProject(task.directory);
              const line = project.lines.find(line => line.id === operationData.lineId);
              const takeId = operationData.takeIds?.[Number(index) - 1], take = line?.takes.find(take => take.id === takeId);
              if (!line || !take || !line.shotId || !task.sequenceIds.includes(scope.get("shots", line.shotId)?.sequenceId)) throw new Error("只能采用本任务镜头的配音候选");
              if (line.takeId !== takeId) {
                const hash = await mediaHash(task.directory, take.audio.path), sourceKey = speechSourceKey(line, project.roles.find(role => role.id === line.roleId));
                if (!task.voicePlaybacks?.some(item => item.lineId === line.id && item.takeId === takeId && item.hash === hash && item.sourceKey === sourceKey && item.verdict === "pass"))
                  throw new Error("须先 observeAutoFilmVoice 完整试听当前候选并通过，不把试听或选择交给用户");
              }
            }
          }
          if (["productionSpec", "requestProductionDecision"].includes(tool.name)) {
            const sequenceId = operationData.sequenceId ?? (operationData.shotId ? scope.get("shots", operationData.shotId)?.sequenceId : undefined);
            if (sequenceId && !task.sequenceIds.includes(sequenceId)) throw new Error("自动成片只修改和导出本任务新建的序列，不能修改手动制作序列");
          }
          if (tool.name === "productionSpec" && input.operation === "importSpeech") {
            const { path } = await resolveWorkspacePath(task.directory, z.string().min(1).parse(operationData.videoPath));
            const hash = createHash("sha256").update(await readFile(path)).digest("hex");
            const snapshot = await narrativePlan(task);
            assertStoryObservation(task.playbacks.findLast(item => item.hash === hash && item.storyKey === snapshot.key && scope.get("media", item.mediaId)?.hash === hash), "speech");
          }
          const reviews = tool.name === "reviewProductions" ? input.reviews : tool.name === "reviewProduction" ? [input] : tool.name === "productionSpec" && input.operation === "agentReview" ? [input.data] : [];
          for (const review of reviews) {
            const target = scope.get(review.targetType === "take" ? "takes" : "keyframes", review.targetId);
            if (!target || !task.sequenceIds.includes(scope.get("shots", target.shotId)?.sequenceId)) throw new Error("只能审阅和采用本任务新建序列的素材");
            if (review.targetType !== "take" || !review.fullPlayback) continue;
            const take = scope.get("takes", review.targetId), media = take && scope.get("media", take.mediaId);
            const fingerprint = api.shotFingerprint(scope, take!.shotId);
            const observed = task.playbacks.filter(item => item.mediaId === media?.id && item.hash === media?.hash)
              .flatMap(item => item.cameraReviews ?? []).findLast(item => item.takeId === take!.id && item.fingerprint === fingerprint);
            if (!media || !observed) throw new Error("请先 observeAutoFilmVideo 按当前镜头规格完整观察该候选；旧规格或没有摄影清单的观察不能复用");
            const snapshot = await narrativePlan(task);
            const playback = task.playbacks.findLast(item => item.mediaId === media.id && item.hash === media.hash && item.storyKey === snapshot.key);
            // 后配音原片允许先进入视觉工作版，但不能将缺失的声音或口型记为通过。
            assertStoryObservation(playback, "visual");
            if (review.audioReview && Object.values(review.audioReview).includes("pass")) assertStoryObservation(playback, "speech");
            // 摄影结果来自观察员，不让制作助手将失败或未验证项改填通过；其余动作检查仍由原流程负责。
            review.motionReview = [...(review.motionReview ?? []).filter((item: { id: string }) => !["cameraStart", "cameraPath", "cameraEnd"].includes(item.id)),
              ...observed.checks.map(item => ({ ...item, verdict: item.verdict === "pass" ? "pass" : "revise", note: item.verdict === "unverified" ? `摄影未验证：${item.note}`.slice(0, 2000) : item.note }))];
          }
          task.progress = `正在执行：${tool.label || tool.name}`;
          await save();
          const result = await choiceScope.run({ tool: tool.name, choice: automaticChoice === undefined ? undefined : choiceSchema.parse(automaticChoice) }, () => tool.execute(id, input, toolSignal, onUpdate, context));
          if (tool.name === "productionSpec" && input.operation === "sequence") {
            const sequence = result.details as { id?: string };
            if (sequence?.id && !task.sequenceIds.includes(sequence.id)) { task.sequenceIds.push(sequence.id); await save(); }
          }
          if (tool.name === "requestStoryApproval") {
            const approval = result.details as { approved?: boolean; revisionId?: string };
            if (approval?.approved && approval.revisionId) { task.storyRevisionId = approval.revisionId; await save(); }
          }
          return result;
        },
      } satisfies ToolDefinition;
    }), {
      name: "readAutoFilmProgress", label: "读取真实制作进度", description: "从当前剧本、分镜、声音、镜头与导出记录计算缺项和下一步，不以对话总结判断完成。可随时读取，优先复用已有成果。",
      parameters: z.toJSONSchema(z.strictObject({})),
      async execute() {
        countToolCall();
        const result = await autoFilmProgress(task);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }, {
      name: "reviewAutoFilmStory", label: "核对完整叙事分镜", description: "生成前逐场核对原稿、采用剧本与全部分镜的对白、人物行动、因果、屏时和接戏。无参数，从真实记录读取；返回具体缺项或独立检查。修改规格后重新调用，未变的检查复用，不生成媒体。",
      parameters: z.toJSONSchema(z.strictObject({})),
      async execute() {
        countToolCall();
        task.progress = "正在核对原稿、叙事分镜与对白调度";
        await save();
        const snapshot = await narrativePlan(task);
        if (snapshot.issues.length) return { content: [{ type: "text", text: JSON.stringify({ ready: false, issues: snapshot.issues }) }], details: { ready: false, issues: snapshot.issues } };
        let review = task.narrativeReviews?.find(item => item.key === snapshot.key);
        if (!review) {
          review = await reviewNarrative(snapshot, signal);
          if ((await narrativePlan(task)).key !== snapshot.key) throw new Error("检查期间剧本或分镜已变化，请重新核对当前版本");
          task.narrativeReviews = [...(task.narrativeReviews ?? []).slice(-19), review];
          await save();
        }
        const issues = narrativeFailures(review), result = { ready: !issues.length, issues, review };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }, {
      name: "observeAutoFilmVoice", label: "完整试听配音", description: "完整听取本任务当前角色原句的配音候选，返回实际转写和检查结论，再selectVoice。不能采用revise或unverified为通过。",
      parameters: z.toJSONSchema(z.strictObject({ lineId: z.uuid(), takeId: z.uuid() })),
      async execute(_id, input) {
        countToolCall();
        const { lineId, takeId } = z.strictObject({ lineId: z.uuid(), takeId: z.uuid() }).parse(input);
        task.progress = "正在完整试听配音";
        await save();
        const result = await observeVoice(task.directory, lineId, takeId, task.sequenceIds, signal);
        (task.voicePlaybacks ??= []).push(result);
        await save();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }, {
      name: "observeAutoFilmVideo", label: "完整观察视频声画", description: "将真实任务视频整体发送给已配置的视频审阅模型，创作模型不需要支持视频输入。支持本任务候选、成片，以及当前配音绑定的成功口型结果（尚未importSpeech时用productionSpec read查询对应媒体ID）。口型结果先完整看听再importSpeech；登记候选后再次调用，按新候选的摄影清单检查，再reviewProduction采用。自动附带当前镜头起幅、相机路线和结束构图的摄影检查清单。返回带时间点的cameraReviews与声画观察；revise或unverified不得改成通过。focus只补充对白、检查重点及剪辑接点，不能覆盖系统清单。",
      parameters: z.toJSONSchema(z.strictObject({ mediaId: z.string().min(1), focus: z.string().min(1).max(12000) })),
      async execute(_id, input) {
        countToolCall();
        const { mediaId, focus } = z.object({ mediaId: z.string().min(1), focus: z.string().min(1).max(12000) }).parse(input);
        const { api, tenant } = identity(task.directory), media = api.scoped(tenant.workspaceId).get("media", mediaId);
        const cameraPlan = await cameraObservationPlan(task.directory, task.projectId, mediaId, task.sequenceIds);
        const snapshot = await narrativePlan(task);
        const planKey = createHash("sha256").update(JSON.stringify([2, cameraPlan, snapshot.key, focus])).digest("hex");
        const saved = task.playbacks.find(item => item.mediaId === mediaId && item.hash === media?.hash && item.planKey === planKey);
        if (saved) return { content: [{ type: "text", text: JSON.stringify(saved) }], details: saved };
        const key = `observe${createHash("sha256").update(JSON.stringify([mediaId, media?.hash, cameraPlan, snapshot.key, videoObservationModel().key])).digest("hex")}`;
        if ((task.attempts[key] ?? 0) >= 3) throw new Error("该视频已达到完整审阅尝试上限，请核对模型的视频与声音理解能力");
        task.attempts[key] = (task.attempts[key] ?? 0) + 1;
        task.progress = "正在完整观察视频画面和声音";
        await save();
        const result = { ...await observeVideo(task.directory, task.id, task.projectId, mediaId, `原稿与全剧分镜（仅核对当前视频覆盖范围；成片核对全部）：${JSON.stringify(snapshot.plan)}\n\n检查目标：${focus}`, signal, cameraPlan), planKey, storyKey: snapshot.key };
        if ((await narrativePlan(task)).key !== snapshot.key) throw new Error("观察期间叙事分镜已变化，请按当前计划重新观察");
        task.playbacks.push(result);
        await save();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }, {
      name: "completeAutoFilm", label: "交付自动成片", description: "实际正式导出且代理验收通过后调用，校验真实成片，不接受草稿或其他任务的成片。",
      parameters: z.toJSONSchema(z.strictObject({ renderId: z.string().min(1) })),
      async execute(_id, input) {
        countToolCall();
        const { renderId } = z.object({ renderId: z.string().min(1) }).parse(input);
        const { api, tenant } = identity(task.directory), scope = api.scoped(tenant.workspaceId);
        const snapshot = await assertNarrativeReady(task);
        const render = scope.get("renders", renderId);
        if (!render || render.projectId !== task.projectId || !task.sequenceIds.includes(render.sequenceId)) throw new Error("只能交付本任务序列的真实成片");
        if (render.status !== "SUCCEEDED" || render.manifest?.options?.draft || !render.mediaId || api.finalQualityView(scope, render).status !== "pass") throw new Error("成片尚未完成正式导出与有效代理验收，请继续制作；不能把草稿标为完成");
        const story = await readStoryProject(task.directory), revision = story.revisions.find(item => item.id === task.storyRevisionId);
        const sequence = scope.get("sequences", render.sequenceId), shots = scope.list("shots", { sequenceId: render.sequenceId });
        const edit = api.getEdit(scope, render.sequenceId, false);
        if (!revision || story.approvedId !== revision.id || sequence?.storyRevisionId !== revision.id
          || revision.scenes.some(scene => !shots.some(shot => shot.source?.sceneId === scene.sceneId && shot.source?.revisionId === revision.id
            && edit.clips.some(clip => clip.shotId === shot.id && edit.tracks.some(track => track.id === clip.trackId && track.kind === "video") && clip.mediaId && scope.get("media", clip.mediaId)?.mime.startsWith("video/"))))) throw new Error("本任务采用剧本的场次尚未全部进入本次成片，不能省略场次交付");
        const renderedMedia = scope.get("media", render.mediaId);
        assertStoryObservation(task.playbacks.findLast(item => item.mediaId === renderedMedia?.id && item.hash === renderedMedia?.hash && item.storyKey === snapshot.key), "final");
        const view = api.workspaceProduction(scope, task.projectId, "read", {}, tenant.userId) as { renders: { id: string; media?: { url: string } }[] };
        const media = view.renders.find(item => item.id === renderId)?.media;
        if (!media) throw new Error("成片媒体不存在");
        task.output = { renderId, sequenceId: render.sequenceId, mediaId: render.mediaId, url: media.url.startsWith("/") ? `/cloud${media.url}` : media.url };
        task.progress = "成片已导出并通过代理验收";
        await save();
        return { content: [{ type: "text", text: JSON.stringify(task.output) }], details: task.output };
      },
    }];
  };
  // ACT: 后台复用现有 Agent 与持久化媒体队列。进程重启只标记中断，由显式续跑恢复，不能启动即扣费。
  const finished = Promise.resolve().then(() => autoFilmScope.run({
    directory: task.directory,
    async beforeGeneration(kind, request) {
      assertActive();
      await assertNarrativeReady(task);
      if (request.shotId) {
        const { api, tenant } = identity(task.directory);
        const scope = api.scoped(tenant.workspaceId), shot = scope.get("shots", request.shotId);
        if (!shot || !task.sequenceIds.includes(shot.sequenceId)) throw new Error("自动成片不能生成或重做手动制作序列的镜头");
        if (kind !== "audio") api.assertSpeechPlan(scope, shot);
      }
      const key = createHash("sha256").update(JSON.stringify([kind, request.shotId ?? request.voiceLineId ?? request.outputName ?? request.prompt])).digest("hex");
      if (task.generationCount >= 120) { controller.abort(new Error("自动成片已达到120次生成上限，已有素材和进度已保留")); signal.throwIfAborted(); }
      if ((task.attempts[key] ?? 0) >= 3) throw new Error("此目标已达到3次尝试上限，已有素材和进度已保留");
      task.generationCount++;
      task.attempts[key] = (task.attempts[key] ?? 0) + 1;
      await save();
    },
  }, async () => {
    try {
      const model = selectedModel("text");
      if (!model) throw new Error("尚未配置可用的默认创作模型");
      getConfiguredModel(model.providerId, model.modelId);
      task.progress = "正在检查视频审阅模型的画面与声音读取能力";
      await save();
      await assertVideoObservation(signal);
      // 持续推进直到交付；已有时限和工具预算兜底，不因模型提前结束一轮而要求用户反复续跑。
      let idleTurns = 0;
      for (let turn = 0; !task.output; turn++) {
        assertActive();
        const before = task.toolCalls;
        const progress = await autoFilmProgress(task);
        task.progress = `${progress.stage}：${progress.nextAction}`;
        await save();
        await run({ cwd: task.directory, ...model, thinkingLevel: "medium", sessionFile: task.sessionFile, signal, question, instructions, prepareTools,
          prompt: turn === 0 && !task.sessionFile
            ? `用户点击启动一键自动成片。任务 ${task.id}。请把以下剧本与角色参考完整制作成片，由你决定全部制作选项。已有任务序列：${JSON.stringify(task.sequenceIds)}；已有采用版本：${task.storyRevisionId ?? "无"}。有已有成果时先读取并复用，不重复创建。\n剧本：\n${task.script}\n参考图片（实际读取后使用）：\n${JSON.stringify(task.references)}\n执行规则：\n${instructions}`
            : `继续自动成片任务 ${task.id}，用户已授权全部制作选择。系统从真实数据计算的当前阶段与缺项：${JSON.stringify(progress)}。先核对已有媒体和原任务状态，不重复生成。任务序列：${JSON.stringify(task.sequenceIds)}。剩余生成次数：${120 - task.generationCount}。完成正式导出及代理验收后调用 completeAutoFilm；不得用文本总结结束未完成任务。以本次执行规则重新核对历史阻塞，不能直接重复旧结论。\n当前执行规则：\n${instructions}`,
        }, event => {
          if (event.type === "session") { task.sessionFile = event.file; void save().catch(() => controller.abort()); }
          if (event.type === "error") task.error = event.message;
          if (event.type === "text" && event.done && event.content) task.progress = event.content.slice(-3000);
        });
        await save();
        idleTurns = task.toolCalls === before ? idleTurns + 1 : 0;
        if (!task.output && idleTurns >= 3) throw new Error(`连续三轮没有执行制作操作，进度已保留。当前缺项：${JSON.stringify(await autoFilmProgress(task))}`);
      }
      signal.throwIfAborted();
      if (!task.output) throw new Error(task.error || `制作尚未完成，进度已保留。${task.progress}`);
      task.status = "completed";
      task.progress = "成片已完成";
    } catch (error) {
      task.status = task.output ? "completed" : controller.signal.aborted ? "stopped" : "failed";
      task.error = task.output || controller.signal.reason?.code === "userStop" ? undefined : error instanceof Error ? error.message : String(error);
      task.progress = task.output ? "成片已完成" : task.status === "stopped" ? "任务已停止，已有成果保留" : "制作中断，已有成果保留";
    } finally {
      try { await save(); }
      finally { live.delete(task.directory); }
    }
  })).catch(error => { console.error("自动成片状态保存失败", task.id, error); });
  live.set(task.directory, { controller, finished });
}

export async function start(directory: string, input: unknown) {
  const parsed = inputSchema.parse(input);
  const context = identity(directory, true);
  if (!context.editable) throw Object.assign(new Error("只读成员不能启动自动成片"), { status: 403 });
  const release = lockWorkspaceFiles([context.currentPath]);
  try {
    const previous = await get(directory);
    if (live.has(directory) || previous?.status === "running") throw Object.assign(new Error("当前项目已有自动成片任务正在运行"), { status: 409 });
    const model = selectedModel("text");
    if (!model) throw new Error("请先配置默认创作模型");
    getConfiguredModel(model.providerId, model.modelId);
    const models = await listMediaModels();
    if (!["image", "video"].every(kind => models.some(item => item.type === kind && !item.lipSync))) throw new Error("请先配置可用的默认图片和视频模型");
    const { tools } = await getStatus();
    if (!tools.ffmpeg.path || tools.ffmpeg.error || !tools.ffprobe.path || tools.ffprobe.error) throw Object.assign(new Error("自动成片需要可用的FFmpeg和FFprobe，请先在设置中配置"), { status: 424 });
    const id = randomUUID(), references: AutoFilmTask["references"] = [];
    const inputs = `.agent/autoFilms/task${id.replaceAll("-", "")}`;
    await mkdir((await resolveWorkspacePath(directory, inputs, true)).path, { recursive: true });
    for (const [index, reference] of parsed.references.entries()) {
      const source = await resolveWorkspacePath(directory, reference.path);
      const info = await stat(source.path);
      if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) throw new Error("角色图须为非空且不超过20MB的图片文件");
      const bytes = await readFile(source.path);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("角色图内容为空或超过20MB");
      const mimeType = context.api.sniff(bytes)?.mime;
      if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) throw new Error("角色图仅支持实际PNG、JPEG或WebP图片");
      const path = `${inputs}/reference${index}.${mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]}`;
      await writeAtomic((await resolveWorkspacePath(directory, path, true)).path, bytes, { exclusive: true });
      const scope = context.api.scoped(context.tenant.workspaceId), hash = createHash("sha256").update(bytes).digest("hex");
      const media = scope.list("media", { projectId: context.projectId, hash }).find(item => !item.deletedAt)
        ?? await context.api.saveMedia(context.tenant.workspaceId, context.projectId, bytes, { source: "autoFilmReference" });
      references.push({ name: reference.name, path, mimeType, mediaId: media.id });
    }
    const timestamp = new Date().toISOString();
    const task: AutoFilmTask = { id, directory, projectId: context.projectId, userId: context.tenant.userId, workspaceId: context.tenant.workspaceId,
      status: "running", createdAt: timestamp, updatedAt: timestamp, script: parsed.script, references, sequenceIds: [], generationCount: 0, attempts: {}, toolCalls: 0, playbacks: [], progress: "正在准备自动制作", decisions: [] };
    await mkdir(context.folder, { recursive: true });
    await writeAtomic(join(context.folder, `task${id.replaceAll("-", "")}.json`), JSON.stringify(task, null, 2), { exclusive: true });
    await writeAtomic(context.currentPath, JSON.stringify({ id }));
    launch(task, context.folder);
    return structuredClone(task);
  } finally { release(); }
}

export async function stop(directory: string, taskId: string) {
  const context = identity(directory);
  if (!context.editable) throw Object.assign(new Error("只读成员不能停止自动成片"), { status: 403 });
  const release = lockWorkspaceFiles([context.currentPath]);
  try {
    const { task } = await readCurrent(directory);
    if (!task || task.id !== taskId) throw Object.assign(new Error("当前任务已改变，请刷新"), { status: 409 });
    const active = live.get(directory);
    if (active) { active.controller.abort(Object.assign(new Error("用户停止自动成片"), { code: "userStop" })); await active.finished; }
    return get(directory);
  } finally { release(); }
}

export async function resume(directory: string, taskId: string) {
  const context = identity(directory);
  if (!context.editable) throw Object.assign(new Error("只读成员不能继续自动成片"), { status: 403 });
  const release = lockWorkspaceFiles([context.currentPath]);
  try {
    const task = await get(directory);
    if (!task || task.id !== taskId) throw Object.assign(new Error("当前任务已改变，请刷新"), { status: 409 });
    if (live.has(directory) || task.status === "completed") return task;
    if (task.userId !== context.tenant.userId) throw Object.assign(new Error("请由任务创建者继续制作"), { status: 403 });
    if (task.sessionFile) {
      const history = await resolveWorkspacePath(directory, `.agent/sessions/${task.sessionFile}`, true);
      await stat(history.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        // ACT: SDK 首条消息才落盘；启动后立即停止可能尚无会话，复用任务账本重建上下文。
        task.sessionFile = undefined;
      });
    }
    task.status = "running";
    task.error = undefined;
    task.progress = "正在恢复制作，复用已有成果";
    await writeAtomic(join(context.folder, `task${task.id.replaceAll("-", "")}.json`), JSON.stringify(task, null, 2));
    launch(task, context.folder);
    return structuredClone(task);
  } finally { release(); }
}
