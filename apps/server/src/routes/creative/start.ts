import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), providerId: u.creative.providerSchema, requestId: z.uuid(), input: u.creative.inputSchema }), async (req, res) => {
  u.creative.assertCreativeAccess();
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.set("Cache-Control", "no-store").json(success(await u.creative.startCreative(directory, req.body.providerId, req.body.requestId, u.creative.inputSchema.parse(req.body.input))));
});
