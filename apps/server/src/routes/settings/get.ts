import { createHash } from "node:crypto";
import u from "@/utils";
import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { maskSecrets } from "@/utils/secrets";

const router = Router();

export default router.get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  const settings = u.conf.get("settings", {});
  res.set("x-settings-revision", createHash("sha256").update(JSON.stringify(settings)).digest("hex"));
  res.json(success(maskSecrets(settings)));
});
