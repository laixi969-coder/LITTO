import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";
import { proxyWorld } from "@/utils/creative/world";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), requestId: z.uuid() }, "query"), async (req, res) => {
  u.creative.assertCreativeAccess();
  const directory = await u.workspace.resolveWorkspace(req, String(req.query.directory));
  const target = req.get("x-fal-target-url");
  if (!target) throw Object.assign(new Error("缺少世界协议地址"), { status: 400 });
  const controller = new AbortController();
  const close = () => { if (!res.writableFinished) controller.abort(); };
  res.once("close", close); req.once("aborted", close); req.socket.once("close", close);
  try { res.set("Cache-Control", "no-store").json(await proxyWorld(directory, String(req.query.requestId), target, req.body, controller.signal)); }
  finally { res.off("close", close); req.off("aborted", close); req.socket.off("close", close); }
});
