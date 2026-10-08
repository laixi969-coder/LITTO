import u from "@/utils";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { maxSystemPromptLength } from "@/agent/runtime/prompt";
import { t } from "@/lib/i18n";
import { restoreSecrets } from "@/utils/secrets";
import { assertPublicHttpUrl } from "@/utils/ssrf";
import { modelSelectionSchema } from "@/utils/modelSelection";

const router = Router();

export default router.put("/", validateFields({ settings: z.record(z.string(), z.json()).and(z.object({
  agentSystemPrompt: z.string().max(maxSystemPromptLength, { error: () => t`系统提示词不能超过 ${maxSystemPromptLength} 个字符` }).optional(),
  desktopUpdateSource: z.enum(["official", "github", "custom"]).optional(),
  desktopUpdateCustomUrl: z.string().max(2048).refine(value => !value || u.desktop.isValidUpdateUrl(value),
    "自定义更新源必须是不含账号、查询参数或锚点的 HTTP(S) 地址").optional(),
  mcp: z.object({ enabled: z.boolean().optional(), token: z.string().optional(), port: z.number().int().min(1).max(65535).optional() }).optional(),
  modelSelection: modelSelectionSchema.optional(),
})).refine(value => value.desktopUpdateSource !== "custom" || !!value.desktopUpdateCustomUrl, {
  path: ["desktopUpdateCustomUrl"], message: "选择自定义更新源前，请先填写有效地址",
}) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const settings = restoreSecrets(req.body.settings, u.conf.get("settings", {}));
  const selection = modelSelectionSchema.parse(settings.modelSelection ?? {});
  const previous = modelSelectionSchema.safeParse(u.conf.get("settings", {}).modelSelection ?? {});
  for (const kind of ["text", "image", "video", "audio"] as const) {
    const selected = selection[kind];
    if (!selected || previous.success && JSON.stringify(selected) === JSON.stringify(previous.data[kind])) continue;
    const models = kind === "text" ? u.ai.listAiModels(true) : (await u.mediaGeneration.listMediaModels(true)).filter(model => model.type === kind);
    if (!models.some(model => model.providerId === selected.providerId && model.modelId === selected.modelId))
      throw Object.assign(new Error("所选模型当前不可用，请先保存有效的供应商配置，再选择默认模型"), { status: 400 });
  }
  // Tenants choose these addresses, so refuse internal ones up front with a clear message.
  for (const provider of Array.isArray(settings.customProviders) ? settings.customProviders : []) {
    if (provider && typeof provider.apiUrl === "string" && provider.apiUrl) await assertPublicHttpUrl(provider.apiUrl, { strictDns: false });
  }
  const mediaConfigs = settings.mediaProviderConfigs && typeof settings.mediaProviderConfigs === "object" ? Object.values(settings.mediaProviderConfigs as Record<string, unknown>) : [];
  for (const config of mediaConfigs) {
    const address = config && typeof config === "object" ? (config as Record<string, unknown>).baseUrl : undefined;
    if (typeof address === "string" && address) await assertPublicHttpUrl(address, { strictDns: false });
  }
  u.removeLegacySettings(settings);
  u.conf.set("settings", settings);
  await u.mcpRuntime.reloadMcpRuntime();
  res.json(success(null, "设置已保存"));
});
