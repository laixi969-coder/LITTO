import { get, run, setting, tx } from "./db.ts";
import { bad, conflict, now, ulid } from "./util.ts";

export type LedgerType = "CREDIT_GRANT" | "PURCHASE" | "GENERATION_HOLD" | "GENERATION_CHARGE" | "REFUND" | "ADMIN_ADJUSTMENT";

// ACT: 保留已有数据库格式；所有积分运算先转换为整数分，避免浮点误差累积。
function creditUnits(value: number) {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) throw bad("积分数值无效或超出范围");
    const [coefficient, exponent = "0"] = String(Math.abs(value)).split("e");
    const units = Math.sign(value) * Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
    if (!Number.isSafeInteger(units)) throw bad("积分数值超出精确范围");
    return units;
}
function account(ws: string) {
    return get("SELECT * FROM credit_accounts WHERE workspace_id=?", ws) ?? (run("INSERT INTO credit_accounts VALUES(?,0,0,?)", ws, now()), get("SELECT * FROM credit_accounts WHERE workspace_id=?", ws)!);
}
function jobHeldUnits(ws: string, jobId: string) {
    return creditUnits(get("SELECT COALESCE(SUM(held_delta),0) AS held FROM credit_ledger WHERE workspace_id=? AND job_id=?", ws, jobId)!.held);
}

/**
 * Append-only ledger. balance = spendable credits incl. held; available = balance - held.
 * HOLD: heldΔ=+est. CHARGE: amount=-actual, heldΔ=-est. REFUND (failed/cancelled): heldΔ=-est, amount 0.
 */
function post(ws: string, type: LedgerType, amount: number, heldDelta: number, extra: { jobId?: string; providerCost?: number | null; platformCost?: number | null; note?: string } = {}) {
    const a = account(ws);
    const balanceUnits = creditUnits(a.balance) + creditUnits(amount);
    const heldUnits = creditUnits(a.held) + creditUnits(heldDelta);
    if (!Number.isSafeInteger(balanceUnits) || !Number.isSafeInteger(heldUnits) || heldUnits < 0) throw bad("积分余额或冻结额无效");
    amount = creditUnits(amount) / 100;
    heldDelta = creditUnits(heldDelta) / 100;
    const balance = balanceUnits / 100;
    const held = heldUnits / 100;
    run("UPDATE credit_accounts SET balance=?, held=?, updated_at=? WHERE workspace_id=?", balance, held, now(), ws);
    run("INSERT INTO credit_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ulid(), ws, type, amount, heldDelta, balance, held, extra.jobId ?? null, extra.providerCost ?? null, extra.platformCost ?? null, extra.note ?? null, now());
    return { balance, held };
}

export const grant = (ws: string, amount: number, type: LedgerType = "CREDIT_GRANT", note?: string) => {
    if (amount < 0) throw bad("发放积分不能为负数");
    return tx(() => post(ws, type, amount, 0, { note }));
};
export const available = (ws: string) => {
    const a = account(ws);
    return (creditUnits(a.balance) - creditUnits(a.held)) / 100;
};
/** Credits users pay for a given provider cost (USD). V1 may be free (billingEnabled=false) but the ledger still records. */
export const creditsFor = (providerCostUsd: number | null) => {
    if (providerCostUsd === null) return 0;
    if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0) throw bad("供应商费用无效");
    if (!setting("billingEnabled", false)) return 0;
    const rate = setting("creditsPerUsd", 100), markup = setting("markup", 1.0);
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(markup) || markup < 0) throw bad("积分费率无效");
    return creditUnits(providerCostUsd * rate * markup) / 100;
};

export function hold(ws: string, jobId: string, est: number) {
    // 自带 Key 或未定价的调用冻结额为 0，平台没有风险敞口，负余额（试用透支）不应拦住它。
    if (est < 0) throw bad("冻结额度不能为负数");
    est = creditUnits(est) / 100;
    if (est === 0) return;
    tx(() => {
        const pending = jobHeldUnits(ws, jobId);
        if (pending === creditUnits(est)) return;
        if (pending !== 0) throw conflict("任务已有不同的冻结额度");
        if (available(ws) < est) throw conflict(`insufficient credits: need ${est}, have ${available(ws)}`, "insufficient_credits");
        post(ws, "GENERATION_HOLD", 0, est, { jobId });
    });
}
export function charge(ws: string, jobId: string, held: number, userCharge: number, providerCost: number | null) {
    if (held < 0 || userCharge < 0) throw bad("结算额度不能为负数");
    creditUnits(held);
    creditUnits(userCharge);
    if (providerCost !== null && (!Number.isFinite(providerCost) || providerCost < 0)) throw bad("供应商费用无效");
    tx(() => {
        if (get("SELECT id FROM credit_ledger WHERE workspace_id=? AND job_id=? AND type='GENERATION_CHARGE'", ws, jobId)) return;
        if (creditUnits(held) !== jobHeldUnits(ws, jobId)) throw conflict("任务冻结额与账本不一致");
        post(ws, "GENERATION_CHARGE", -userCharge, -held, { jobId, providerCost, platformCost: providerCost === null ? null : providerCost * 0.02 });
    });
}
export function release(ws: string, jobId: string, held: number, why: string) {
    if (held < 0) throw bad("释放额度不能为负数");
    held = creditUnits(held) / 100;
    if (held === 0) return;
    tx(() => {
        const pending = jobHeldUnits(ws, jobId);
        if (pending === 0) return;
        if (creditUnits(held) > pending) throw conflict("释放额度超过该任务冻结额");
        post(ws, "REFUND", 0, -held, { jobId, note: why });
    });
}
export function adminAdjust(ws: string, amount: number, note: string) {
  if (!Number.isFinite(amount) || amount === 0) throw bad("积分调整须为非零有限数值");
  return tx(() => {
    if (amount < 0 && available(ws) + amount < 0) throw conflict("扣减不能超过可用积分，冻结积分不可扣减", "insufficient_credits");
    return post(ws, "ADMIN_ADJUSTMENT", amount, 0, { note });
  });
}
export const accountOf = (ws: string) => {
    const a = account(ws);
    return { balance: a.balance, held: a.held, available: (creditUnits(a.balance) - creditUnits(a.held)) / 100 };
};
