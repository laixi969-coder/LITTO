import { getConfiguredModel } from "@/utils/ai";
import { selectedModel } from "@/utils/modelSelection";

export interface PickCandidate {
  id: string;
  name: string;
  category: string;
  definition: string;
  tone: string;
  composition: string[];
  palette: { hex: string; name: string; ratio: number }[];
}

export interface PickResult {
  id: string;
  why: string;
  likeFilm: string;
}

const SYSTEM = `你是电影摄影指导，负责为一部新片挑选视觉参照导演。
你只能从给定的候选里选，不能编造候选之外的名字。
判断依据是：这部片的题材、空间条件、情绪结构，与该导演的画面组织方式是否同一路数。
必须给出可核对的理由：说清他的光怎么打、空间怎么组织、色块怎么分布，而不是「风格很像」。
同时给出「像他的哪部作品」，用于让人快速确认方向。
只输出 JSON，不要任何解释文字。`;

function candidateLine(candidate: PickCandidate) {
  const colors = candidate.palette.slice(0, 4).map(color => `${color.name}${color.hex}`).join(" ");
  return `- ${candidate.id} ${candidate.name}｜${candidate.category.replace(/^\d+_/, "")}｜${candidate.definition.slice(0, 90)}｜影调 ${candidate.tone}｜构图 ${candidate.composition.slice(0, 4).join("、")}｜主色 ${colors}`;
}

/**
 * 规则粗筛之后，让语言模型按剧本的实际需求再选一次。
 * 规则只能比对字面条件，读不懂「记忆与身份」这种母题跟哪套影像语言同源；
 * 这一步补的正是影史脉络与空间调度层面的判断。
 */
export async function pickDirectors(brief: string, candidates: PickCandidate[], signal?: AbortSignal): Promise<{ picked: PickResult[]; excluded: { id: string; why: string }[] } | null> {
  const choice = selectedModel("text");
  if (!choice?.providerId || !choice?.modelId) return null;
  const configured = getConfiguredModel(choice.providerId, choice.modelId);
  const body = {
    model: configured.model.id,
    temperature: 0.3,
    stream: false,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `剧本或创作意图：${brief}`,
          "",
          "候选导演（只能从中选）：",
          ...candidates.map(candidateLine),
          "",
          "请选出最合适的 3 位，再指出最接近但不应选用的 2 位。",
          '输出格式（严格 JSON）：{"picked":[{"id":"编号","why":"这位导演的哪套影像语言适配该片的哪个具体条件，说清光与空间","likeFilm":"最像他的哪部作品"}],"excluded":[{"id":"编号","why":"为什么这部片不该用他"}]}',
        ].join("\n"),
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
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
    const parsed = JSON.parse(json) as { picked?: PickResult[]; excluded?: { id: string; why: string }[] };
    if (!Array.isArray(parsed.picked) || !parsed.picked.length) return null;
    const known = new Set(candidates.map(candidate => candidate.id));
    return {
      // 模型偶尔会返回候选外的编号，这类结果直接丢弃，不放大成「推荐了一个库里没有的人」。
      picked: parsed.picked.filter(item => known.has(String(item.id).padStart(3, "0")) || known.has(String(item.id))).map(item => ({ ...item, id: String(item.id).padStart(3, "0") })),
      excluded: (Array.isArray(parsed.excluded) ? parsed.excluded : []).filter(item => known.has(String(item.id).padStart(3, "0"))).map(item => ({ ...item, id: String(item.id).padStart(3, "0") })),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
