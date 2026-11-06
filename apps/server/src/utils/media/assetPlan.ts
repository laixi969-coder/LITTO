import { readFileSync } from "@toonflow/file";
import { join } from "node:path";
import { getConfiguredModel } from "@/utils/ai";
import { selectedModel } from "@/utils/modelSelection";

export interface AssetItem {
  kind: "character" | "scene" | "prop";
  name: string;
  brief: string;
  /** 定妆/定场镜头该怎么拍，直接可用的提示词 */
  prompt: string;
  shotSpec: { shotSize?: string; lens?: string; lighting?: string; blocking?: string };
  priority: "must" | "nice";
}

const systemPrompt = `你是电影美术指导，负责在开拍前把剧本拆成可制作的视觉资产清单。
只提取剧本明确写到的角色、场景与道具，不发明没有出现的东西。
角色写清年龄、体态、发型、服装面料与版型；场景写清空间结构、材质、光源与时间；道具写清形状、尺寸、材质与在剧情里的作用。
每个资产给出一条可直接用于生成的提示词，以及这个资产该用什么镜头拍成定妆图。

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
          script.slice(0, 12000),
          "",
          "请输出资产清单。",
          '格式（严格 JSON）：{"items":[{"kind":"character|scene|prop","name":"名称","brief":"一句话描述外观与用途","prompt":"可直接用于生成的完整提示词，写清材质、光源、状态","shotSpec":{"shotSize":"定妆用什么景别","lens":"焦段","lighting":"光怎么打","blocking":"人物在画面里怎么站"},"priority":"must|nice"}]}',
        ].join("\n"),
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${configured.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${configured.provider.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "";
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!json) return null;
    const parsed = JSON.parse(json) as { items?: AssetItem[] };
    if (!Array.isArray(parsed.items) || !parsed.items.length) return null;
    return {
      items: parsed.items
        .filter(item => ["character", "scene", "prop"].includes(item.kind) && item.name && item.prompt)
        .map(item => ({ ...item, shotSpec: item.shotSpec ?? {}, priority: item.priority === "nice" ? "nice" : "must" })),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 没传剧本时，从工作区已采用的版本里拼场次正文。 */
export function scriptFromWorkspace(cwd: string) {
  try {
    const project = JSON.parse(readFileSync(join(cwd, "storyProject.json"), "utf8")) as {
      approvedId?: string;
      revisions?: { id: string; scenes?: { title?: string; text?: string; speech?: string }[] }[];
    };
    const revision = project.revisions?.find(item => item.id === project.approvedId) ?? project.revisions?.[0];
    if (!revision?.scenes?.length) return "";
    return revision.scenes.map(scene => `【${scene.title ?? ""}】\n${scene.text ?? ""}${scene.speech ? `\n对白：${scene.speech}` : ""}`).join("\n\n");
  } catch {
    return "";
  }
}
