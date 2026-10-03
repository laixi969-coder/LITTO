import { useState } from "react";
import { App, Alert, Button, Form, Input, InputNumber, Modal, Select, Table, Tag } from "antd";

import { api } from "@/services/api/litto";
import { useAct, useLoad } from "./util";

export default function Providers() {
    const { data, loading, reload } = useLoad<any[]>(() => api.get("/admin/providers"));
    const act = useAct(reload);
    const { message } = App.useApp();
    const [edit, setEdit] = useState<any>(null); // {} = create
    const [keyFor, setKeyFor] = useState<any>(null);
    const [hook, setHook] = useState<any>(null);
    const [keys, setKeys] = useState<any[]>([]);
    const [form] = Form.useForm();
    const [kform] = Form.useForm();

    const save = async () => {
        const v = await form.validateFields();
        try { edit.id ? await api.patch(`/admin/providers/${edit.id}`, v) : await api.post("/admin/providers", v); setEdit(null); reload(); } catch (e: any) { message.error(e.message); }
    };
    const loadKeys = async (p: any) => setKeys(await api.get(`/admin/providers/${p.id}/credentials`).catch(() => []));
    const addKey = async () => {
        const v = await kform.validateFields();
        try { await api.post(`/admin/providers/${keyFor.id}/credentials`, v); kform.resetFields(); message.success("已保存（服务端加密）"); await loadKeys(keyFor); reload(); } catch (e: any) { message.error(e.message); }
    };
    const test = async (p: any) => { try { const r = await api.post(`/admin/providers/${p.id}/test`); (r.ok ? message.success : message.error)(`${r.message} · ${r.latencyMs}ms`); } catch (e: any) { message.error(e.message); } };
    const open = (p: any) => { setEdit(p); form.resetFields(); form.setFieldsValue(p); };

    return (
        <div className="space-y-3">
            <Button type="primary" onClick={() => open({})}>新增 Provider</Button>
            <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[
                { title: "ID", dataIndex: "id" }, { title: "名称", dataIndex: "name" }, { title: "适配器", dataIndex: "adapter" }, { title: "Base URL", dataIndex: "baseUrl" },
                { title: "状态", dataIndex: "status", render: (s) => <Tag color={s === "active" ? "success" : "default"}>{s}</Tag> },
                { title: "优先级", dataIndex: "priority" }, { title: "并发", dataIndex: "concurrency" }, { title: "超时 ms", dataIndex: "timeoutMs" },
                { title: "平台 Key", dataIndex: "hasPlatformCredential", render: (v) => (v ? <Tag color="success">已配置</Tag> : <Tag>无</Tag>) },
                { title: "操作", render: (_, p: any) => <div className="flex flex-wrap gap-1">
                    <Button size="small" type="link" onClick={() => open(p)}>编辑</Button>
                    <Button size="small" type="link" onClick={() => test(p)}>测试连接</Button>
                    <Button size="small" type="link" onClick={() => { setKeyFor(p); loadKeys(p); }}>Key</Button>
                    <Button size="small" type="link" onClick={() => Modal.confirm({ title: `为 ${p.name} 生成 Webhook 密钥？`, content: p.hasWebhookSecret ? "会替换已有密钥。" : "用于校验 Provider 回调签名。", onOk: async () => { try { setHook({ ...(await api.post(`/admin/providers/${p.id}/webhook-secret`)), name: p.name }); } catch (e: any) { message.error(e.message); } } })}>生成 Webhook 密钥</Button>
                    <Button size="small" type="link" onClick={act(async () => message.info(`同步 ${(await api.post(`/admin/providers/${p.id}/sync-models`)).synced} 个模型`))}>同步模型</Button>
                    <Button size="small" type="link" onClick={act(() => api.patch(`/admin/providers/${p.id}`, { status: p.status === "active" ? "disabled" : "active" }))}>{p.status === "active" ? "停用" : "启用"}</Button></div> },
            ]} />
            <Modal open={!!edit} title={edit?.id ? `编辑 ${edit.id}` : "新增 Provider"} onCancel={() => setEdit(null)} onOk={save}>
                <Form form={form} layout="vertical" initialValues={{ adapter: "openai-compatible", priority: 100, concurrency: 4, timeoutMs: 120000 }}>
                    {!edit?.id && <Form.Item name="id" label="ID（可选）"><Input /></Form.Item>}
                    <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
                    {!edit?.id && <Form.Item name="adapter" label="适配器"><Select options={[{ value: "mock" }, { value: "openai-compatible" }]} /></Form.Item>}
                    <Form.Item name="baseUrl" label="Base URL"><Input placeholder="https://api.example.com/v1" /></Form.Item>
                    <div className="grid grid-cols-3 gap-2">
                        <Form.Item name="priority" label="优先级"><InputNumber className="!w-full" /></Form.Item>
                        <Form.Item name="concurrency" label="并发"><InputNumber min={1} className="!w-full" /></Form.Item>
                        <Form.Item name="timeoutMs" label="超时 ms"><InputNumber className="!w-full" /></Form.Item>
                    </div>
                </Form>
            </Modal>
            <Modal open={!!hook} title={`Webhook 密钥 · ${hook?.name}`} footer={<Button type="primary" onClick={() => setHook(null)}>我已保存</Button>} closable={false} maskClosable={false}>
                <Alert type="warning" showIcon message="密钥只显示这一次，关闭后无法再查看（服务端只保存加密形式）。" />
                {(["secret", "url", "header"] as const).map((k) => <div key={k} className="mt-3"><div className="mb-1 text-xs opacity-60">{{ secret: "密钥", url: "回调地址", header: "签名方式" }[k]}</div><Input.TextArea readOnly autoSize value={hook?.[k]} onFocus={(e) => e.target.select()} /><Button size="small" type="link" onClick={() => { void navigator.clipboard.writeText(hook[k]); message.success("已复制"); }}>复制</Button></div>)}
            </Modal>
            <Modal open={!!keyFor} title={`平台 Key · ${keyFor?.name}`} footer={null} onCancel={() => setKeyFor(null)}>
                <Table size="small" pagination={false} rowKey="id" dataSource={keys} columns={[{ title: "标签", dataIndex: "label" }, { title: "Key", dataIndex: "masked" }, { title: "最近错误", dataIndex: "lastError" }]} />
                <Form form={kform} layout="inline" className="!mt-3" onFinish={addKey}>
                    <Form.Item name="label"><Input placeholder="标签" /></Form.Item>
                    <Form.Item name="secret" rules={[{ required: true }]}><Input.Password placeholder="API Key" autoComplete="off" /></Form.Item>
                    <Button htmlType="submit" type="primary">添加</Button>
                </Form>
            </Modal>
        </div>
    );
}
