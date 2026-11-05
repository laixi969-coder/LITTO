import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ name: z.string().trim().min(1).max(200), description: z.string().max(1000), supplier: z.enum(["default", "byteplus"]).optional() }), async (req, res) => {
  res.json(success(await u.xingsuan.createGroup(req.body.name.trim(), req.body.description, req.body.supplier)));
});
