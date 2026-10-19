import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { recommendDirectors } from "@/utils/media/directorMatch";
import { pickDirectors } from "@/utils/media/directorPick";

export default Router().post("/", validateFields({
  brief: z.string().max(4000).optional(),
  category: z.string().max(40).optional(),
  tone: z.string().max(40).optional(),
  setting: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(8).optional(),
  mode: z.enum(["rule", "smart"]).optional(),
}), async (req, res) => {
  const { brief, category, tone, setting, limit, mode } = req.body;
  if (!brief?.trim() && !category && !tone && !setting) {
    return res.status(400).json(error("至少给一句创作意图、题材、影调或场地条件之一，才能给出有依据的推荐", null, 400));
  }
  const ranked = recommendDirectors({ brief, category, tone, setting, limit: 20 });
  const all = ranked.directors;

  if (mode !== "rule" && brief?.trim()) {
    // 先粗筛到 12 位再交给模型：候选太多判断会变粗，太少又失去比较空间。
    const shortlist = all.slice(0, 12);
    const picked = await pickDirectors(brief, shortlist);
    if (picked?.picked.length) {
      const byId = new Map(all.map(item => [item.id, item]));
      const refined = picked.picked
        .map(item => {
          const base = byId.get(item.id);
          return base ? { ...base, why: item.why, likeFilm: item.likeFilm } : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      if (refined.length) {
        return res.json(success({
          mode: "smart",
          count: refined.length,
          directors: refined,
          excluded: picked.excluded
            .map(item => {
              const base = byId.get(item.id);
              return base ? { name: base.name, category: base.category, why: item.why } : null;
            })
            .filter(Boolean),
          // 保留规则排序，便于核对模型有没有跳出粗筛范围。
          ruleRanking: all.slice(0, 5).map(item => ({ id: item.id, name: item.name, score: item.score })),
        }));
      }
    }
  }

  res.json(success({ mode: "rule", count: all.length, directors: all.slice(0, limit ?? 3), excluded: ranked.excluded }));
});
