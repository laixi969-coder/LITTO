import { createHash } from "node:crypto";
import { readFile } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096), exclusive: z.enum(["true", "false"]).optional() }, "query"), async (req, res) => {
  if (!req.is("application/octet-stream") || (req.body !== undefined && !Buffer.isBuffer(req.body))) {
    throw Object.assign(new Error("请发送文件原始内容"), { status: 400 });
  }
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.query.directory as string, req.query.path as string);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    const content = req.body ?? Buffer.alloc(0);
    const revision = createHash("sha256").update(content).digest("hex");
    const expected = req.get("x-file-revision");
    if (expected !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(expected)) throw Object.assign(new Error("文件版本无效"), { status: 400 });
      const current = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const actual = current === null ? null : createHash("sha256").update(current).digest("hex");
      // 已落盘但响应丢失时，允许相同内容重试；旧快照绝不覆盖其他修改或重新创建已删除文件。
      if (actual !== expected && actual !== revision) throw Object.assign(new Error("文件已在其他页面修改或删除，当前编辑仍保留，请先复制内容并重新打开核对"), { status: 409, code: "ESTALE" });
    }
    await u.workspaceFile.writeWorkspaceFile(path, content, req.query.exclusive === "true");
    res.set("x-file-revision", revision);
  }
  finally { release(); }
  res.json(success());
});
