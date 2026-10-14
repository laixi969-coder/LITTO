import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1), shotId: z.string().min(1), audioPath: z.string().min(1), videoPath: z.string().min(1), sourceVideoPath: z.string().min(1), inspectionKey: z.string().length(64), fullPlayback: z.literal(true), note: z.string().trim().min(10).max(2000) }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.json(success(await u.mediaLipSync.importSpeechTake(directory, req.body)));
});
