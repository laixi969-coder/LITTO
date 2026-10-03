import { useState } from "react";
import { App, Button, Form, Input, Modal, Select, Switch, Table, Tag } from "antd";
import { Plus } from "lucide-react";

import { api } from "@/services/api/filmflow";
import { useAct, useLoad } from "./util";

type Conn = { id: string; name: string; issuer: string; clientId: string; hasSecret: boolean; domains: string[]; workspaceId: string | null; role: string; enforce: boolean; enabled: boolean };

/** Enterprise SSO (OIDC). SAML is not supported. The client secret is write-only: the API only reports that one is stored. */
export default function AdminSso() {
    const { message, modal } = App.useApp();
    const { data, reload, loading } = useLoad<Conn[]>(() => api.get("/admin/sso"));
    const act = useAct(reload);
    const [edit, setEdit] = useState<Partial<Conn> | null>(null);
    const [f] = Form.useForm();
    const open = (c?: Conn) => { setEdit(c ?? {}); f.resetFields(); f.setFieldsValue(c ? { ...c, clientSecret: "" } : { role: "EDITOR", enabled: true, enforce: false, domains: [] }); };
    const save = async () => {
        const v = await f.validateFields();
        const { clientSecret, ...rest } = v;
        const body = { ...rest, workspaceId: v.workspaceId || null, ...(clientSecret ? { clientSecret } : {}) };
        try {
            await (edit?.id ? api.patch(`/admin/sso/${edit.id}`, body) : api.post("/admin/sso", { ...body, clientSecret }));
            f.setFieldValue("clientSecret", ""); // never keep the secret around after submit
            setEdit(null); message.success("已保存"); await reload();
        } catch (e: any) { message.error(e.message); }
    };
    return (
        <div className="space-y-3 p-4">
            <div className="flex items-center gap-3"><b>企业 SSO（OIDC）</b><span className="text-xs opacity-60">支持 Okta / Azure AD / Keycloak 等标准 OIDC；回调地址 {`{PUBLIC_URL}/auth/sso/<连接ID>/callback`}；暂不支持 SAML</span><div className="flex-1" /><Button type="primary" icon={<Plus size={14} />} onClick={() => open()}>新建连接</Button></div>
            <Table size="small" rowKey="id" loading={loading} dataSource={data} pagination={false} columns={[
                { title: "名称", dataIndex: "name" },
                { title: "Issuer", dataIndex: "issuer", ellipsis: true },
                { title: "域名", dataIndex: "domains", render: (d: string[]) => d.map((x) => <Tag key={x}>{x}</Tag>) },
                { title: "自动加入", render: (_, c) => (c.workspaceId ? `${c.workspaceId.slice(-6)} · ${c.role}` : "-") },
                { title: "密钥", dataIndex: "hasSecret", render: (h: boolean) => (h ? "••••••（已存储）" : "未设置") },
                { title: "强制", dataIndex: "enforce", render: (v, c) => <Switch size="small" checked={v} onChange={(x) => act(() => api.patch(`/admin/sso/${c.id}`, { enforce: x }))()} /> },
                { title: "启用", dataIndex: "enabled", render: (v, c) => <Switch size="small" checked={v} onChange={(x) => act(() => api.patch(`/admin/sso/${c.id}`, { enabled: x }))()} /> },
                { title: "", render: (_, c) => <div className="flex gap-1"><Button size="small" type="link" onClick={() => open(c)}>编辑</Button><Button size="small" type="link" danger onClick={() => modal.confirm({ title: `删除「${c.name}」？`, content: "该域名将恢复验证码登录。", okType: "danger", onOk: act(() => api.del(`/admin/sso/${c.id}`), "已删除") })}>删除</Button></div> },
            ]} />
            <Modal open={!!edit} title={edit?.id ? "编辑 SSO 连接" : "新建 SSO 连接"} onOk={save} onCancel={() => setEdit(null)} okText="保存" destroyOnHidden>
                <Form form={f} layout="vertical" size="small">
                    <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="Acme Okta" /></Form.Item>
                    <Form.Item name="issuer" label="Issuer URL" rules={[{ required: true, type: "url" }]}><Input placeholder="https://acme.okta.com" /></Form.Item>
                    <div className="grid grid-cols-2 gap-2">
                        <Form.Item name="clientId" label="Client ID" rules={[{ required: true }]}><Input /></Form.Item>
                        <Form.Item name="clientSecret" label={edit?.id ? "Client Secret（留空保持不变）" : "Client Secret"} rules={[{ required: !edit?.id }]}><Input.Password autoComplete="new-password" placeholder={edit?.hasSecret ? "••••••（已存储）" : ""} /></Form.Item>
                    </div>
                    <Form.Item name="domains" label="邮箱域名" rules={[{ required: true, type: "array", min: 1 }]}><Select mode="tags" tokenSeparators={[",", " "]} placeholder="acme.com" /></Form.Item>
                    <div className="grid grid-cols-2 gap-2">
                        <Form.Item name="workspaceId" label="自动加入的团队工作区 ID"><Input allowClear placeholder="可选" /></Form.Item>
                        <Form.Item name="role" label="加入角色"><Select options={["ADMIN", "EDITOR", "VIEWER"].map((v) => ({ value: v }))} /></Form.Item>
                    </div>
                    <div className="flex gap-6"><Form.Item name="enforce" label="强制 SSO（禁用验证码/OAuth）" valuePropName="checked"><Switch /></Form.Item><Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></div>
                </Form>
            </Modal>
        </div>
    );
}
