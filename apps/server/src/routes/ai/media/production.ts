import { Router } from "express";
import { z } from "zod";
import { imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1), shotId: z.string().min(1), kind: z.enum(["image", "video"]),
  request: z.record(z.string(), z.unknown()), requestId: z.string().uuid().optional(), fingerprint: z.string().optional(),
}), async (req, res) => {
  const { shotId, kind, requestId, fingerprint } = req.body;
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const parsed = (kind === "image" ? imageGenerationSchema : videoGenerationSchema).safeParse({ ...req.body.request, prompt: "compile" });
  if (!parsed.success) return res.status(400).json(error("生成参数无效", parsed.error.issues));
  const request = parsed.data;
  const production = await u.mediaJobs.prepareShot(directory, kind, shotId, request);
  if (!requestId) return res.json(success(production));
  if (fingerprint !== production.fingerprint) return res.status(409).json(error("镜头规格已改变，请重新预览", null, 409));
  const tenant = currentTenant()!;
  const job = cloud()!.enqueueWorkspaceMedia({ workspaceId: tenant.workspaceId, userId: tenant.userId,
    projectId: u.mediaJobs.workspaceProject(directory)!, directory, kind, production, requestId,
    // 负面词走独立字段，不拼进提示词正文；种子与抽卡批次一并透传。
    request: { ...request, prompt: production.compiled.prompt },
    negativePrompt: production.compiled.negativePrompt || undefined,
    candidateBatchId: typeof req.body.candidateBatchId === "string" && req.body.candidateBatchId ? req.body.candidateBatchId : undefined,
  });
  res.status(202).json(success({ jobId: job.id }));
});
