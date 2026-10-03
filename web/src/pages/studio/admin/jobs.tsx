import { useState } from "react";
import { Button, Select, Table } from "antd";

import { api } from "@/services/api/filmflow";
import { StatusTag, time, useAct, useLoad } from "./util";

export default function Jobs() {
    const [status, setStatus] = useState<string>();
    const { data, loading, reload } = useLoad<any[]>(() => api.get(`/admin/jobs${status ? `?status=${status}` : ""}`), [status], (d) => d.some((j) => ["QUEUED", "RUNNING"].includes(j.status)));
    const act = useAct(reload);
    return (
        <div className="space-y-3">
            <Select allowClear className="!w-44" placeholder="状态筛选" value={status} onChange={setStatus} options={["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "TIMEOUT", "CANCELLED"].map((v) => ({ value: v }))} />
            <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[
                { title: "ID", dataIndex: "id", render: (v) => v.slice(-8) }, { title: "类型", dataIndex: "kind" }, { title: "状态", dataIndex: "status", render: (s) => <StatusTag s={s} /> },
                { title: "模型链", dataIndex: "fallbackChain", render: (c: string[]) => c.join(" → ") }, { title: "尝试", dataIndex: "attempts" },
                { title: "预估", dataIndex: "estimatedCost" }, { title: "实际", dataIndex: "actualCost" }, { title: "扣费", dataIndex: "userCharge" },
                { title: "错误", dataIndex: "error", ellipsis: true }, { title: "创建", dataIndex: "createdAt", render: time },
                { title: "操作", render: (_, j: any) => <>
                    {["QUEUED", "RUNNING"].includes(j.status) && <Button size="small" type="link" danger onClick={act(() => api.post(`/admin/jobs/${j.id}/cancel`), "已取消")}>取消</Button>}
                    {["FAILED", "TIMEOUT", "CANCELLED"].includes(j.status) && <Button size="small" type="link" onClick={act(() => api.post(`/admin/jobs/${j.id}/retry`), "已重试")}>重试</Button>}</> },
            ]} />
        </div>
    );
}
