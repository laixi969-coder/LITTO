import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", (req, res) => {
  res.set("Cache-Control", "no-store").json(success(u.ai.listAiModels(req.query.all === "true")));
});
