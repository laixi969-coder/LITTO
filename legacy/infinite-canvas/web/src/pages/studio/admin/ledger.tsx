import { Table, Tag } from "antd";

import { api } from "@/services/api/litto";
import { time, useLoad } from "./util";

export const LEDGER_COLOR: Record<string, string> = { CREDIT_GRANT: "green", PURCHASE: "blue", GENERATION_HOLD: "gold", GENERATION_CHARGE: "volcano", REFUND: "cyan", ADMIN_ADJUSTMENT: "purple" };

export const ledgerColumns = [
    { title: "时间", dataIndex: "created_at", render: time }, { title: "类型", dataIndex: "type", render: (t: string) => <Tag color={LEDGER_COLOR[t]}>{t}</Tag> },
    { title: "金额", dataIndex: "amount" }, { title: "冻结变动", dataIndex: "held_delta" }, { title: "余额", dataIndex: "balance_after" },
    { title: "任务", dataIndex: "job_id", render: (v: string) => v?.slice(-8) }, { title: "备注", dataIndex: "note" },
];

export default function Ledger() {
    const { data, loading } = useLoad<any[]>(() => api.get("/admin/credits/ledger"));
    return <Table size="small" loading={loading} rowKey="id" dataSource={data} scroll={{ x: true }} columns={[...ledgerColumns, { title: "工作区", dataIndex: "workspace_id", render: (v: string) => v.slice(-8) }]} />;
}
