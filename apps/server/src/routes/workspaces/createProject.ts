import { Router } from "express";
import { mkdir, realpath } from "@toonflow/file";
import { join } from "node:path";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { workspacesRoot } from "@/utils/tenant";

const router = Router();

/** Accounts mode: users never pick folders. A project is a sub-directory of the caller's own workspace root, created here. */
export default router.post("/", validateFields({ name: z.string().max(80).optional() }), async (req, res) => {
  const root = workspacesRoot();
  await mkdir(root, { recursive: true });
  const base = (req.body.name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "未命名项目";
  for (let n = 0; n < 50; n++) {
    const directory = join(root, n ? `${base} ${n + 1}` : base);
    try {
      await mkdir(directory, { recursive: false });
      return res.json(success({ directory: await realpath(directory), name: n ? `${base} ${n + 1}` : base }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  res.status(409).json(error("同名项目过多，请换个名字", null, 409));
});
