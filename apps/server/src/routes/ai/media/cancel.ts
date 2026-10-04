import { Router } from "express";
import { z } from "zod";
import { imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { cloud } from "@/lib/cloud";
import { authEnabled, currentTenant } from "@/utils/tenant";
import u from "@/utils";

export default Router().post(
  "/",
  validateFields({ directory: z.string().min(1).max(4096), mediaType: z.enum(["image", "video"]), requestId: z.string().uuid() }),
  async (req, res) => {
    if (!authEnabled()) return res.json(success({ jobId: null }));
    const { directory, mediaType, requestId, ...input } = req.body;
    const parsed = (mediaType === "image" ? imageGenerationSchema : videoGenerationSchema).safeParse(input);
    if (!parsed.success) return res.status(400).json(error("生成参数无效", null, 400));
    const cwd = await u.workspace.resolveWorkspace(req, directory);
    // ACT: 同一幂等键找回尚未收到 ID 的请求，排队与取消之间不让 worker 执行。
    const job = await u.mediaJobs.enqueueMedia(cwd, mediaType, parsed.data, requestId);
    const tenant = currentTenant()!;
    const api = cloud()!;
    const state = api.scoped(tenant.workspaceId).get("generation_jobs", job.id, true)!;
    if (["QUEUED", "RUNNING"].includes(state.status)) api.cancelJob(tenant.workspaceId, job.id, tenant.userId);
    res.json(success({ jobId: job.id }));
  },
);
