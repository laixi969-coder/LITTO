import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ id: z.string().min(1).max(200) }, "query"), async (req, res) => {
  res.json(success(await u.xingsuan.getAsset(req.query.id as string)));
});
