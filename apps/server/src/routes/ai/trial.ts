import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

// 平台试用状态：可用的试用模型与剩余积分，前端据此决定新用户能否直接开始创作。
export default Router().get("/", (_req, res) => {
  res.json(success(u.ai.trialStatus()));
});
