import { Button, Table } from "antd";

import { api } from "@/services/api/litto";
import { StatusTag, time, useAct, useLoad } from "../admin/util";

export default function Generations() {
    const { data, loading, reload } = useLoad<any[]>(() => api.get("/generations"), [], (d) => d.some((j) => ["QUEUED", "RUNNING"].includes(j.status)));
    const act = useAct(reload);
    return (
        <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[
            { title: "时间", dataIndex: "createdAt", render: time }, { title: "类型", dataIndex: "kind" }, { title: "状态", dataIndex: "status", render: (s) => <StatusTag s={s} /> },
            { title: "模型", dataIndex: "fallbackChain", render: (c: string[], r: any) => (c?.length > 1 ? c.join(" → ") : r.modelId) }, { title: "尝试", dataIndex: "attempts" },
            { title: "预估", dataIndex: "estimatedCost" }, { title: "实际", dataIndex: "actualCost" }, { title: "扣费", dataIndex: "userCharge" }, { title: "错误", dataIndex: "error", ellipsis: true },
            { title: "操作", render: (_, j: any) => <>
                {["QUEUED", "RUNNING"].includes(j.status) && <Button size="small" type="link" danger onClick={act(() => api.post(`/generations/${j.id}/cancel`), "已取消")}>取消</Button>}
                {["FAILED", "TIMEOUT", "CANCELLED"].includes(j.status) && <Button size="small" type="link" onClick={act(() => api.post(`/generations/${j.id}/retry`), "已重试")}>重试</Button>}</> },
        ]} />
    );
}
