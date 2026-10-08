import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { resetModelAvailability } from "@/utils/modelAvailability";
import u from "@/utils";
import { currentTenant } from "@/utils/tenant";

export default Router().post("/", validateFields({ kind: z.enum(["text", "media"]), providerId: z.string().min(1).max(200) }), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (currentTenant()?.role === "VIEWER") throw Object.assign(new Error("只读成员不能重新启用模型"), { status: 403 });
  resetModelAvailability(req.body.kind, req.body.providerId);
  res.json(success(null, "已允许重新尝试；未配置 Key 的模型仍不可选，调用再次失败会重新停用"));
});
