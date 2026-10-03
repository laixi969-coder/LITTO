import { useState } from "react";
import { App, Alert, Button, Card, Form, Input, Modal, Select, Table, Tag } from "antd";
import { useNavigate } from "react-router-dom";

import { api, ff } from "@/services/api/ovia";
import { useOviaStore } from "@/stores/use-ovia-store";
import { time, useAct, useLoad } from "../admin/util";

const ROLES = ["ADMIN", "EDITOR", "VIEWER"];

/** Team workspaces (P2). UI mirrors server RBAC: OWNER > ADMIN > EDITOR > VIEWER; admins cannot manage admins. */
export default function Team() {
    const { role, workspaces, workspaceId, user, refresh, switchWorkspace } = useOviaStore();
    const cur = workspaces.find((w) => w.id === workspaceId);
    const personal = cur?.kind === "personal";
    const { data, reload } = useLoad<any>(() => api.get("/workspaces/current/members"), [workspaceId]);
    const act = useAct(reload);
    const { message } = App.useApp();
    const nav = useNavigate();
    const [name, setName] = useState("");
    const [form] = Form.useForm();
    const [del, setDel] = useState(false);
    const [confirm, setConfirm] = useState("");
    const isOwner = role === "OWNER", canManage = isOwner || role === "ADMIN";
    const canTouch = (m: any) => m.role !== "OWNER" && (isOwner || m.role !== "ADMIN") && m.id !== user?.id;

    const create = async () => {
        try { const w = await api.post("/workspaces", { name }); setName(""); await refresh(); switchWorkspace(w.id); message.success("团队工作区已创建"); } catch (e: any) { message.error(e.message); }
    };
    const invite = async () => {
        const v = await form.validateFields();
        try { const r = await api.post("/workspaces/current/members", v); message.success(r.status === "added" ? "已加入" : "已发出邀请（对方首次登录自动加入）"); form.resetFields(); reload(); } catch (e: any) { message.error(e.message); }
    };
    const leave = async () => { try { await api.post("/workspaces/current/leave"); await refresh(); nav("/studio"); } catch (e: any) { message.error(e.message); } };
    const doDelete = async () => { try { await ff("DELETE", "/workspaces/current", { confirm: "DELETE" }); setDel(false); await refresh(); nav("/studio"); } catch (e: any) { message.error(e.message); } };
    const transfer = (m: any) => Modal.confirm({ title: `把所有权转给 ${m.email}？`, content: "你将变为管理员，此操作只有新所有者能撤销。", onOk: act(async () => { await api.post("/workspaces/current/transfer", { userId: m.id }); await refresh(); }, "已转让") });

    return (
        <div className="max-w-3xl space-y-4">
            <Card size="small" title="创建团队工作区">
                <div className="flex gap-2"><Input placeholder="团队名称" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} /><Button type="primary" disabled={!name.trim()} onClick={create}>创建</Button></div>
                <div className="mt-1 text-xs opacity-60">团队工作区有独立的项目、积分、Key 与存储；你是所有者。用顶部的下拉切换工作区。</div>
            </Card>
            {personal ? <Alert type="info" showIcon message="当前是个人工作区，不能添加成员。请切换到团队工作区，或先创建一个。" /> : (
                <>
                    {!canManage && <Alert type="warning" showIcon message={`你的角色是 ${role}，成员管理为只读。`} />}
                    <Form form={form} layout="inline" initialValues={{ role: "EDITOR" }} onFinish={invite}>
                        <Form.Item name="email" rules={[{ required: true, type: "email" }]}><Input className="!w-64" placeholder="成员邮箱" disabled={!canManage} /></Form.Item>
                        <Form.Item name="role"><Select className="!w-28" disabled={!canManage} options={ROLES.filter((r) => isOwner || r !== "ADMIN").map((v) => ({ value: v }))} /></Form.Item>
                        <Button type="primary" htmlType="submit" disabled={!canManage}>添加 / 邀请</Button>
                    </Form>
                    <Table size="small" rowKey="id" pagination={false} dataSource={data?.members} columns={[
                        { title: "邮箱", dataIndex: "email" },
                        { title: "角色", dataIndex: "role", render: (r: string, m: any) => (m.role === "OWNER" ? <Tag color="gold">OWNER</Tag> : <Select size="small" className="!w-24" value={r} disabled={!canManage || !canTouch(m)} options={ROLES.filter((x) => isOwner || x !== "ADMIN").concat(m.role === "ADMIN" && !isOwner ? ["ADMIN"] : []).map((v) => ({ value: v }))} onChange={(v) => act(() => api.patch(`/workspaces/current/members/${m.id}`, { role: v }), "角色已更新")()} />) },
                        { title: "加入时间", dataIndex: "created_at", render: time },
                        { title: "操作", render: (_, m: any) => <>{isOwner && m.role !== "OWNER" && <Button size="small" type="link" onClick={() => transfer(m)}>转让所有权</Button>}<Button size="small" type="link" danger disabled={!canManage || !canTouch(m)} onClick={() => Modal.confirm({ title: `移除 ${m.email}？`, okType: "danger", onOk: act(() => api.del(`/workspaces/current/members/${m.id}`), "已移除") })}>移除</Button></> },
                    ]} />
                    {data?.invites?.length > 0 && <Table size="small" rowKey="id" pagination={false} title={() => "待接受的邀请"} dataSource={data.invites} columns={[{ title: "邮箱", dataIndex: "email" }, { title: "角色", dataIndex: "role" }, { title: "操作", render: (_, i: any) => <Button size="small" type="link" danger disabled={!canManage} onClick={act(() => api.del(`/workspaces/current/invites/${i.id}`), "已撤销")}>撤销</Button> }]} />}
                    <div className="flex gap-2">
                        <Button disabled={isOwner} onClick={leave}>离开该团队</Button>
                        <Button danger disabled={!isOwner} onClick={() => setDel(true)}>删除团队工作区</Button>
                    </div>
                </>
            )}
            <Modal open={del} title="删除团队工作区" okText="永久删除" okButtonProps={{ danger: true, disabled: confirm !== "DELETE" }} onOk={doDelete} onCancel={() => setDel(false)}>
                <p>所有项目、资产、生成记录和媒体文件都会被异步彻底清理。输入 <b>DELETE</b> 确认：</p>
                <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Modal>
        </div>
    );
}
