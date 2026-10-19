import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { composeFilm } from "@/utils/media/compose";
import { currentTenant } from "@/utils/tenant";

const relativePath = z.string().min(1).max(2048).refine(
  value => !/^[\\/]|[:\u0000-\u001f]/.test(value) && value.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含 .. 或空路径段",
);

const gradeSchema = z.strictObject({
  contrast: z.number().min(0.5).max(2).optional(),
  saturation: z.number().min(0).max(2).optional(),
  brightness: z.number().min(-1).max(1).optional(),
  grain: z.number().min(0).max(40).optional(),
}).optional();

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  clips: z.array(relativePath).min(1).max(400),
  output: relativePath,
  grade: gradeSchema,
  film: z.strictObject({
    bloom: z.number().min(0).max(0.25).optional(),
    aberration: z.number().min(0).max(3).optional(),
    grain: z.number().min(0).max(12).optional(),
  }).optional(),
  targetLufs: z.number().min(-40).max(-5).optional(),
  headTail: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() })).max(8).optional(),
  verify: z.boolean().optional(),
}), async (req, res) => {
  if (currentTenant()?.role === "VIEWER") return res.status(403).json(error("只读成员不能合成成片", null, 403));
  const { directory, clips, output, grade, film, targetLufs, headTail, verify } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  res.json(success(await composeFilm(cwd, { clips, output, grade, film, targetLufs, headTail, verify })));
});
