import { useState } from "react";
import { App, Button, Card, Form, InputNumber, Select, Switch, Table, Tag } from "antd";

import { api } from "@/services/api/litto";
import { time, useLoad } from "./util";

export default function Billing() {
    const { data: plans } = useLoad<any>(() => api.get("/admin/plans"));
    const { data: payments, reload } = useLoad<any[]>(() => api.get("/admin/payments"));
    const { data: users } = useLoad<any[]>(() => api.get("/admin/users"));
    const { message } = App.useApp();
    const [form] = Form.useForm();
    const [busy, setBusy] = useState(false);
    const set = async () => {
        const v = await form.validateFields();
        setBusy(true);
        try {
            const custom = v.credits !== undefined || v.storageGb !== undefined ? { credits: v.credits, storageGb: v.storageGb } : undefined;
            const r = await api.put(`/admin/workspaces/${v.workspaceId}/subscription`, { planId: v.planId, grantCredits: !!v.grantCredits, custom });
            message.success(`已设置为 ${r.subscription.plan}`); reload();
        } catch (e: any) { message.error(e.message); }
        setBusy(false);
    };
    return (
        <div className="space-y-4">
            <Card size="small" title="设置工作区套餐（含企业定制）">
                <Form form={form} layout="inline" className="gap-y-2" onFinish={set}>
                    <Form.Item name="workspaceId" rules={[{ required: true }]}><Select showSearch className="!w-72" placeholder="工作区（按用户邮箱）" optionFilterProp="label" options={users?.filter((u) => u.workspace_id).map((u) => ({ value: u.workspace_id, label: `${u.email} · ${u.workspace}` }))} /></Form.Item>
                    <Form.Item name="planId" rules={[{ required: true }]}><Select className="!w-48" placeholder="套餐" options={plans?.plans.map((p: any) => ({ value: p.id, label: `${p.name} (${p.period})` }))} /></Form.Item>
                    <Form.Item name="credits" label="积分"><InputNumber min={0} placeholder="默认" /></Form.Item>
                    <Form.Item name="storageGb" label="存储 GB"><InputNumber min={1} placeholder="默认" /></Form.Item>
                    <Form.Item name="grantCredits" label="发放积分" valuePropName="checked"><Switch /></Form.Item>
                    <Button type="primary" htmlType="submit" loading={busy}>应用</Button>
                </Form>
            </Card>
            <Table size="small" rowKey="id" title={() => "套餐目录"} pagination={false} dataSource={plans?.plans} columns={[{ title: "ID", dataIndex: "id" }, { title: "名称", dataIndex: "name" }, { title: "周期", dataIndex: "period" }, { title: "价格 USD", dataIndex: "priceUsd" }, { title: "积分", dataIndex: "credits" }, { title: "存储 GB", dataIndex: "storageGb" }]} />
            <Table size="small" rowKey="id" title={() => "支付记录"} dataSource={payments} columns={[{ title: "时间", dataIndex: "created_at", render: time }, { title: "工作区", dataIndex: "workspace_id", ellipsis: true }, { title: "类型", dataIndex: "kind" }, { title: "项目", dataIndex: "item_id" }, { title: "USD", dataIndex: "amount_usd" }, { title: "积分", dataIndex: "credits" }, { title: "渠道", dataIndex: "provider" }, { title: "状态", dataIndex: "status", render: (s) => <Tag color={s === "paid" ? "success" : "default"}>{s}</Tag> }]} />
        </div>
    );
}
