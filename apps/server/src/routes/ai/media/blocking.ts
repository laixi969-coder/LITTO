import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { currentTenant } from "@/utils/tenant";
import { buildBlocking } from "@/utils/media/blocking";

const personSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  faceTo: z.string().trim().max(40).optional(),
  facing: z.number().min(-360).max(360).optional(),
  note: z.string().max(200).optional(),
});

const cameraSchema = z.strictObject({
  id: z.string().trim().min(1).max(20),
  x: z.number().min(-10).max(1000),
  y: z.number().min(-10).max(1000),
  target: z.union([z.string().trim().min(1).max(40), z.tuple([z.number(), z.number()])]),
  shotSize: z.string().trim().max(20).optional(),
  foreground: z.string().trim().max(40).optional(),
  note: z.string().max(200).optional(),
});

/**
 * 场次走位板：摆定人和机位，出一张俯视图、每镜的空间描述、以及跳轴判定。
 * 这是生成之前该做的一步——空间没定，关键帧每次给的左右都可能反。
 */
export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  scene: z.strictObject({
    name: z.string().trim().min(1).max(60),
    width: z.number().positive().max(200),
    depth: z.number().positive().max(200),
    people: z.array(personSchema).min(2).max(40),
    cameras: z.array(cameraSchema).min(1).max(40),
    axis: z.tuple([z.string().trim().min(1).max(40), z.string().trim().min(1).max(40)]).optional(),
    props: z.array(z.strictObject({
      label: z.string().trim().max(40),
      x: z.number(), y: z.number(),
      w: z.number().positive().max(100), h: z.number().positive().max(100),
      round: z.boolean().optional(),
    })).max(60).optional(),
  }),
  outputDirectory: z.string().trim().max(200).optional(),
  save: z.boolean().optional(),
}), async (req, res) => {
  if (currentTenant()?.role === "VIEWER" && req.body.save !== false) return res.status(403).json(error("只读成员不能写入工作区", null, 403));
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const result = await buildBlocking(cwd, req.body);
  res.json(success(result));
});
