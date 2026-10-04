import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { currentTenant } from "@/utils/tenant";
import u from "@/utils";

export default Router().post(
  "/",
  validateFields({ directory: z.string().min(1).max(4096), sessionFile: z.string().regex(/^[\w-]+\.jsonl$/) }),
  async (req, res) => {
    if (currentTenant()?.role === "VIEWER") throw Object.assign(new Error("无权停止任务"), { status: 403 });
    const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
    const { path } = await u.workspaceFile.resolveWorkspacePath(directory, `.agent/sessions/${req.body.sessionFile}`);
    const active = u.agent.getActiveAgentSession(path);
    if (active) await active.abort();
    res.json(success({ stopped: !!active }));
  },
);
