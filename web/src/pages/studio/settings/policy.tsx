import { useEffect } from "react";
import { App, Button, Form, Select, Switch, Table } from "antd";
import { Check } from "lucide-react";

import { api } from "@/services/api/ovia";
import { useLoad } from "../admin/util";

const MATRIX = ["text2image", "imageEdit", "identityReference", "multiReference", "compositionReference", "image2video", "startEndFrame", "cameraControl", "nativeAudio"];

export default function Policy() {
    const { data: models } = useLoad<any[]>(() => api.get("/models"));
    const { message } = App.useApp();
    const [form] = Form.useForm();
    useEffect(() => form.setFieldsValue({ optimize: "balanced", allowFallback: true }), [form]);
    const opts = (t: string) => models?.filter((m) => m.type === t).map((m) => ({ value: m.id, label: m.name }));
    const save = async () => {
        const v = form.getFieldsValue();
        try { await api.put("/workspaces/current/model-policy", { ...v, imageModelId: v.imageModelId ?? null, videoModelId: v.videoModelId ?? null, disabledModelIds: v.disabledModelIds ?? [] }); message.success("已保存"); } catch (e: any) { message.error(e.message); }
    };
    return (
        <div className="space-y-4">
            <Form form={form} layout="vertical" className="max-w-xl">
                <Form.Item name="optimize" label="路由偏好"><Select options={[{ value: "balanced", label: "均衡" }, { value: "quality", label: "质量优先" }, { value: "cost", label: "成本优先" }, { value: "latency", label: "速度优先" }]} /></Form.Item>
                <Form.Item name="imageModelId" label="默认图片模型（留空=自动路由）"><Select allowClear options={opts("image")} /></Form.Item>
                <Form.Item name="videoModelId" label="默认视频模型（留空=自动路由）"><Select allowClear options={opts("video")} /></Form.Item>
                <Form.Item name="disabledModelIds" label="禁用的模型"><Select mode="multiple" options={models?.map((m) => ({ value: m.id, label: m.name }))} /></Form.Item>
                <Form.Item name="allowFallback" label="失败时自动 Fallback" valuePropName="checked"><Switch /></Form.Item>
                <Button type="primary" onClick={save}>保存策略</Button>
            </Form>
            <Table size="small" pagination={false} rowKey="id" dataSource={models} scroll={{ x: true }} columns={[
                { title: "模型", dataIndex: "name", fixed: "left" }, { title: "类型", dataIndex: "type" },
                ...MATRIX.map((k) => ({ title: k, dataIndex: ["capabilities", k], align: "center" as const, render: (v: boolean) => (v ? <Check size={14} className="inline" /> : null) })),
            ]} />
        </div>
    );
}
