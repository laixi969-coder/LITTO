import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, String(req.query.directory));
  res.set("Cache-Control", "no-store").json(success(await u.autoFilm.get(cwd)));
});
