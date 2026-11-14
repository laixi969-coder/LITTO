import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const schema = z.strictObject({ directory: z.string().min(1).max(4096), providerId: u.creative.providerSchema, operation: z.enum(["runningHub", "mesh", "upscale", "texture"]), mode: z.enum(["app", "workflow"]).optional(), workflowId: z.string().regex(/^\d{1,32}$/).optional() });
export default Router().post("/", validateFields(schema.shape), async (req, res) => {
  u.creative.assertCreativeAccess();
  const input = schema.parse(req.body);
  if (input.operation === "runningHub" && (!input.mode || !input.workflowId)) throw Object.assign(new Error("请选择RH应用或工作流并填写ID"), { status: 400 });
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  res.set("Cache-Control", "no-store").json(success(await u.creative.describeCreative(directory, input.providerId, input)));
});
