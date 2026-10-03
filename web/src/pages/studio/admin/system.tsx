import { useEffect } from "react";
import { Alert, App, Button, Form, Input, InputNumber, Switch } from "antd";

import { api } from "@/services/api/filmflow";
import { useLoad } from "./util";

export default function System() {
    const { data, reload } = useLoad<any>(() => api.get("/admin/system"));
    const { message } = App.useApp();
    const [form] = Form.useForm();
    const maint = Form.useWatch("maintenanceMode", form);
    useEffect(() => data && form.setFieldsValue(data), [data, form]);
    const save = async () => {
        const { modelPolicy, ...v } = form.getFieldsValue(true);
        try { await api.put("/admin/system", v); message.success("已保存"); reload(); } catch (e: any) { message.error(e.message); }
    };
    const num = (name: string, label: string) => <Form.Item name={name} label={label}><InputNumber className="!w-full" /></Form.Item>;
    const sw = (name: string, label: string) => <Form.Item name={name} label={label} valuePropName="checked"><Switch /></Form.Item>;
    return (
        <Form form={form} layout="vertical" className="max-w-xl">
            {sw("registrationOpen", "开放注册")}{sw("billingEnabled", "启用计费（关闭则全部免费，账本仍记录）")}
            {num("defaultCredits", "新用户默认积分")}{num("maxConcurrency", "默认并发")}{num("maxUploadMb", "上传大小上限 (MB)")}
            {num("creditsPerUsd", "积分/美元")}{num("markup", "加价系数")}
            <Form.Item name="defaultImageModel" label="默认图片模型"><Input /></Form.Item>
            <Form.Item name="defaultVideoModel" label="默认视频模型"><Input /></Form.Item>
            <Form.Item name="announcement" label="公告"><Input.TextArea rows={2} /></Form.Item>
            {sw("maintenanceMode", "维护模式")}
            {maint && <Alert type="warning" showIcon className="!mb-4" message="开启后，除管理后台和登录外，所有普通用户请求都会返回 503。" />}
            <Button type="primary" onClick={save}>保存</Button>
        </Form>
    );
}
