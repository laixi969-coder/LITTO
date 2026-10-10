import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({
  source: z.string().min(1).max(2 * 1024 * 1024).optional(),
  connection: z.strictObject({ templateId: z.string().min(1).max(96), id: z.string().min(1).max(96), label: z.string().trim().min(1).max(100) }).optional(),
}), async (req, res) => {
  if ((req.body.source === undefined) === (req.body.connection === undefined)) throw Object.assign(new Error("请提供连接信息或供应商文件，不能同时提供"), { status: 400 });
  res.json(success(req.body.connection
    ? await u.mediaProvider.addMediaProviderConnection(req.body.connection)
    : await u.mediaProvider.addMediaProvider(req.body.source)));
});
