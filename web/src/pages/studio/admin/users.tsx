import { useState } from "react";
import { App, Button, Drawer, Form, Input, InputNumber, Modal, Select, Table, Tag } from "antd";

import { api } from "@/services/api/filmflow";
import { bytes, StatusTag, time, useAct, useLoad } from "./util";

export default function Users() {
    const [q, setQ] = useState("");
    const { data, loading, reload } = useLoad<any[]>(() => api.get(`/admin/users?q=${encodeURIComponent(q)}`), [q]);
    const act = useAct(reload);
    const { message } = App.useApp();
    const [hist, setHist] = useState<{ email: string; jobs: any[] } | null>(null);
    const [adj, setAdj] = useState<any>(null);
    const [form] = Form.useForm();
    const submit = async () => {
        const v = await form.validateFields();
        try { await api.post("/admin/credits/adjust", { workspaceId: adj.workspace_id, ...v }); message.success("已调账"); setAdj(null); form.resetFields(); reload(); } catch (e: any) { message.error(e.message); }
    };
    return (
        <div className="space-y-3">
            <Input.Search className="!w-72" placeholder="搜索邮箱" allowClear onSearch={setQ} />
            <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[
                { title: "邮箱", dataIndex: "email", render: (e, r: any) => <>{e} {r.is_admin ? <Tag color="gold">admin</Tag> : null}</> },
                { title: "状态", dataIndex: "status", render: (s) => <Tag color={s === "active" ? "success" : "error"}>{s}</Tag> },
                { title: "工作区", dataIndex: "workspace" }, { title: "套餐", dataIndex: "plan" },
                { title: "积分", render: (_, r: any) => `${r.balance ?? 0}（冻结 ${r.held ?? 0}）` },
                { title: "任务", dataIndex: "jobs" }, { title: "存储", dataIndex: "storage_bytes", render: bytes },
                { title: "注册", dataIndex: "created_at", render: time },
                { title: "操作", render: (_, r: any) => <div className="flex gap-1">
                    <Button size="small" type="link" onClick={async () => setHist({ email: r.email, jobs: await api.get(`/admin/users/${r.id}/generations`).catch((e) => (message.error(e.message), [])) })}>生成历史</Button>
                    <Button size="small" type="link" onClick={() => setAdj(r)}>调账</Button>
                    <Button size="small" type="link" danger={r.status === "active"} onClick={act(() => api.patch(`/admin/users/${r.id}`, { status: r.status === "active" ? "disabled" : "active" }), "已更新")}>{r.status === "active" ? "禁用" : "恢复"}</Button></div> },
            ]} />
            <Drawer open={!!hist} onClose={() => setHist(null)} width={720} title={`生成历史 · ${hist?.email}`}>
                <Table size="small" rowKey="id" dataSource={hist?.jobs} columns={[{ title: "类型", dataIndex: "kind" }, { title: "状态", dataIndex: "status", render: (s) => <StatusTag s={s} /> }, { title: "模型", dataIndex: "modelId" }, { title: "扣费", dataIndex: "userCharge" }, { title: "时间", dataIndex: "createdAt", render: time }]} />
            </Drawer>
            <Modal open={!!adj} title={`调账 · ${adj?.email}`} onCancel={() => setAdj(null)} onOk={submit} okText="确认">
                <Form form={form} layout="vertical" initialValues={{ type: "ADMIN_ADJUSTMENT" }}>
                    <Form.Item name="type" label="类型"><Select options={[{ value: "ADMIN_ADJUSTMENT", label: "调账（可为负）" }, { value: "CREDIT_GRANT", label: "赠送" }]} /></Form.Item>
                    <Form.Item name="amount" label="积分数量" rules={[{ required: true }]}><InputNumber className="!w-full" /></Form.Item>
                    <Form.Item name="note" label="原因" rules={[{ required: true, min: 3 }]}><Input /></Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
