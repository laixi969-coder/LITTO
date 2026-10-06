import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default Router().get("/", (_req, res) => {
  res.json(success(u.transcription.transcriptionStatus()));
});
