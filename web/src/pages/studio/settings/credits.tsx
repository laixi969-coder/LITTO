import { Card, Statistic, Table } from "antd";

import { api } from "@/services/api/filmflow";
import { ledgerColumns } from "../admin/ledger";
import { useLoad } from "../admin/util";

export default function Credits() {
    const { data, loading } = useLoad<any>(() => api.get("/credits"));
    return (
        <div className="space-y-4">
            <div className="grid max-w-xl grid-cols-3 gap-3">
                {[["可用", data?.available], ["余额", data?.balance], ["冻结", data?.held]].map(([t, v]) => <Card key={t as string} size="small"><Statistic title={t} value={v ?? 0} /></Card>)}
            </div>
            <Table size="small" loading={loading} rowKey="id" dataSource={data?.ledger} columns={ledgerColumns} />
        </div>
    );
}
