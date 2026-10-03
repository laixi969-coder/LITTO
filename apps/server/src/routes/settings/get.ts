import u from "@/utils";
import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { maskSecrets } from "@/utils/secrets";

const router = Router();

export default router.get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  res.json(success(maskSecrets(u.conf.get("settings", {}))));
});
