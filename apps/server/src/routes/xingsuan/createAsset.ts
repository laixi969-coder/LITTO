import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ groupId: z.string().min(1).max(200), name: z.string().trim().min(1).max(200), url: z.url({ protocol: /^https?$/ }).max(4096), type: z.enum(["Image", "Video"]) }), async (req, res) => {
  res.json(success(await u.xingsuan.createAsset(req.body.groupId, req.body.name.trim(), req.body.url, req.body.type)));
});
