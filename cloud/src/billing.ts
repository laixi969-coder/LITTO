import { createHmac, timingSafeEqual } from "node:crypto";
import { all, audit, get, run, setting, tx } from "./db.ts";
import { grant } from "./credits.ts";
import { bad, notFound, now, ulid } from "./util.ts";

/** Plan catalogue (Free / Monthly / Quarterly / Annual / Custom) lives in system_settings so admins can change it without a deploy. */
export type Plan = { id: string; name: string; period: "free" | "monthly" | "quarterly" | "annual" | "custom"; priceUsd: number; credits: number; storageGb: number };
export type Pack = { id: string; name: string; priceUsd: number; credits: number };

export const DEFAULT_PLANS: Plan[] = [
    { id: "free", name: "Free", period: "free", priceUsd: 0, credits: 0, storageGb: 5 },
    { id: "monthly", name: "Pro · Monthly", period: "monthly", priceUsd: 29, credits: 3000, storageGb: 50 },
    { id: "quarterly", name: "Pro · Quarterly", period: "quarterly", priceUsd: 79, credits: 9500, storageGb: 50 },
    { id: "annual", name: "Pro · Annual", period: "annual", priceUsd: 290, credits: 40000, storageGb: 100 },
    { id: "custom", name: "Enterprise · Custom", period: "custom", priceUsd: 0, credits: 0, storageGb: 500 },
];
export const DEFAULT_PACKS: Pack[] = [{ id: "pack-1000", name: "1,000 credits", priceUsd: 10, credits: 1000 }, { id: "pack-5000", name: "5,000 credits", priceUsd: 45, credits: 5000 }];
export const plans = () => setting<Plan[]>("plans", DEFAULT_PLANS);
export const packs = () => setting<Pack[]>("packs", DEFAULT_PACKS);
const MONTHS = { free: 0, monthly: 1, quarterly: 3, annual: 12, custom: 12 } as const;

export function subscriptionEnd(period: Plan["period"], start = new Date()) {
    if (period === "free") return null;
    const months = MONTHS[period];
    if (!Number.isInteger(months) || months <= 0) throw bad("套餐周期无效");
    const end = new Date(start);
    const day = end.getUTCDate();
    end.setUTCMonth(end.getUTCMonth() + months, 1);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
    return end.toISOString();
}

export function subscriptionOf(ws: string) {
    const s = get("SELECT * FROM subscriptions WHERE workspace_id=?", ws)!;
    // Lapsed paid plans fall back to free; granted credits are kept.
    if (s.plan !== "free" && s.period_end && s.period_end < now()) {
        const free = plans().find(plan => plan.id === "free") ?? DEFAULT_PLANS[0]!;
        tx(() => {
            run("UPDATE subscriptions SET plan='free', period='free', status='active', period_end=NULL, updated_at=? WHERE id=?", now(), s.id);
            run("UPDATE workspaces SET quota_bytes=? WHERE id=?", free.storageGb * 1024 ** 3, ws);
        });
        return get("SELECT * FROM subscriptions WHERE id=?", s.id)!;
    }
    return s;
}

export function setPlan(ws: string, plan: Plan, grantCredits: boolean, note: string) {
    tx(() => {
        const end = subscriptionEnd(plan.period);
        run("UPDATE subscriptions SET plan=?, period=?, status='active', period_end=?, updated_at=? WHERE workspace_id=?", plan.id, plan.period, end, now(), ws);
        run("UPDATE workspaces SET quota_bytes=? WHERE id=?", plan.storageGb * 1024 ** 3, ws);
        if (grantCredits && plan.credits) grant(ws, plan.credits, "PURCHASE", `${plan.name}: plan credits`);
    });
}

// ---------------- payment providers ----------------
export interface PaymentProvider {
    id: string;
    checkout(p: { paymentId: string; title: string; amountUsd: number; returnUrl: string }): Promise<{ url?: string; ref?: string; completed?: boolean }>;
}
/** Test-mode provider: completes instantly. Disabled in production unless explicitly chosen. */
const mockPay: PaymentProvider = { id: "mock", async checkout() { return { completed: true, ref: "mock_" + ulid() }; } };
const stripe: PaymentProvider = {
    id: "stripe",
    async checkout({ paymentId, title, amountUsd, returnUrl }) {
        const key = process.env.MILIMILI_STRIPE_SECRET;
        if (!key) throw bad("stripe is not configured (MILIMILI_STRIPE_SECRET)");
        const body = new URLSearchParams({ mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(Math.round(amountUsd * 100)), "line_items[0][price_data][product_data][name]": title, success_url: returnUrl, cancel_url: returnUrl, client_reference_id: paymentId });
        const r = await fetch(`${process.env.MILIMILI_STRIPE_API ?? "https://api.stripe.com"}/v1/checkout/sessions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", "Idempotency-Key": paymentId }, body });
        const j: any = await r.json();
        if (!r.ok) throw bad(`stripe: ${j.error?.message ?? r.status}`);
        return { url: j.url, ref: j.id };
    },
};
export const paymentProvider = (): PaymentProvider => {
    const id = setting<string>("paymentProvider", process.env.NODE_ENV === "production" ? "stripe" : "mock");
    if (id === "stripe") return stripe;
    if (id === "mock") return mockPay;
    throw bad("支付渠道配置无效，请联系管理员");
};

export async function checkout(ws: string, kind: "pack" | "plan", itemId: string, returnUrl: string, requestKey: string) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestKey)) throw bad("购买请求标识无效");
    const key = `checkout:${requestKey}`;
    const previous = get("SELECT response FROM idempotency_keys WHERE workspace_id=? AND key=?", ws, key);
    const saved = previous ? JSON.parse(previous.response) : null;
    if (saved && (saved.kind !== kind || saved.itemId !== itemId)) throw bad("购买请求标识不能用于不同商品");
    if (saved?.result) return saved.result;
    const item: any = kind === "pack" ? packs().find((p) => p.id === itemId) : plans().find((p) => p.id === itemId);
    if (!item) throw notFound(kind);
    if (kind === "plan" && item.period === "free") { setPlan(ws, item, false, "downgrade"); return { completed: true }; }
    if (kind === "plan" && item.period === "custom") throw bad("custom plans are arranged with sales (admin sets them)");
    if (saved && !["stripe", "mock"].includes(saved.provider)) throw bad("订单支付渠道无效");
    const prov = saved ? (saved.provider === "stripe" ? stripe : mockPay) : paymentProvider();
    const id = saved?.paymentId ?? ulid();
    const intent = saved ?? { kind, itemId, paymentId: id, provider: prov.id, title: item.name, amountUsd: item.priceUsd };
    if (!saved) tx(() => {
      run("INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, ws, kind, itemId, item.priceUsd, item.credits, prov.id, null, "pending", now(), now());
      run("INSERT INTO idempotency_keys VALUES(?,?,?,?)", key, ws, JSON.stringify(intent), now());
    });
    const r = await prov.checkout({ paymentId: id, title: intent.title, amountUsd: intent.amountUsd, returnUrl });
    run("UPDATE payments SET provider_ref=? WHERE id=?", r.ref ?? null, id);
    if (r.completed) fulfil(id);
    const result = { paymentId: id, url: r.url ?? null, completed: !!r.completed };
    run("UPDATE idempotency_keys SET response=? WHERE workspace_id=? AND key=?", JSON.stringify({ ...intent, result }), ws, key);
    return result;
}

/** Idempotent: a payment is fulfilled exactly once (webhook retries are safe). */
export function fulfil(paymentId: string) {
    return tx(() => {
        const p = get("SELECT * FROM payments WHERE id=?", paymentId);
        if (!p) throw notFound("payment");
        if (p.status === "paid") return false;
        run("UPDATE payments SET status='paid', updated_at=? WHERE id=? AND status!='paid'", now(), paymentId);
        if (p.kind === "pack") grant(p.workspace_id, p.credits, "PURCHASE", `credit pack ${p.item_id}`);
        // 积分与已下单金额一起固定，后台改价不能改变待支付订单的权益。
        else { const plan = plans().find((x) => x.id === p.item_id); if (plan) setPlan(p.workspace_id, { ...plan, credits: p.credits }, true, "purchase"); }
        audit(null, "payment.paid", paymentId, { kind: p.kind, item: p.item_id }, p.workspace_id);
        return true;
    });
}

/** 已签名的 Checkout 事件仍必须匹配订单、金额、币种和到账状态。 */
export function fulfilStripe(event: any) {
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"].includes(event.type)) return;
  const session = event.data?.object;
  const payment = typeof session?.client_reference_id === "string" ? get("SELECT * FROM payments WHERE id=?", session.client_reference_id) : null;
  if (!payment || payment.provider !== "stripe" || !payment.provider_ref || session.id !== payment.provider_ref
      || session.object !== "checkout.session" || session.mode !== "payment" || session.currency !== "usd"
      || !Number.isSafeInteger(session.amount_total) || session.amount_total !== Math.round(payment.amount_usd * 100)) throw bad("支付回执与订单不一致");
  if (event.type === "checkout.session.async_payment_failed") {
    run("UPDATE payments SET status='failed', updated_at=? WHERE id=? AND status='pending'", now(), payment.id);
    return;
  }
  if ((session.payment_status === "paid" || session.payment_status === "no_payment_required" && session.amount_total === 0) && session.status === "complete") fulfil(payment.id);
}

/** Stripe signature: header `t=…,v1=hex(hmac_sha256(secret, `${t}.${rawBody}`))`, 5 minute tolerance. */
export function verifyStripe(raw: string, header: string | undefined, secret: string) {
    const parts = Object.fromEntries((header ?? "").split(",").map((kv) => kv.split("=") as [string, string]));
    if (!parts.t || !/^\d+$/.test(parts.t) || !parts.v1 || !/^[a-f0-9]{64}$/i.test(parts.v1) || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
    const exp = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
    return exp.length === parts.v1.length && timingSafeEqual(Buffer.from(exp), Buffer.from(parts.v1));
}
export const paymentsOf = (ws: string) => all("SELECT id,kind,item_id,amount_usd,credits,provider,status,created_at FROM payments WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50", ws);
