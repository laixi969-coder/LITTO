import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { inspectClips, inspectFilm } from "@/utils/media/qc";

const relativePath = z.string().min(1).max(2048).refine(
  value => !/^[\\/]|[:\u0000-\u001f]/.test(value) && value.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含 .. 或空路径段",
);

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  clips: z.array(relativePath).min(1).max(400).optional(),
  file: relativePath.optional(),
  expectedDuration: z.number().positive().optional(),
  palette: z.string().trim().min(1).max(120).optional(),
  headTail: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() })).max(8).optional(),
}), async (req, res) => {
  const { directory, clips, file, expectedDuration, headTail, palette } = req.body;
  if (!clips?.length && !file) return res.status(400).json({ code: 400, data: null, message: "clips 与 file 至少提供一个" });
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const result = file
    ? await inspectFilm(cwd, file, { headTail })
    : await inspectClips(cwd, clips!, { expectedDuration, palette });
  res.json(success(result));
});
