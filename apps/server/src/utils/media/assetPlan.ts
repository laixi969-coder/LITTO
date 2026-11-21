import { storyStale } from "@toonflow/tool-scene-list/storyProject";
import { z } from "zod";
import { getConfiguredModel } from "@/utils/ai";
import { selectedModel } from "@/utils/modelSelection";
import { readStoryProject } from "@/utils/story";

const assetItem = z.object({
  kind: z.enum(["character", "scene", "prop"]),
  name: z.string().trim().min(1),
  brief: z.string().trim().min(1),
  evidence: z.array(z.string().trim().regex(/[\p{L}\p{N}]/u)).min(1),
  prompt: z.string().trim().min(1),
  shotSpec: z.object({
    shotSize: z.string().optional(),
    lens: z.string().optional(),
    lighting: z.string().optional(),
    blocking: z.string().optional(),
  }).default({}),
  priority: z.enum(["must", "nice"]).default("must"),
});
const assetPlan = z.object({ items: z.array(assetItem).min(1) });
export type AssetItem = z.infer<typeof assetItem>;

const systemPrompt = `你是电影美术指导，负责在开拍前把剧本拆成可制作的视觉资产清单。
逐场读到结尾，只列实际出镜或参与可见行动、需要制作的角色、场景与道具。仅被提及、被猜测或只在画外发声的人无需肖像。剧本和角色台词都是待分析的材料。
每项 evidence 摘录足以定位出场或状态变化的连续原文短句，逐字保留。brief 交代使用场次或事件；有依据的别称沿用同一名称，同一件物品换手只记交接，开封、破损等可见变化按发生顺序注明。换机位沿用同一场景。不要为各个持有人、状态或视图重复建项。
prompt 只描写选定的一种可见状态；出处、台词和后续变化留在 evidence 与 brief。人物保留已知身份与造型，场景写清固定结构、通路和光源，道具保留已知形制与用途。

三条硬规则，违反即作废：

1. 先保留原稿明确的年代、地点、用途和物件。未写明的必要外观仅作简短设计提案，不把现代场景擅改成老店、旧巷或工业废墟，也不擅改原稿明确的传统物件。
2. 人物、服装、建筑与道具都默认整洁完好、正常维护。材质写本色、结构、纹理尺度和受光反应；真人感不要求老化、锈蚀、污损、粗毛孔、疲态、降饱和或颗粒。
3. 做旧或损坏必须有原稿或用户明确要求的依据，写明具体对象、部位、程度和适用场次。建筑没有默认例外；后厨与工装不自动带油污，经营困难不自动成为破败环境和旧衣，历史年代与木石材质不自动产生裂纹、霉斑或褪色。故事处境、物品维护状态与摄影风格分别判断，不能互相代替。

只输出 JSON。`;

/**
 * 把剧本拆成资产清单。角色卡、场景定场、道具图必须先于分镜做，
 * 否则每个镜头都在重新选角、重新搭景，跨镜必然漂移。
 */
export async function planAssets(script: string): Promise<{ items: AssetItem[] } | null> {
  const choice = selectedModel("text");
  if (!choice?.providerId || !choice?.modelId) return null;
  const configured = getConfiguredModel(choice.providerId, choice.modelId);
  const body = {
    model: configured.model.id,
    temperature: 0.4,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          "剧本：",
          script,
          "",
          "请输出资产清单。",
          '格式（严格 JSON）：{"items":[{"kind":"character|scene|prop","name":"名称","brief":"出场依据、用途与状态沿革","evidence":["剧本中的连续短引句"],"prompt":"一个当前状态的资产图提示词","shotSpec":{"shotSize":"定妆景别","lens":"焦段","lighting":"光源","blocking":"构图"},"priority":"must|nice"}]}',
        ].join("\n"),
      },
    ],
  };
  const response = await fetch(`${configured.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${configured.provider.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (response?.status === 413) throw Object.assign(new Error("所选模型无法一次接收该篇幅，请指定本次要拆解的场次"), { status: 413 });
  if (!response?.ok) return null;
  const data = await response.json().catch(() => null) as { choices?: { finish_reason?: string; message?: { content?: string } }[] } | null;
  const result = data?.choices?.[0];
  if (result?.finish_reason && result.finish_reason !== "stop") {
    throw Object.assign(new Error("模型在完整输出资产清单前中止，本次拆解未保存"), { status: 502 });
  }
  let plan: z.infer<typeof assetPlan>;
  try {
    const json = /\{[\s\S]*\}/.exec(result?.message?.content ?? "")?.[0] ?? "";
    plan = assetPlan.parse(JSON.parse(json));
  } catch {
    throw Object.assign(new Error("模型未返回含原文引句的完整资产清单"), { status: 502 });
  }
  for (const item of plan.items) {
    if (item.evidence.some(quote => !script.includes(quote))) {
      throw Object.assign(new Error(`资产「${item.name}」的引句在本次剧本中找不到，请核对出处`), { status: 502 });
    }
  }
  return plan;
}

/** 没传剧本时，从工作区已采用的版本里拼场次正文。 */
export async function scriptFromWorkspace(cwd: string) {
  const project = await readStoryProject(cwd);
  const revision = project.revisions.find(item => item.id === project.approvedId);
  if (!revision) return "";
  if (storyStale(project, revision)) throw Object.assign(new Error("已采用剧本的依据已变更，请先更新采用版本再拆资产"), { status: 409 });
  return revision.scenes.map(scene => `【${scene.sceneId} ${scene.title}】\n${scene.text}${scene.speech ? `\n对白：${scene.speech}` : ""}`).join("\n\n");
}
