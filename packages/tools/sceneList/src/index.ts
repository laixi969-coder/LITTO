import { z } from "zod";
import type { ToolDefinition, ToolFiles, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { breakdownSchema, sceneListSchema, validateBreakdown, validateSceneList, type SceneList } from "./schema";
import { storyActionSchema, storyDecisionSchema, storyProjectSchema, storyStale } from "./storyProject";

const sceneListPath = "场次表.json";
const historyDirectory = "场次表历史";
const breakdownPath = "拆解清单.json";
const storyApprovalSchema = z.strictObject({ revisionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) });

type SavedSceneList = SceneList & { schemaVersion: 1; version: number; savedAt: string };

async function readSaved(files: ToolFiles): Promise<SavedSceneList | null> {
  const raw = await files.readFile(sceneListPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return raw ? JSON.parse(raw.toString("utf8")) as SavedSceneList : null;
}

function rejected(issues: string[]): never {
  throw new Error(`未保存，请修正后重新调用：\n- ${issues.join("\n- ")}`);
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

const plugin: ToolPlugin = {
  validateConfig: config => z.strictObject({}).parse(config),
  createTools({ files, story }) {
    async function checkStory(value: SceneList) {
      if (!story) return;
      const project = storyProjectSchema.parse(await story.read());
      if (!project.version) return;
      await story.validateSources?.();
      const approved = project.revisions.find(item => item.id === project.approvedId);
      if (!approved || value.storyRevisionId !== approved.id || storyStale(project, approved)) rejected(["请先调用 requestStoryApproval 在聊天中确认采用当前版本，并把 storyRevisionId 设为该版本 ID"]);
      if (JSON.stringify(value.scenes.map(item => item.sceneId)) !== JSON.stringify(approved.scenes.map(item => item.sceneId))) rejected(["场次表须按已采用剧本的顺序保留全部 sceneId"]);
      if (project.brief.kind === "musicFilm") {
        if (value.kind !== "musicFilm") rejected(["MV 的场次表 kind 必须为 musicFilm"]);
        for (const [index, scene] of value.scenes.entries()) {
          const source = approved.scenes[index]!;
          for (const key of ["musicRange", "syncMode", "lyricLines"] as const) {
            if (source[key] !== undefined && JSON.stringify(scene[key]) !== JSON.stringify(source[key])) rejected([`场次 ${scene.sceneId} 的 ${key} 须沿用已采用剧本；调整音乐编排请先更新故事版本`]);
          }
        }
      }
      return approved;
    }
    const tools: ToolDefinition[] = [
      {
        name: "saveSceneList",
        label: "保存场次表",
        executionMode: "sequential",
        description: "保存剧本的结构化场次表。人物、场景、道具、服装各自给固定 id，场次只引用 id；服务端校验 id 唯一、引用存在、场次连续编号和体量上限。保存为新版本，旧版本移入历史。",
        parameters: z.toJSONSchema(sceneListSchema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal) {
          signal?.throwIfAborted();
          const { value, issues } = validateSceneList(params);
          if (!value) rejected(issues);
          await checkStory(value);
          const previous = await readSaved(files);
          if (previous) {
            await files.mkdir(historyDirectory, true);
            await files.writeFile(`${historyDirectory}/v${previous.version}.json`, JSON.stringify(previous, null, 2));
          }
          const saved: SavedSceneList = { schemaVersion: 1, version: (previous?.version ?? 0) + 1, savedAt: new Date().toISOString(), ...value };
          await files.writeFile(sceneListPath, JSON.stringify(saved, null, 2));
          return json({ saved: sceneListPath, version: saved.version, scenes: saved.scenes.length, characters: saved.characters.length, locations: saved.locations.length,
            note: previous ? `旧版本已移到 ${historyDirectory}/v${previous.version}.json；已有拆解清单需按新版本重新拆解` : undefined });
        },
      },
      {
        name: "readSceneList",
        label: "读取场次表",
        description: "读取场次表及 version，并附已采用版本的 storyContext 与逐场 story 正文、目标、阻碍、变化、因果和音乐段落，供拆解和分镜使用。附加故事字段只读，不传回 saveSceneList；needsUpdate 时先更新场次表。",
        parameters: z.toJSONSchema(z.object({}), { io: "input", target: "draft-07" }),
        async execute() {
          const saved = await readSaved(files);
          if (saved) {
            try {
              const approved = await checkStory(saved);
              if (approved) return json({
                ...saved,
                storyContext: { revisionId: approved.id, title: approved.title, outline: approved.outline, canon: approved.canon, threads: approved.threads },
                // ACT: 从采用版本即时关联正文，不在场次表再存一份可能过期的故事。
                scenes: saved.scenes.map((scene, index) => ({ ...scene, story: approved.scenes[index] })),
              });
            }
            catch (cause) { return json({ ...saved, needsUpdate: true, reason: cause instanceof Error ? cause.message : "故事版本已改变" }); }
          }
          return json(saved ?? { saved: false, message: "还没有场次表，请先用 saveSceneList 保存" });
        },
      },
      {
        name: "saveBreakdown",
        label: "保存拆解清单",
        executionMode: "sequential",
        description: "保存剧本拆解清单。每项资产用 entityId 引用场次表实体，出场场次自动从场次表推导；场次表里的每个实体都必须拆成资产或在 skipped 写明理由。",
        parameters: z.toJSONSchema(breakdownSchema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal) {
          signal?.throwIfAborted();
          const sceneList = await readSaved(files);
          if (!sceneList) rejected(["还没有场次表，请先用 saveSceneList 保存场次表"]);
          await checkStory(sceneList);
          const { value, issues } = validateBreakdown(params, sceneList);
          if (!value) rejected(issues);
          await files.writeFile(breakdownPath, JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), ...value }, null, 2));
          return json({ saved: breakdownPath, sceneListVersion: value.sceneListVersion, assets: value.assets.length, skipped: value.skipped.length, gaps: value.gaps });
        },
      },
    ];
    if (story) tools.push({
      name: "readStoryProject", label: "读取故事工作台", description: "恢复创作简报、资料理解、方向、故事版本、已采用版本的事实/线索、审稿与预演、真实发布反馈。继续创作前先读。", parameters: z.toJSONSchema(z.object({})),
      async execute() { return json(await story.read()); },
    }, {
      name: "updateStoryProject", label: "更新故事候选", executionMode: "sequential",
      description: "按 readStoryProject 的 version 保存资料理解、创意方向、剧本候选、精确引句审稿或单场改写。采用故事版本请调用 requestStoryApproval，在聊天中显示确认卡片。不得代用户确认资料、采用方向/定稿、处置问题或录入观众反馈。旧版本保留。",
      parameters: z.toJSONSchema(z.object({ expectedVersion: z.number().int().nonnegative(), action: storyActionSchema }), { target: "draft-07", io: "input" }),
      async execute(_id, params) { const input = params as { expectedVersion: number; action: unknown }; return json(await story.apply(input.expectedVersion, input.action)); },
    });
    if (story?.requestApproval) tools.push({
      name: "requestStoryApproval", label: "确认采用故事", executionMode: "sequential",
      description: "审稿完成后调用，在聊天里展示指定故事版本的采用确认卡片并等待用户点击；确认后自动保存采用记录，返回 approved。不要让用户自行去故事工作台寻找按钮。暂不采用、跳过或取消均不授权后续制作。已采用版本不会重复询问。",
      parameters: z.toJSONSchema(storyApprovalSchema, { target: "draft-07", io: "input" }),
      async execute(id, params, signal) {
        const { revisionId } = storyApprovalSchema.parse(params);
        return json(await story.requestApproval!(id, revisionId, signal));
      },
    });
    if (story?.requestDecision) tools.push({
      name: "requestStoryDecision", label: "确认故事创作选择", executionMode: "sequential",
      description: "在聊天中请用户确认资料理解、比较并选择已保存的故事方向，或按展示的理由保留审稿问题。confirmSource 传资料 id；chooseDirection 展示全部候选，不代用户选定；已有方向直接返回，仅用户明确改选时传 reconsider:true；release 传 value 展示并保存用户提供的发布反馈，不执行对外发布；decideIssue 传 reviewId、issueId、reason，理由须展示给用户确认。返回 applied: true 才表示决定已保存；跳过或暂不决定时等待，不循环追问。已有明确决定不重复询问。采用定稿用 requestStoryApproval。",
      parameters: z.toJSONSchema(storyDecisionSchema, { target: "draft-07", io: "input" }),
      async execute(id, params, signal) { return json(await story.requestDecision!(id, storyDecisionSchema.parse(params), signal)); },
    });
    return tools;
  },
};

export default plugin;
