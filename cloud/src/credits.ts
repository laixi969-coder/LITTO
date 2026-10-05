import { get, run, setting, tx } from "./db.ts";
import { conflict, now, ulid } from "./util.ts";

export type LedgerType = "CREDIT_GRANT" | "PURCHASE" | "GENERATION_HOLD" | "GENERATION_CHARGE" | "REFUND" | "ADMIN_ADJUSTMENT";

function account(ws: string) {
    return get("SELECT * FROM credit_accounts WHERE workspace_id=?", ws) ?? (run("INSERT INTO credit_accounts VALUES(?,0,0,?)", ws, now()), get("SELECT * FROM credit_accounts WHERE workspace_id=?", ws)!);
}

/**
 * Append-only ledger. balance = spendable credits incl. held; available = balance - held.
 * HOLD: heldΔ=+est. CHARGE: amount=-actual, heldΔ=-est. REFUND (failed/cancelled): heldΔ=-est, amount 0.
 */
function post(ws: string, type: LedgerType, amount: number, heldDelta: number, extra: { jobId?: string; providerCost?: number | null; platformCost?: number | null; note?: string } = {}) {
    const a = account(ws);
    const balance = a.balance + amount;
    const held = a.held + heldDelta;
    run("UPDATE credit_accounts SET balance=?, held=?, updated_at=? WHERE workspace_id=?", balance, held, now(), ws);
    run("INSERT INTO credit_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ulid(), ws, type, amount, heldDelta, balance, held, extra.jobId ?? null, extra.providerCost ?? null, extra.platformCost ?? null, extra.note ?? null, now());
    return { balance, held };
}

export const grant = (ws: string, amount: number, type: LedgerType = "CREDIT_GRANT", note?: string) => post(ws, type, amount, 0, { note });
export const available = (ws: string) => {
    const a = account(ws);
    return a.balance - a.held;
};
/** Credits users pay for a given provider cost (USD). V1 may be free (billingEnabled=false) but the ledger still records. */
export const creditsFor = (providerCostUsd: number | null) => (providerCostUsd !== null && setting("billingEnabled", true) ? Math.round(providerCostUsd * setting("creditsPerUsd", 100) * setting("markup", 1.0) * 100) / 100 : 0);

export function hold(ws: string, jobId: string, est: number) {
    tx(() => {
        if (available(ws) < est) throw conflict(`insufficient credits: need ${est}, have ${available(ws)}`, "insufficient_credits");
        post(ws, "GENERATION_HOLD", 0, est, { jobId });
    });
}
export function charge(ws: string, jobId: string, held: number, userCharge: number, providerCost: number | null) {
    tx(() => post(ws, "GENERATION_CHARGE", -userCharge, -held, { jobId, providerCost, platformCost: providerCost === null ? null : providerCost * 0.02 }));
}
export function release(ws: string, jobId: string, held: number, why: string) {
    if (held <= 0) return;
    tx(() => post(ws, "REFUND", 0, -held, { jobId, note: why }));
}
/** 按实际用量直接扣费：平台试用的文本 token 在回复结束后才知道，无法预扣。 */
export const chargeUsage = (ws: string, amount: number, note: string) => post(ws, "GENERATION_CHARGE", -amount, 0, { note });
export const adminAdjust = (ws: string, amount: number, note: string) => post(ws, "ADMIN_ADJUSTMENT", amount, 0, { note });
export const accountOf = (ws: string) => {
    const a = account(ws);
    return { balance: a.balance, held: a.held, available: a.balance - a.held };
};
