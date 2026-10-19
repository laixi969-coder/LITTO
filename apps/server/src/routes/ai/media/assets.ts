import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { writeAtomic } from "@toonflow/file";
import { join } from "node:path";
import u from "@/utils";
import { planAssets, scriptFromWorkspace } from "@/utils/media/assetPlan";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  script: z.string().max(40000).optional(),
}), async (req, res) => {
  const { directory, script } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const text = (script ?? "").trim() || scriptFromWorkspace(cwd);
  if (!text.trim()) return res.status(400).json(error("工作区没有已采用的剧本，也没有传 script，无法拆资产", null, 400));
  const plan = await planAssets(text);
  if (!plan) return res.status(503).json(error("资产拆解需要可用的语言模型，当前没有选中的文本模型或调用失败", null, 503));
  const groups = {
    character: plan.items.filter(item => item.kind === "character"),
    scene: plan.items.filter(item => item.kind === "scene"),
    prop: plan.items.filter(item => item.kind === "prop"),
  };
  // 清单落到工作区，后续 preflight 与分镜阶段都要据此核对资产是否齐。
  await writeAtomic(join(cwd, "assets", "assetPlan.json"), JSON.stringify({
    createdAt: new Date().toISOString(),
    count: plan.items.length,
    items: plan.items,
  }, null, 1)).catch(error => {
    // 写盘失败必须让人看见：清单没落盘，后续 preflight 与分镜阶段就查不到资产。
    throw Object.assign(new Error(`资产清单写入失败：${error instanceof Error ? error.message : String(error)}`), { status: 500 });
  });
  res.json(success({
    count: plan.items.length,
    summary: { character: groups.character.length, scene: groups.scene.length, prop: groups.prop.length },
    items: plan.items,
    // 顺序建议：先出角色卡与场景定场，再出道具，最后才进分镜。
    order: ["character", "scene", "prop"],
    note: "角色卡与场景定场先做并采用，再进分镜；否则每个镜头都会重新选角、重新搭景。",
  }));
});
