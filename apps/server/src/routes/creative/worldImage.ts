import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { uploadWorldImage } from "@/utils/creative/world";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), image: z.strictObject({ path: z.string().min(1).max(4096), mimeType: z.string().regex(/^image\/[\w.+-]+$/) }) }), async (req, res) => {
  u.creative.assertCreativeAccess();
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.set("Cache-Control", "no-store").json(success({ url: await uploadWorldImage(directory, req.body.image) }));
});
