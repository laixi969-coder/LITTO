import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().put("/", validateFields({ providerId: u.creative.providerSchema, apiKey: z.string().trim().min(1).max(4096), baseUrl: z.url().max(2048).optional() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  u.creative.assertCreativeAccess();
  res.set("Cache-Control", "no-store").json(success(await u.creative.saveCreativeConfig(req.body.providerId, req.body.apiKey, req.body.baseUrl)));
});
