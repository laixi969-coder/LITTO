import { readFileSync } from "node:fs";
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

const SYSTEM = `你是电影美术指导，负责在开拍前把剧本拆成可制作的视觉资产清单。
只提取剧本明确写到的角色、场景与道具，不发明没有出现的东西。
角色写清年龄、体态、发型、服装面料与版型；场景写清空间结构、材质、光源与时间；道具写清形状、尺寸、材质与在剧情里的作用。
每个资产给出一条可直接用于生成的提示词，以及这个资产该用什么镜头拍成定妆图。

三条硬规则，违反即作废：

1. 按故事年代写当代物件。2026 年的年轻电工用的是 LED 灯管、全面屏手机、尼龙工具包、锂电池电钻、铝合金窗、化纤混纺工装；不要写搪瓷杯、白炽灯、木格窗、帆布包、老式闸刀开关、搪瓷脸盆这些过时物件。
2. 默认干净完整。服装平整、皮肤干净、道具无油污锈斑汗渍。不主动添加「脏、旧、破、锈、汗湿、剥落、污渍」这类状态描述；剧本没写就不要加。
3. 旧只属于建筑本身——楼龄、墙面老化、管线陈旧可以写，但不扩散到人物的衣服、随身工具与日用品。只有剧本明确要求的破败场景才写脏旧，且只影响该对象。

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
      { role: "system", content: SYSTEM },
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
