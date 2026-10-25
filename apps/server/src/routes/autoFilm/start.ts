import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), ...u.autoFilm.inputSchema.shape }), async (req, res) => {
  const { directory, ...input } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  res.status(202).json(success(await u.autoFilm.start(cwd, input)));
});
