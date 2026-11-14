import { Router } from "express";
import { readFile } from "@toonflow/file";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ id: z.string().regex(/^\d{3}$/).optional() }, "query"), async (req, res) => {
  const indexPath = await u.skillFile.locate("directorPalettes", "index.json");
  const index = z.object({ categories: z.array(z.object({ directors: z.array(z.object({ id: z.string(), name: z.string(), category: z.string(), file: z.string() })) })) }).parse(JSON.parse(await readFile(indexPath.target, "utf8")));
  const entries = index.categories.flatMap(category => category.directors);
  if (!req.query.id) return res.json(success(entries.map(({ id, name, category }) => ({ id, name, category }))));
  const entry = entries.find(item => item.id === req.query.id);
  if (!entry) throw Object.assign(new Error("配色资料不存在"), { status: 404 });
  const path = await u.skillFile.locate("directorPalettes", `palettes/${entry.file}`);
  const asset = z.object({ palette: z.object({ primary: z.array(z.object({ hex: z.string().regex(/^#[\da-f]{6}$/i), ratio: z.number().optional() })).min(1).max(16) }) }).parse(JSON.parse(await readFile(path.target, "utf8")));
  res.json(success({ id: entry.id, name: entry.name, colors: asset.palette.primary.map(item => item.hex), instruction: `参考色彩关系：${asset.palette.primary.map(item => `${item.hex}${item.ratio ? `（${Math.round(item.ratio * 100)}%）` : ""}`).join("、")}。保持当前光源、自然肤色与资产识别色，不附加剧情或人物变化。` }));
});
