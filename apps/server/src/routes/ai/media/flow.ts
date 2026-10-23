import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { readFlow } from "@/utils/media/flow";

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096),
  // ad / music / drama：三类共用七步，但广告多产品资产、MV 多原曲这一关。
  kind: z.string().trim().max(32).optional(),
}, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  res.set("Cache-Control", "no-store").json(success(await readFlow(cwd, req.query.kind as string | undefined)));
});
