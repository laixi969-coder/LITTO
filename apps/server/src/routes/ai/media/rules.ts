import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { ruleUsage } from "@/utils/media/ruleUsage";

export default Router().post("/", validateFields({
  limit: z.number().int().min(10).max(500).optional(),
}), async (req, res) => {
  res.json(success(ruleUsage(req.body.limit)));
});
