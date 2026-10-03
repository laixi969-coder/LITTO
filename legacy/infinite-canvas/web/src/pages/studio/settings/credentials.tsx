import { App, Alert, Button, Form, Input, Select, Switch, Table } from "antd";

import { api } from "@/services/api/litto";
import { time, useAct, useLoad } from "../admin/util";

export default function Credentials() {
    const { data, loading, reload } = useLoad<any[]>(() => api.get("/credentials"));
    const { data: providers } = useLoad<any[]>(() => api.get("/providers"));
    const { data: projects } = useLoad<any[]>(() => api.get("/projects"));
    const act = useAct(reload);
    const { message } = App.useApp();
    const [form] = Form.useForm();
    const add = async () => {
        const { scope, ...v } = await form.validateFields();
        if (scope !== "project") delete v.projectId;
        form.setFieldValue("secret", ""); // never keep the secret around after submit
        try { await api.post("/credentials", v); form.resetFields(); form.setFieldValue("scope", scope); message.success("已保存（服务端加密，仅显示掩码）"); reload(); } catch (e: any) { message.error(e.message); }
    };
    const test = async (providerId: string) => { try { const r = await api.post("/credentials/test", { providerId }); (r.ok ? message.success : message.error)(`${r.message} · ${r.latencyMs}ms`); reload(); } catch (e: any) { message.error(e.message); } };
    return (
        <div className="space-y-4">
            <Alert type="info" showIcon message="API Key 在服务端加密存储，界面只显示掩码，不会写入日志或浏览器存储。优先级：项目 Key > 工作区 Key (BYOK) > 平台 Key。" />
            <Form form={form} layout="inline" onFinish={add} initialValues={{ scope: "workspace" }}>
                <Form.Item name="scope"><Select className="!w-28" options={[{ value: "workspace", label: "工作区" }, { value: "project", label: "项目" }]} /></Form.Item>
                <Form.Item noStyle shouldUpdate={(a, b) => a.scope !== b.scope}>{({ getFieldValue }) => getFieldValue("scope") === "project" && <Form.Item name="projectId" rules={[{ required: true, message: "选择项目" }]}><Select className="!w-44" placeholder="项目" options={projects?.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>}</Form.Item>
                <Form.Item name="providerId" rules={[{ required: true }]}><Select className="!w-48" placeholder="Provider" options={providers?.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>
                <Form.Item name="label"><Input placeholder="标签" /></Form.Item>
                <Form.Item name="secret" rules={[{ required: true }]}><Input.Password className="!w-64" placeholder="API Key" autoComplete="new-password" /></Form.Item>
                <Button type="primary" htmlType="submit">添加 Key</Button>
            </Form>
            <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[
                { title: "Provider", dataIndex: "providerId" }, { title: "范围", dataIndex: "scope", render: (v: string, r: any) => (v === "project" ? `项目 · ${projects?.find((p) => p.id === r.projectId)?.name ?? r.projectId}` : "工作区") }, { title: "标签", dataIndex: "label" }, { title: "Key", dataIndex: "masked" },
                { title: "启用", dataIndex: "enabled", render: (v, r: any) => <Switch checked={v} onChange={(on) => act(() => api.patch(`/credentials/${r.id}`, { enabled: on }))()} /> },
                { title: "最近使用", dataIndex: "lastUsedAt", render: time }, { title: "最近错误", dataIndex: "lastError", ellipsis: true },
                { title: "操作", render: (_, r: any) => <><Button size="small" type="link" onClick={() => test(r.providerId)}>测试连接</Button><Button size="small" type="link" danger onClick={act(() => api.del(`/credentials/${r.id}`), "已删除")}>删除</Button></> },
            ]} />
        </div>
    );
}
