import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { preflight } from "@/utils/media/preflight";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  shotSpec: z.record(z.string(), z.string()).optional(),
  clips: z.array(z.string().min(1).max(2048)).max(400).optional(),
}), async (req, res) => {
  const { directory, shotSpec, clips } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  res.json(success(await preflight(cwd, { shotSpec, clips })));
});
