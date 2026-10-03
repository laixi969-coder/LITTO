import { currentTenant, authEnabled } from "@/utils/tenant";
import { cloud } from "@/lib/cloud";

type UsageInput = { kind: "image" | "video" | "audio" | "text"; providerId?: string; modelId?: string; units: number; unit: "image" | "second" | "token" | "call"; costUsd?: number | null; status?: "ok" | "error" | "cancelled"; durationMs?: number; detail?: Record<string, unknown> };

/** Usage & spend receipts: records into the cloud DB under the caller's workspace. Never throws, never blocks generation. */
export function recordUsage(event: UsageInput) {
  const tenant = currentTenant();
  const embed = cloud();
  if (!tenant || !embed || !authEnabled()) return;
  try { embed.recordUsage({ ...event, workspaceId: tenant.workspaceId, userId: tenant.userId }); }
  catch (error) { console.warn("记录用量失败：", error instanceof Error ? error.message : error); }
}

/** Assistant message from the Pi SDK: tokens always, cost only when the model has prices configured (total > 0). */
export function recordTextUsage(message: { provider?: string; model?: string; stopReason?: string; usage?: { totalTokens?: number; cost?: { total?: number } } }) {
  const tokens = message.usage?.totalTokens ?? 0;
  if (!tokens) return;
  recordUsage({ kind: "text", providerId: message.provider, modelId: message.model, units: tokens, unit: "token", costUsd: message.usage?.cost?.total || null, status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "cancelled" : "ok" });
}
