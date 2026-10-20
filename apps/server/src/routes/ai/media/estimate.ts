import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { dailySpend, estimateSpend } from "@/utils/media/spend";

const shotSchema = z.strictObject({
  providerId: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(200),
  duration: z.number().positive().max(3600),
  resolution: z.string().trim().max(40).optional(),
});

/**
 * 批量生成前先报价：这一批多少条、多少秒、按当前单价大约多少积分，以及最近 24 小时已经烧掉多少。
 * 报价不改任何状态，只回答「点下去要花多少」，避免一次跑完才发现额度空了。
 */
export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096).optional(),
  shots: z.array(shotSchema).min(1).max(2000),
}), async (req, res) => {
  const cwd = req.body.directory ? await u.workspace.resolveWorkspace(req, req.body.directory) : undefined;
  const estimate = estimateSpend(req.body.shots);
  const daily = await dailySpend(cwd).catch(() => null);
  res.json(success({
    estimate,
    daily,
    warning: estimate.credits && daily && estimate.credits > daily.credits
      ? `这一批的估算（${estimate.credits} 积分）已经超过最近 24 小时的总消耗（${daily.credits} 积分），提交前确认额度够`
      : null,
  }));
});
