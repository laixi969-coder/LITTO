import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { registerImported } from "@/utils/media/assetSheet";

/**
 * 导入已有角色/场景/道具：用户手上已经有图，就不该再花一次额度重生成。
 * 登记后与生成的资产完全同构，分镜图与视频用 cast 传名字即可引用。
 */
export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  kind: z.enum(["character", "scene", "prop"]),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(4000).optional(),
  wardrobe: z.string().trim().max(2000).optional(),
  images: z.array(z.string().trim().min(1).max(2048)).min(1).max(15),
}), async (req, res) => {
  const { directory, kind, name, description, wardrobe, images } = req.body as {
    directory: string; kind: "character" | "scene" | "prop"; name: string;
    description?: string; wardrobe?: string; images: string[];
  };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const result = await registerImported(cwd, { kind, name, description, wardrobe, images });
  res.json(success({
    ...result,
    note: "导入的资产不进生成队列、不消耗额度；要补其他角度时用 POST /api/ai/media/assetSheet（reference 指向这张图）",
  }));
});
