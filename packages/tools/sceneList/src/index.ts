import { z } from "zod";
import type { ToolDefinition, ToolFiles, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { breakdownSchema, sceneListSchema, validateBreakdown, validateSceneList, type SceneList } from "./schema";

const sceneListPath = "场次表.json";
const historyDirectory = "场次表历史";
const breakdownPath = "拆解清单.json";

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
  createTools({ files }) {
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
        description: "读取当前保存的场次表及其 version。拆解前先读取，拆解时引用其中的实体 id 和 version。",
        parameters: z.toJSONSchema(z.object({}), { io: "input", target: "draft-07" }),
        async execute() {
          const saved = await readSaved(files);
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
          const { value, issues } = validateBreakdown(params, sceneList);
          if (!value) rejected(issues);
          await files.writeFile(breakdownPath, JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), ...value }, null, 2));
          return json({ saved: breakdownPath, sceneListVersion: value.sceneListVersion, assets: value.assets.length, skipped: value.skipped.length, gaps: value.gaps });
        },
      },
    ];
    return tools;
  },
};

export default plugin;
