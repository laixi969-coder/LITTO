import { all, get, run, setting } from "./db.ts";
import { now, ulid } from "./util.ts";

/**
 * Usage & spend receipts (BYOK model: the user pays their own provider, so LITTO records WHAT was used, not credits).
 * Costs are only shown when a price is known: either reported by the provider/model (text tokens) or configured by the admin
 * in the `pricing` system setting ({"providerId/modelId": {perImage?, perSecond?, perCall?}}). Nothing is guessed.
 */
export type UsageEvent = { workspaceId: string; userId?: string | null; kind: "image" | "video" | "audio" | "text"; providerId?: string; modelId?: string; units: number; unit: "image" | "second" | "token" | "call"; costUsd?: number | null; status?: "ok" | "error" | "cancelled"; durationMs?: number; project?: string; detail?: Record<string, unknown> };
type Price = { perImage?: number; perSecond?: number; perCall?: number };

function priced(e: UsageEvent): number | null {
    if (typeof e.costUsd === "number" && e.costUsd > 0) return e.costUsd;
    const p = setting<Record<string, Price>>("pricing", {})[`${e.providerId}/${e.modelId}`];
    if (!p) return null;
    if (e.unit === "image" && p.perImage !== undefined) return p.perImage * e.units;
    if (e.unit === "second" && p.perSecond !== undefined) return p.perSecond * e.units;
    if (p.perCall !== undefined) return p.perCall;
    return null;
}

export function recordUsage(e: UsageEvent) {
    run("INSERT INTO usage_events(id,workspace_id,user_id,kind,provider_id,model_id,units,unit,cost_usd,status,duration_ms,project,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ulid(), e.workspaceId, e.userId ?? null, e.kind, e.providerId ?? null, e.modelId ?? null, e.units, e.unit, priced(e), e.status ?? "ok", e.durationMs ?? null, e.project ?? null, e.detail ? JSON.stringify(e.detail) : null, now());
}

export function summary(workspaceId: string | null, days = 30, period?: "month") {
    const date = new Date();
    const since = period === "month" ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString() : new Date(Date.now() - days * 864e5).toISOString();
    const scope = workspaceId ? "workspace_id=? AND " : "";
    const args = workspaceId ? [workspaceId, since] : [since];
    const byKind = all(`SELECT kind, unit, COUNT(*) calls, SUM(units) units, SUM(status!='ok') failed, SUM(cost_usd) cost_usd, SUM(cost_usd IS NULL) unpriced FROM usage_events WHERE ${scope}created_at>=? GROUP BY kind, unit ORDER BY kind`, ...args);
    const byModel = all(`SELECT kind, provider_id, model_id, unit, COUNT(*) calls, SUM(units) units, SUM(cost_usd) cost_usd FROM usage_events WHERE ${scope}created_at>=? GROUP BY kind, provider_id, model_id, unit ORDER BY calls DESC LIMIT 30`, ...args);
    const daily = all(`SELECT substr(created_at,1,10) day, kind, SUM(units) units, SUM(cost_usd) cost_usd FROM usage_events WHERE ${scope}created_at>=? GROUP BY day, kind ORDER BY day`, ...args);
    const recent = all(`SELECT id, kind, provider_id, model_id, units, unit, cost_usd, status, duration_ms, created_at FROM usage_events WHERE ${scope}created_at>=? ORDER BY created_at DESC LIMIT 30`, ...args);
    const totalCost = get(`SELECT SUM(cost_usd) c FROM usage_events WHERE ${scope}created_at>=?`, ...args)!.c as number | null;
    return { days, since, byKind, byModel, daily, recent, totalCostUsd: totalCost, pricingConfigured: Object.keys(setting("pricing", {})).length > 0 };
}

export function exportCsv(workspaceId: string, days = 90) {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const rows = all("SELECT created_at, kind, provider_id, model_id, units, unit, cost_usd, status, duration_ms FROM usage_events WHERE workspace_id=? AND created_at>=? ORDER BY created_at", workspaceId, since);
    const esc = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return ["time,kind,provider,model,units,unit,cost_usd,status,duration_ms", ...rows.map((r) => [r.created_at, r.kind, r.provider_id, r.model_id, r.units, r.unit, r.cost_usd, r.status, r.duration_ms].map(esc).join(","))].join("\n") + "\n";
}
