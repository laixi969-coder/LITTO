import { createHash } from "node:crypto";
import conf from "@/utils/conf";

export type ModelBlock = { reason: string; until: number; kind: "text" | "media"; providerId: string };

export function modelAccess(kind: "text" | "media", providerId: string, modelId: string) {
  const settings = conf.get("settings", {});
  const config = (kind === "text"
    ? (settings.customProviders as { id: string }[] | undefined)?.find(item => item.id === providerId)
    : (settings.mediaProviderConfigs as Record<string, unknown> | undefined)?.[providerId]) as Record<string, unknown> | undefined;
  // 只以连接参数指纹绑定禁用状态；不存储密钥，不因模型列表或名称修改而解禁。
  const fields = kind === "text" ? ["apiKey", "apiUrl", "protocol"] : Object.keys(config ?? {}).sort();
  const fingerprint = createHash("sha256").update(JSON.stringify([kind, providerId, fields.map(key => [key, config?.[key]])])).digest("hex");
  const modelKey = createHash("sha256").update(`${fingerprint}:${modelId}`).digest("hex");
  function reason() {
    if (typeof config?.apiKey !== "string" || !config.apiKey.trim().replace(/^Bearer\s*/i, "")) return "未配置 API Key";
    const blocks = conf.get("modelAvailability", {});
    return [blocks[fingerprint], blocks[modelKey]].find(item => item && item.until > Date.now())?.reason;
  }
  return {
    reason,
    assert() {
      const unavailable = reason();
      if (unavailable) throw Object.assign(new Error(`此模型已从可用列表移除：${unavailable}。请在模型设置中修复后重新启用。`), { code: "MODEL_UNAVAILABLE", status: 400, retryable: false });
    },
    failed(error: unknown) {
      const text = error instanceof Error ? error.message : String(error ?? "");
      if (/MODEL_UNAVAILABLE|已从可用列表移除/.test(text)) return;
      const balance = /\b402\b|insufficient[ _](user[ _])?(balance|quota|credit)|余额不足|额度不足|quota.{0,20}(exhausted|exceeded)|credit.{0,20}(exhausted|insufficient)|remaining.{0,10}-\d|剩余.{0,10}-\d/i.test(text);
      const auth = /\b401\b|invalid.{0,10}(api.?key|token)|incorrect api key|unauthorized|密钥.{0,8}(无效|失效)|未配置.*API Key/i.test(text);
      const model = /model.{0,80}(not found|not exist|not available|not supported|unavailable|permission|access)|模型.{0,20}(不存在|不可用|无权限)|\b403\b/i.test(text);
      const transient = /Connection error|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|socket.{0,20}(closed|hang)|timed? ?out|\b429\b|\b50[0234]\b|rate limit/i.test(text);
      if (!balance && !auth && !model && !transient) return;
      const reason = balance ? "余额或额度不足" : auth ? "API Key 无效或未生效" : model ? "模型不存在或没有调用权限" : "连接异常或服务暂不可用（暂停 5 分钟）";
      const blocks = conf.get("modelAvailability", {});
      const active = Object.fromEntries(Object.entries(blocks).filter(([, block]) => block.until > Date.now()));
      active[model && !balance && !auth ? modelKey : fingerprint] = { reason, until: transient && !balance && !auth && !model ? Date.now() + 300000 : Number.MAX_SAFE_INTEGER, kind, providerId };
      conf.set("modelAvailability", active);
    },
  };
}

export function resetModelAvailability(kind: "text" | "media", providerId: string) {
  const blocks = conf.get("modelAvailability", {});
  conf.set("modelAvailability", Object.fromEntries(Object.entries(blocks).filter(([, block]) => block.kind !== kind || block.providerId !== providerId)));
}
