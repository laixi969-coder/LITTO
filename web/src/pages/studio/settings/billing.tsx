import { App, Alert, Button, Card, Table, Tag } from "antd";

import { api } from "@/services/api/litto";
import { useLittoStore } from "@/stores/use-litto-store";
import { time, useLoad } from "../admin/util";

const PERIOD: Record<string, string> = { free: "免费", monthly: "月付", quarterly: "季付", annual: "年付", custom: "定制" };

export default function Billing() {
    const { data: b, reload } = useLoad<any>(() => api.get("/billing"));
    const role = useLittoStore((s) => s.role);
    const { message } = App.useApp();
    if (!b) return null;
    const owner = role === "OWNER";
    const buy = async (kind: "pack" | "plan", id: string) => {
        try {
            const r = await api.post("/billing/checkout", { kind, id });
            if (r.url) { window.location.href = r.url; return; }
            message.success(r.completed ? "已完成" : "已提交"); reload();
        } catch (e: any) { message.error(e.message); }
    };
    const sub = b.subscription;
    return (
        <div className="max-w-4xl space-y-4">
            {b.paymentProvider === "mock" && <Alert type="warning" showIcon message="支付处于测试模式（mock）：点击购买会立即到账，不产生真实扣款。" />}
            {!owner && <Alert type="info" showIcon message="只有工作区所有者可以购买或变更套餐。" />}
            <Card size="small" title="当前套餐">
                <div className="flex flex-wrap items-center gap-3"><Tag color="blue" className="!text-base">{b.plans.find((p: any) => p.id === sub.plan)?.name ?? sub.plan}</Tag><span>{PERIOD[sub.period] ?? sub.period}</span><span className="opacity-60">状态 {sub.status}</span>{sub.period_end && <span className="opacity-60">到期 {time(sub.period_end)}</span>}</div>
            </Card>
            <div className="grid gap-3 md:grid-cols-3">
                {b.plans.map((p: any) => (
                    <Card key={p.id} size="small" title={p.name} extra={<Tag>{PERIOD[p.period]}</Tag>} className={p.id === sub.plan ? "!border-blue-500" : ""}>
                        <div className="text-2xl font-semibold">{p.period === "custom" ? "联系销售" : p.priceUsd ? `$${p.priceUsd}` : "$0"}</div>
                        <div className="my-2 text-xs opacity-70">{p.credits ? `${p.credits} 积分 · ` : ""}{p.storageGb} GB 存储</div>
                        <Button block disabled={!owner || p.id === sub.plan || p.period === "custom"} type={p.id === sub.plan ? "default" : "primary"} onClick={() => buy("plan", p.id)}>{p.id === sub.plan ? "当前套餐" : p.period === "free" ? "降级到免费" : "购买"}</Button>
                    </Card>
                ))}
            </div>
            <Card size="small" title="积分包">
                <div className="flex flex-wrap gap-3">{b.packs.map((p: any) => <Card key={p.id} size="small"><div className="font-medium">{p.name}</div><div className="mb-2 text-xs opacity-60">${p.priceUsd}</div><Button type="primary" disabled={!owner} onClick={() => buy("pack", p.id)}>充值</Button></Card>)}</div>
            </Card>
            <Table size="small" rowKey="id" title={() => "支付记录"} dataSource={b.payments} pagination={false} columns={[{ title: "时间", dataIndex: "created_at", render: time }, { title: "类型", dataIndex: "kind" }, { title: "项目", dataIndex: "item_id" }, { title: "金额 (USD)", dataIndex: "amount_usd" }, { title: "积分", dataIndex: "credits" }, { title: "渠道", dataIndex: "provider" }, { title: "状态", dataIndex: "status", render: (s) => <Tag color={s === "paid" ? "success" : "default"}>{s}</Tag> }]} />
        </div>
    );
}
