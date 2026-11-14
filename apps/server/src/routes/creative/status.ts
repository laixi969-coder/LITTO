import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), requestId: z.uuid() }, "query"), async (req, res) => {
  u.creative.assertCreativeAccess();
  const directory = await u.workspace.resolveWorkspace(req, String(req.query.directory));
  res.set("Cache-Control", "no-store").json(success(await u.creative.inspectCreative(directory, String(req.query.requestId))));
});
