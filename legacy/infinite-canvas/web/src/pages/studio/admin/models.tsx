import { useState } from "react";
import { App, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Switch, Table, Tag } from "antd";

import { api } from "@/services/api/litto";
import { CAPS, useAct, useLoad } from "./util";

const CLS = [{ value: "low" }, { value: "mid" }, { value: "high" }];

export default function Models() {
    const { data, loading, reload } = useLoad<any[]>(() => api.get("/admin/models"));
    const { data: providers } = useLoad<any[]>(() => api.get("/admin/providers"));
    const act = useAct(reload);
    const { message } = App.useApp();
    const [edit, setEdit] = useState<any>(null);
    const [form] = Form.useForm();

    const open = (m: any) => {
        setEdit(m);
        form.resetFields();
        const c = m.capabilities ?? {};
        form.setFieldsValue({ ...m, caps: CAPS.filter((k) => c[k]), maxInputs: c.maxInputs ?? 0, costClass: c.costClass ?? "mid", latencyClass: c.latencyClass ?? "mid", perImage: m.price?.perImage, perSecond: m.price?.perSecond });
    };
    const save = async () => {
        const v = await form.validateFields();
        const capabilities = { ...Object.fromEntries(v.caps.map((k: string) => [k, true])), maxInputs: v.maxInputs, costClass: v.costClass, latencyClass: v.latencyClass, async: true };
        const price = v.type === "video" ? { perSecond: v.perSecond ?? 0 } : { perImage: v.perImage ?? 0 };
        const { caps, maxInputs, costClass, latencyClass, perImage, perSecond, ...rest } = v;
        try {
            edit.id ? await api.patch(`/admin/models/${edit.id}`, { name: rest.name, priority: rest.priority, fallbackModelId: rest.fallbackModelId ?? null, capabilities, price })
                : await api.post("/admin/models", { ...rest, capabilities, price });
            setEdit(null); reload();
        } catch (e: any) { message.error(e.message); }
    };
    const type = Form.useWatch("type", form);

    return (
        <div className="space-y-3">
            <Button type="primary" onClick={() => open({})}>新增模型</Button>
            <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[
                { title: "ID", dataIndex: "id" }, { title: "名称", dataIndex: "name" }, { title: "Provider", dataIndex: "providerId" }, { title: "类型", dataIndex: "type" },
                { title: "能力", dataIndex: "capabilities", render: (c) => <div className="flex max-w-xs flex-wrap gap-1">{CAPS.filter((k) => c[k]).map((k) => <Tag key={k}>{k}</Tag>)}</div> },
                { title: "价格", dataIndex: "price", render: (p) => (p.perImage != null ? `$${p.perImage}/张` : p.perSecond != null ? `$${p.perSecond}/秒` : "-") },
                { title: "优先级", dataIndex: "priority" }, { title: "Fallback", dataIndex: "fallbackModelId" },
                { title: "上架", dataIndex: "status", render: (s, m: any) => <Switch checked={s === "active"} onChange={(on) => act(() => api.patch(`/admin/models/${m.id}`, { status: on ? "active" : "disabled" }))()} /> },
                { title: "", render: (_, m: any) => <Button size="small" type="link" onClick={() => open(m)}>编辑</Button> },
            ]} />
            <Modal open={!!edit} width={640} title={edit?.id ? `编辑 ${edit.id}` : "新增模型"} onCancel={() => setEdit(null)} onOk={save}>
                <Form form={form} layout="vertical" initialValues={{ type: "image", priority: 100, caps: [] }}>
                    <div className="grid grid-cols-2 gap-2">
                        <Form.Item name="providerId" label="Provider" rules={[{ required: true }]}><Select disabled={!!edit?.id} options={providers?.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>
                        <Form.Item name="type" label="类型"><Select disabled={!!edit?.id} options={[{ value: "image" }, { value: "video" }]} /></Form.Item>
                        <Form.Item name="externalModelId" label="外部模型 ID" rules={[{ required: true }]}><Input disabled={!!edit?.id} /></Form.Item>
                        <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
                        {type === "video" ? <Form.Item name="perSecond" label="价格 USD/秒"><InputNumber className="!w-full" step={0.01} /></Form.Item> : <Form.Item name="perImage" label="价格 USD/张"><InputNumber className="!w-full" step={0.01} /></Form.Item>}
                        <Form.Item name="priority" label="优先级"><InputNumber className="!w-full" /></Form.Item>
                        <Form.Item name="maxInputs" label="最大参考输入数"><InputNumber min={0} className="!w-full" /></Form.Item>
                        <Form.Item name="fallbackModelId" label="Fallback 模型"><Select allowClear options={data?.filter((m) => m.id !== edit?.id).map((m) => ({ value: m.id }))} /></Form.Item>
                        <Form.Item name="costClass" label="成本档"><Select options={CLS} /></Form.Item>
                        <Form.Item name="latencyClass" label="延迟档"><Select options={CLS} /></Form.Item>
                    </div>
                    <Form.Item name="caps" label="能力"><Checkbox.Group options={CAPS} className="grid grid-cols-3 gap-1" /></Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
