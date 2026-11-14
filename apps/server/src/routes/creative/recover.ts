import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), requestId: z.uuid(), remoteId: z.string().min(1).max(200), ownerId: z.string().min(1).max(100).optional() }), async (req, res) => {
  u.creative.assertCreativeAccess();
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.set("Cache-Control", "no-store").json(success(await u.creative.recoverCreative(directory, req.body.requestId, req.body.remoteId, req.body.ownerId)));
});
