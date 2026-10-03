import { useEffect, useState } from "react";
import { App, Button, Input, Popconfirm, Switch, Table, Tag } from "antd";

import { api } from "@/services/api/filmflow";
import { time, useAct, useLoad } from "./util";

const EXAMPLE = {
    slug: "acme-example-skill", name: "Example Skill", version: "1.0.0", author: "ACME", description: "Suggests a camera lens for a shot.", target: "shot",
    inputSchema: { type: "object", properties: { style: { type: "string", enum: ["documentary", "dramatic"], description: "Visual style" } }, required: ["style"] },
    outputSchema: { type: "object", properties: { camera: { type: "object", properties: { lensMm: { type: "number" }, motion: { type: "string" } }, required: ["lensMm"] }, why: { type: "string" } }, required: ["camera"] },
    systemPrompt: "You are a cinematographer. Reply ONLY with JSON matching the requested fields.",
    promptTemplate: "Shot: {{shot.title}} ({{shot.narrativeFunction}}). Action: {{shot.action}}. Current lens: {{shot.camera.lensMm}}mm. Style: {{input.style}}. Suggest a lens and camera motion.",
    apply: [{ to: "shot.camera", from: "/camera" }],
};

/** Publish / manage declarative skill packages. The server validates every manifest strictly; its message is shown live. */
export default function AdminMarket() {
    const { message } = App.useApp();
    const { data, loading, reload } = useLoad<any[]>(() => api.get("/admin/skills"));
    const act = useAct(reload);
    const [text, setText] = useState(JSON.stringify(EXAMPLE, null, 2));
    const [problem, setProblem] = useState<string[]>([]);
    const [asDraft, setAsDraft] = useState(false);
    const [busy, setBusy] = useState(false);

    // Live JSON syntax check; schema/whitelist validation messages come from the server when publishing.
    useEffect(() => {
        try { JSON.parse(text); setProblem([]); } catch (e: any) { setProblem([`JSON 语法错误：${e.message}`]); }
    }, [text]);
    const publish = async () => {
        let manifest: any;
        try { manifest = JSON.parse(text); } catch { return; }
        setBusy(true);
        try { const r = await api.post("/admin/skills", { manifest, status: asDraft ? "draft" : "published" }); message.success(`已${asDraft ? "保存草稿" : "发布"}：${r.slug}@${r.version}`); setProblem([]); await reload(); }
        catch (e: any) { setProblem(Array.isArray(e.details) ? e.details : [e.message]); }
        setBusy(false);
    };
    return (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div>
                <Table size="small" loading={loading} rowKey="id" dataSource={data} pagination={false} scroll={{ x: true }} columns={[
                    { title: "Skill", render: (_, r) => <div><b>{r.name}</b><div className="text-xs opacity-60">{r.slug}@{r.version}</div></div> },
                    { title: "目标", render: (_, r) => <Tag>{r.manifest.target}</Tag> }, { title: "安装", dataIndex: "installs" }, { title: "更新", dataIndex: "createdAt", render: time },
                    { title: "已发布", render: (_, r) => <Switch size="small" checked={r.status === "published"} onChange={(v) => act(() => api.patch(`/admin/skills/${r.id}`, { status: v ? "published" : "draft" }), v ? "已发布" : "已下架")()} /> },
                    { title: "", render: (_, r) => <div className="flex gap-1"><Button size="small" type="link" onClick={() => setText(JSON.stringify(r.manifest, null, 2))}>编辑</Button><Popconfirm title="删除该 Skill？所有工作区的安装也会移除。" onConfirm={act(() => api.del(`/admin/skills/${r.id}`), "已删除")}><Button size="small" type="link" danger>删除</Button></Popconfirm></div> },
                ]} />
            </div>
            <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm"><b>发布 / 更新 Skill 清单</b><div className="flex-1" /><Button size="small" onClick={() => setText(JSON.stringify(EXAMPLE, null, 2))}>载入示例</Button></div>
                <div className="text-xs opacity-60">同一 slug + version 再次发布会原地更新。提示词只能引用白名单字段（shot / asset / world / sequence / project 的部分属性与 input.*），其他占位符会被拒绝。</div>
                <Input.TextArea rows={22} className="font-mono !text-xs" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
                {problem.length > 0 && <ul className="list-disc pl-5 text-xs text-red-500">{problem.map((p) => <li key={p}>{p}</li>)}</ul>}
                <div className="flex items-center gap-3"><Button type="primary" loading={busy} disabled={problem.some((p) => p.startsWith("JSON"))} onClick={publish}>{asDraft ? "保存草稿" : "发布"}</Button><label className="text-xs">仅存为草稿 <Switch size="small" checked={asDraft} onChange={setAsDraft} /></label></div>
            </div>
        </div>
    );
}
