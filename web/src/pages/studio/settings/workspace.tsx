import { useEffect, useState } from "react";
import { App, Button, Card, Input, Modal, Statistic } from "antd";
import { useNavigate } from "react-router-dom";

import { api, ff } from "@/services/api/ovia";
import { useOviaStore } from "@/stores/use-ovia-store";
import { bytes, useLoad } from "../admin/util";

export default function Workspace() {
    const { data: w, reload } = useLoad<any>(() => api.get("/workspaces/current"));
    const [name, setName] = useState("");
    const [del, setDel] = useState(false);
    const [confirm, setConfirm] = useState("");
    const { message } = App.useApp();
    const nav = useNavigate();
    const logout = useOviaStore((s) => s.logout);
    useEffect(() => w && setName(w.name), [w]);
    if (!w) return null;
    const rename = async () => { try { await api.patch("/workspaces/current", { name }); message.success("已重命名"); reload(); } catch (e: any) { message.error(e.message); } };
    const doDelete = async () => {
        try { await ff("DELETE", "/auth/account", { confirm: "DELETE" }); await logout(); nav("/studio/login"); } catch (e: any) { message.error(e.message); }
    };
    return (
        <div className="max-w-2xl space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Card size="small"><Statistic title="可用积分" value={w.credits.available} /></Card>
                <Card size="small"><Statistic title="冻结" value={w.credits.held} /></Card>
                <Card size="small"><Statistic title="存储" value={bytes(w.storage.bytes)} suffix={`/ ${bytes(w.storage.quotaBytes)}`} /></Card>
                <Card size="small"><Statistic title="角色" value={w.role} /></Card>
            </div>
            <div className="flex gap-2"><Input value={name} onChange={(e) => setName(e.target.value)} /><Button type="primary" onClick={rename} disabled={!name.trim() || name === w.name}>重命名</Button></div>
            <Card size="small" title="危险区域"><p className="mb-2 text-sm opacity-70">注销账号会删除你拥有的所有工作区、项目与媒体文件，无法恢复。</p><Button danger onClick={() => setDel(true)}>注销账号并删除数据</Button></Card>
            <Modal open={del} title="确认注销账号" okText="永久删除" okButtonProps={{ danger: true, disabled: confirm !== "DELETE" }} onOk={doDelete} onCancel={() => setDel(false)}>
                <p>请输入 <b>DELETE</b> 确认：</p><Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Modal>
        </div>
    );
}
