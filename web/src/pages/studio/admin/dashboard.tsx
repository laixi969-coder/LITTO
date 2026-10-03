import { Card, Statistic, Table } from "antd";

import { FF_BASE, api } from "@/services/api/filmflow";
import { bytes, useLoad } from "./util";

export default function Dashboard() {
    const { data: d } = useLoad<any>(() => api.get("/admin/dashboard"));
    if (!d) return null;
    const stats: [string, string | number][] = [
        ["用户", d.users], ["7日活跃", d.activeUsers7d], ["生成总数", d.generations.total], ["图片", d.generations.images], ["视频", d.generations.videos],
        ["Provider 成本 (USD)", d.providerCostUsd.toFixed(3)], ["已收积分", d.creditsCharged], ["失败率", `${(d.failureRate * 100).toFixed(1)}%`],
        ["排队", d.queue.queued], ["运行中", d.queue.running], ["存储", bytes(d.storage.bytes)], ["文件数", d.storage.files],
    ];
    return (
        <div className="space-y-4">
            <div className="text-right text-xs"><a href={`${FF_BASE}/admin/metrics.txt`} target="_blank" rel="noreferrer">Prometheus 指标 (metrics.txt) ↗</a></div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{stats.map(([t, v]) => <Card key={t} size="small"><Statistic title={t} value={v} /></Card>)}</div>
            <div className="grid gap-4 md:grid-cols-2">
                <Card size="small" title="模型成功率"><Table size="small" pagination={false} rowKey="model_id" dataSource={d.modelSuccess} columns={[{ title: "模型", dataIndex: "model_id" }, { title: "总数", dataIndex: "total" }, { title: "成功", dataIndex: "ok" }, { title: "成功率", render: (_, r: any) => `${((r.ok / r.total) * 100).toFixed(0)}%` }]} /></Card>
                <Card size="small" title="API 指标"><Table size="small" pagination={false} rowKey="k" dataSource={[...Object.entries(d.metrics.counters).map(([k, v]) => ({ k, v })), ...Object.entries<any>(d.metrics.latency).map(([k, v]) => ({ k, v: `${v.avgMs.toFixed(1)} ms × ${v.count}` }))]} columns={[{ title: "指标", dataIndex: "k" }, { title: "值", dataIndex: "v" }]} /></Card>
            </div>
        </div>
    );
}
