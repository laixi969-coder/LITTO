import { Router, raw } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", raw({ type: "application/octet-stream", limit: "20mb" }), validateFields({
  source: z.enum(["server", "custom"]).optional(),
  providerId: z.string().min(1).max(200).optional(), model: z.string().min(1).max(200).regex(/^[\w./:-]+$/).optional(),
}, "query"), async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error("请发送音频原始内容"), { status: 400 });
  const source = req.query.source === "server" ? "server" : "custom";
  if (source === "custom" && (!req.query.providerId || !req.query.model)) throw Object.assign(new Error("请选择供应商和转写模型"), { status: 400 });
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on("close", abort);
  try {
    const result = await u.transcription.transcribeMusic(req.body, req.query.providerId as string ?? "", req.query.model as string ?? "", controller.signal, source);
    res.json(success(result));
  } finally { res.off("close", abort); }
});
