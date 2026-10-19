import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import conf from "@/utils/conf";

interface PaletteColor {
  hex: string;
  name: string;
  ratio: number;
}

interface DirectorRecord {
  id: string;
  name: string;
  nameEn: string;
  category: string;
  nationality: string;
  years: string;
  palette: { primary: PaletteColor[]; emotional: { hex: string; name: string; emotion: string }[] };
  lighting: Record<string, string>;
  composition: string[];
  colorKeywords: string[];
  mood: string[];
  profile: Record<string, string>;
}

export interface MatchInput {
  /** 剧本梗概、场次描述或一句创作意图 */
  brief?: string;
  /** 题材方向，取自 10 个分类的短名，如 黑色悬疑／霓虹赛博 */
  category?: string;
  /** 影调偏好：冷 / 暖 / 高饱和 / 低饱和 / 高对比 */
  tone?: string;
  /** 已定摄影条件，如 夜景／日景／室内／工业 */
  setting?: string;
  limit?: number;
}

let cache: { records: DirectorRecord[]; at: number } | null = null;

function paletteDirectory() {
  return join(dirname(conf.path), "skills", "directorPalettes", "palettes");
}

function loadAll(): DirectorRecord[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.records;
  const directory = paletteDirectory();
  const index = JSON.parse(readFileSync(join(directory, "..", "index.json"), "utf8")) as { categories: { directors: { file: string }[] }[] };
  const records: DirectorRecord[] = [];
  for (const category of index.categories) {
    for (const entry of category.directors) {
      try {
        records.push(JSON.parse(readFileSync(join(directory, entry.file), "utf8")) as DirectorRecord);
      } catch { /* 单个损坏不影响整体推荐 */ }
    }
  }
  cache = { records, at: Date.now() };
  return records;
}

const CATEGORY_HINTS: { match: RegExp; category: string; weight: number }[] = [
  { match: /悬疑|犯罪|惊悚|谋杀|秘密|审讯|调查|黑帮|背叛|罪|追查|阴谋|真相|凶手|证词/, category: "黑色悬疑与冷调惊悚", weight: 42 },
  { match: /赛博|未来|科技|霓虹|机器人|反乌托邦|能源|数据|系统|废墟|金属|管廊|库廊|舱|终端|城市夜景|义体|2140|2150|20\d\d|21\d\d|纪元|殖民地|太空/, category: "霓虹黑色与赛博未来", weight: 44 },
  { match: /乡村|田野|自然|大地|农场|山路|河流|季节|麦田|林间|牧/, category: "大地暖调与自然光诗意", weight: 42 },
  { match: /极简|静观|长镜|空房|留白|孤独|日常|独处|沉默|等待/, category: "极简冷构与静观长镜", weight: 36 },
  { match: /宫廷|华丽|巴洛克|奢靡|宴会|教堂|歌剧|烛|绸缎|盛大/, category: "巴洛克华丽与浓墨重彩", weight: 42 },
  { match: /梦|超现实|幻觉|畸变|心理|潜意识|荒诞|错乱|扭曲/, category: "超现实梦幻与心理畸变", weight: 42 },
  { match: /战争|史诗|动作|追车|爆炸|军团|战场|搏斗|交火|枪战|战斗|冲突|对峙|追捕/, category: "动作史诗与高饱和色彩", weight: 42 },
  { match: /动画|奇幻|神话|童话|异想|魔法|精灵|传说/, category: "动画奇幻与异想视觉", weight: 42 },
  { match: /爱情|浪漫|柔光|复古|怀旧|青春|回忆|初恋|告白/, category: "浪漫柔光与复古色调", weight: 42 },
  { match: /东方|留白|禅|庭院|山水|和室|茶|蓑|烟雨|墨/, category: "东方美学与留白意境", weight: 42 },
];

const TONE_HINTS: { match: RegExp; keyword: string }[] = [
  { match: /冷|冷峻|凛冽|疏离|克制/, keyword: "冷调" },
  { match: /暖|温暖|柔和|怀旧|亲密/, keyword: "暖调" },
  { match: /高饱和|浓烈|艳丽|张扬/, keyword: "高饱和" },
  { match: /低饱和|灰|褪色|朴素|素净/, keyword: "低饱和" },
  { match: /高对比|强反差|硬光|戏剧性/, keyword: "高对比" },
];

function overlaps(haystack: string[], needles: string[]) {
  let hits = 0;
  for (const needle of needles) {
    if (!needle) continue;
    if (haystack.some(item => item.includes(needle) || needle.includes(item))) hits += 1;
  }
  return hits;
}

/**
 * 从 198 位里挑出最贴合的三位。
 * 依据是题材、影调偏好、场地条件与文本关键词，四条各自计分并在 reasons 里写明来由，
 * 让选择有依据可核，而不是随机抽一个名字。
 */
export function recommendDirectors(input: MatchInput) {
  const records = loadAll();
  const brief = (input.brief ?? "").trim();
  const limit = Math.min(Math.max(input.limit ?? 3, 1), 8);

  // 按命中的关键词数量排序：一句梗概里出现「能源」「管廊」「2140」三个科幻信号，
  // 比只出现一个「秘密」更能说明这部片属于哪一类。
  const countHits = (pattern: RegExp, text: string) => (text.match(new RegExp(pattern.source, "g")) ?? []).length;
  const inferred = CATEGORY_HINTS
    .map(item => ({ ...item, hits: countHits(item.match, brief) }))
    .filter(item => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.weight - a.weight);
  const declared = input.category ? CATEGORY_HINTS.find(item => input.category!.includes(item.category)) : undefined;
  const tones = TONE_HINTS.filter(item => item.match.test(`${input.tone ?? ""} ${brief}`)).map(item => item.keyword);

  const scored = records.map(record => {
    let score = 0;
    const reasons: string[] = [];

    if (declared && record.category.includes(declared.category)) {
      score += declared.weight + 12;
      reasons.push(`指定题材「${declared.category}」`);
    } else {
      const hits = inferred.filter(item => record.category.includes(item.category));
      if (hits.length) {
        // 题材是门槛而不是加分项：主题材命中的直接进第一梯队，次题材只作补充，
        // 否则「夜景」「冷调」这类通用加分会把真正对口的导演挤下去。
        const primary = inferred[0];
        const isPrimary = hits.some(item => item.category === primary.category);
        score += isPrimary ? 100 + Math.min(primary.hits, 5) * 4 : 30;
        const label = (value: string) => value.replace(/^\d+_/, "");
        reasons.push(isPrimary
          ? `主题材「${label(primary.category)}」，文本出现 ${primary.hits} 个题材信号`
          : `次题材「${label(hits[0].category)}」`);
      }
    }

    const toneText = record.lighting.overall_tone ?? "";
    const toneHits = tones.filter(keyword => toneText.includes(keyword));
    if (toneHits.length) {
      score += toneHits.length * 12;
      reasons.push(`影调偏${toneHits.join("、")}`);
    }

    if (input.setting) {
      const pools = [...record.composition, ...record.colorKeywords, record.lighting.key_light ?? "", record.lighting.shadow_tint ?? ""];
      if (overlaps(pools, [input.setting])) {
        score += 15;
        reasons.push(`构图与光影适配「${input.setting}」`);
      }
    }

    if (brief) {
      const keywords = brief.split(/[\s，。、；：！？,.;:!?]+/).filter(word => word.length >= 2);
      const moodHits = overlaps(record.mood, keywords);
      const colorHits = overlaps(record.colorKeywords, keywords);
      const compHits = overlaps(record.composition, keywords);
      const hits = moodHits + colorHits + compHits;
      if (hits) {
        score += Math.min(hits * 8, 36);
        const matched = [
          ...record.mood.filter(item => keywords.some(word => item.includes(word) || word.includes(item))),
          ...record.colorKeywords.filter(item => keywords.some(word => item.includes(word) || word.includes(item))),
        ].slice(0, 3);
        reasons.push(matched.length ? `气质贴合：${matched.join("、")}` : `与文本共享 ${hits} 个气质词`);
      }
    }

    // 理由要落到可执行的技术条件，而不是「影调偏冷调」这种谁都能说的话。
    const light = record.lighting;
    const technical = [
      light.key_light ? `主光 ${light.key_light}` : "",
      light.highlight_tint ? `高光 ${light.highlight_tint}` : "",
      light.shadow_tint ? `暗部 ${light.shadow_tint}` : "",
      light.contrast_ratio ? `对比 ${light.contrast_ratio}` : "",
    ].filter(Boolean);

    return {
      id: record.id,
      name: record.name,
      nameEn: record.nameEn,
      category: record.category,
      score,
      reasons,
      technical,
      palette: record.palette.primary.slice(0, 6),
      emotional: record.palette.emotional.slice(0, 4),
      composition: record.composition.slice(0, 6),
      tone: light.overall_tone ?? "",
      definition: record.profile.definition ?? "",
      avoid: record.profile.avoid ?? "",
    };
  });

  // 同分时优先对比度更高的，冷调夜戏比柔光平调更耐看，避免并列按编号随机。
  const contrastRank = (item: { tone: string }) => /高对比|75|80|90|强反差/.test(item.tone) ? 1 : 0;
  const ranked = scored
    .sort((a, b) => b.score - a.score || contrastRank(b) - contrastRank(a) || a.id.localeCompare(b.id))
    .map(item => ({ ...item, score: Math.round(item.score) }));

  // 专业的选择不只给推荐，还要说清「为什么不是另一位」——排除理由比推荐理由更能帮用户确认方向。
  const picked = ranked.slice(0, limit);
  const excluded = ranked.slice(limit, limit + 2).map(item => ({
    name: item.name,
    category: item.category,
    score: item.score,
    why: (() => {
      const gap = (picked[picked.length - 1]?.score ?? 0) - item.score;
      if (gap <= 4) return `分数与入选者几乎持平，差别在影调：他是「${item.tone || "未标注"}」，入选者更贴近你给的${input.tone ?? "整体气质"}`;
      if (item.category !== picked[0]?.category) return "题材不同类，除非你要混类型，否则不选";
      return "同题材但光影条件不符，他的对比与色温跟这部片的场地条件不合";
    })(),
  }));

  return { directors: picked, excluded };
}
