import { useState } from "react";
import { App, Button, InputNumber, Modal, Table } from "antd";

import { api } from "@/services/api/ovia";
import { bytes, useLoad } from "./util";

export default function Storage() {
    const { data, loading, reload } = useLoad<any>(() => api.get("/admin/storage"));
    const { message } = App.useApp();
    const [q, setQ] = useState<{ id: string; mb: number } | null>(null);
    const cleanup = async () => { try { message.success(`已清理 ${(await api.post("/admin/storage/cleanup")).removed} 个文件`); reload(); } catch (e: any) { message.error(e.message); } };
    const saveQuota = async () => { try { await api.patch(`/admin/storage/quota/${q!.id}`, { quotaBytes: Math.round(q!.mb * 1024 * 1024) }); setQ(null); reload(); } catch (e: any) { message.error(e.message); } };
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-3">
                <span className="text-sm opacity-70">已软删除：{data?.softDeleted.n ?? 0} 个 / {bytes(data?.softDeleted.bytes)}；异常文件：{data?.orphans.length ?? 0}</span>
                <Button onClick={cleanup}>清理软删除文件</Button>
            </div>
            <Table size="small" loading={loading} rowKey="id" dataSource={data?.perWorkspace} columns={[
                { title: "工作区", dataIndex: "name" }, { title: "文件", dataIndex: "files" }, { title: "已用", dataIndex: "bytes", render: bytes }, { title: "配额", dataIndex: "quota_bytes", render: bytes },
                { title: "", render: (_, r: any) => <Button size="small" type="link" onClick={() => setQ({ id: r.id, mb: Math.round(r.quota_bytes / 1024 / 1024) })}>改配额</Button> },
            ]} />
            {!!data?.orphans.length && <Table size="small" title={() => "异常文件（工作区不存在）"} rowKey="id" pagination={false} dataSource={data.orphans} columns={[{ title: "ID", dataIndex: "id" }, { title: "工作区", dataIndex: "workspace_id" }, { title: "大小", dataIndex: "size", render: bytes }]} />}
            <Modal open={!!q} title="修改存储配额 (MB)" onCancel={() => setQ(null)} onOk={saveQuota}><InputNumber className="!w-full" min={0} value={q?.mb} onChange={(v) => setQ({ ...q!, mb: v ?? 0 })} /></Modal>
        </div>
    );
}
