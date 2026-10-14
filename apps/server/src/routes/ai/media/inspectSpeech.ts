import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1), audioPath: z.string().min(1), videoPath: z.string().min(1), sourceVideoPath: z.string().min(1).optional() }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.json(success(await u.mediaLipSync.inspectSpeechSync(directory, req.body.audioPath, req.body.videoPath, undefined, req.body.sourceVideoPath)));
});
