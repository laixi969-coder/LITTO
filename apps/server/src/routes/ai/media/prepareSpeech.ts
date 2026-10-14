import { Router } from "express";
import { z } from "zod";
import { speechSegmentSchema } from "@toonflow/tool-media-generation/voiceProject";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1), audio: speechSegmentSchema }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.json(success(await u.mediaLipSync.prepareSpeechAudio(directory, req.body.audio)));
});
