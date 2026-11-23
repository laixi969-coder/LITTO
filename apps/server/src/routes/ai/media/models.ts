import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";

export default Router().get("/", async (req, res) => {
  const models = await u.mediaGeneration.listMediaModels(req.query.all === "true");
  const api = cloud();
  const tenant = currentTenant();
  const pricing = tenant && api?.modelPermissions(tenant.userId).canManage ? api.setting<Record<string, { perSecond?: number; perCall?: number }>>("pricing", {}) : undefined;
  res.set("Cache-Control", "no-store").json(success(models.map(model => {
    const rate = pricing?.[model.providerId + "/" + model.modelId];
    return pricing && model.type === "video" && rate?.perSecond == null && rate?.perCall == null ? { ...model, canTestUnpriced: true } : model;
  })));
});
