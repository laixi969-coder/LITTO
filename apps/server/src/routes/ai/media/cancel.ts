import { Router } from "express";
import { z } from "zod";
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
    const { directory, mediaType, requestId } = req.body;
    const cwd = await u.workspace.resolveWorkspace(req, directory);
    const tenant = currentTenant()!;
    const api = cloud()!;
    if (tenant.role === "VIEWER") return res.status(403).json(error("无权取消生成任务", null, 403));
    const key = "workspaceMedia:" + requestId;
    const receipt = api.dbGet("SELECT response FROM idempotency_keys WHERE workspace_id=? AND key=?", tenant.workspaceId, key);
    if (!receipt) {
      // ACT: 取消先于入队时保存终止标记，迟到的生成请求读取标记后停止，不为取消而创建任务。
      api.dbRun("INSERT INTO idempotency_keys VALUES(?,?,?,?)", key, tenant.workspaceId, JSON.stringify({ cancelled: true }), new Date().toISOString());
      return res.json(success({ jobId: null }));
    }
    const saved = JSON.parse(receipt.response);
    if (saved.cancelled) return res.json(success({ jobId: null }));
    const state = api.scoped(tenant.workspaceId).get("generation_jobs", saved.id, true);
    if (!state || state.parameters?.directory !== cwd || state.kind !== mediaType) return res.status(409).json(error("请求 ID 与原生成任务不一致", null, 409));
    if (!saved.reused && ["QUEUED", "RUNNING"].includes(state.status)) api.cancelJob(tenant.workspaceId, state.id, tenant.userId);
    res.json(success({ jobId: state.id }));
  },
);
