import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", (_req, res) => {
  u.creative.assertCreativeAccess();
  res.set("Cache-Control", "no-store").json(success(u.creative.creativeProviders()));
});
