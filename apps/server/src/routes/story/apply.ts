import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), expectedVersion: z.number().int().nonnegative(), action: z.record(z.string(), z.unknown()) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.json(success(await u.story.applyStoryAction(directory, req.body.expectedVersion, req.body.action, true)));
});
