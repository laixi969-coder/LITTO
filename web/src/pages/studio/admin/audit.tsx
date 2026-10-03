import { Table } from "antd";

import { api } from "@/services/api/filmflow";
import { time, useLoad } from "./util";

export default function Audit() {
    const { data, loading } = useLoad<any[]>(() => api.get("/admin/audit"));
    return <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[
        { title: "时间", dataIndex: "created_at", render: time }, { title: "操作者", dataIndex: "actor_id", render: (v) => v?.slice(-8) }, { title: "动作", dataIndex: "action" },
        { title: "目标", dataIndex: "target", render: (v) => v?.slice(-10) }, { title: "详情", dataIndex: "detail", ellipsis: true, render: (d) => (d ? JSON.stringify(d) : "") },
    ]} />;
}
