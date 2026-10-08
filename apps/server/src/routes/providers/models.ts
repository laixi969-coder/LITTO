import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { isMasked } from "@/utils/secrets";

const router = Router();

export default router.post("/", validateFields({
  apiUrl: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "请填写不含查询参数的 HTTP API 基础地址"),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  apiKey: z.string().max(8192),
  providerId: z.string().max(200).optional(),
}), async (req, res) => {
  const { apiUrl, protocol, providerId } = req.body;
  let apiKey = req.body.apiKey as string;
  if (isMasked(apiKey)) {
    const providers = u.conf.get("settings.customProviders");
    const stored = Array.isArray(providers) ? providers.find(item => item?.id === providerId) : undefined;
    if (!stored || stored.apiUrl !== apiUrl || stored.protocol !== protocol || typeof stored.apiKey !== "string") {
      throw Object.assign(new Error("连接配置已变化，请重新填写 API Key"), { status: 400 });
    }
    apiKey = stored.apiKey;
  }
  try {
    res.json(success(await u.ai.fetchProviderModels({ apiUrl, protocol, apiKey })));
  } catch (error) {
    // Bun 等上游的网络层错误是英文原文，转成用户能据此行动的中文提示（见 describeModelError）。
    throw Object.assign(new Error(u.ai.describeModelError(error instanceof Error ? error.message : String(error))), { status: 502 });
  }
});
