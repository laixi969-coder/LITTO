import { useEffect, useState } from "react";
import { App, Button, Input, Segmented } from "antd";
import { Archive, Copy, FolderOpen, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { api } from "@/services/api/filmflow";

type P = { id: string; name: string; status: string; updatedAt: string; deletedAt?: string };

export default function ProjectsPage() {
    const [tab, setTab] = useState<"active" | "archived" | "trash">("active");
    const [items, setItems] = useState<P[]>([]);
    const [name, setName] = useState("");
    const { message, modal } = App.useApp();
    const nav = useNavigate();
    const load = async () => setItems(tab === "trash" ? await api.get("/projects/trash") : await api.get(`/projects${tab === "archived" ? "?archived=1" : ""}`));
    useEffect(() => void load().catch((e) => message.error(e.message)), [tab]);
    const act = (fn: () => Promise<any>, ok?: string) => async () => { try { await fn(); ok && message.success(ok); await load(); } catch (e: any) { message.error(e.message); } };
    const create = async () => { if (!name.trim()) return; const p = await api.post("/projects", { name }); nav(`/studio/p/${p.id}`); };

    return (
        <div className="mx-auto h-full max-w-5xl overflow-auto p-8">
            <div className="mb-6 flex items-center gap-3">
                <h1 className="text-xl font-semibold">项目</h1>
                <Segmented value={tab} onChange={(v) => setTab(v as any)} options={[{ label: "进行中", value: "active" }, { label: "已归档", value: "archived" }, { label: "回收站", value: "trash" }]} />
                <div className="flex-1" />
                <Input className="!w-56" placeholder="新项目名称" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} />
                <Button type="primary" icon={<Plus size={14} />} onClick={create}>新建</Button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {items.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
                        <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{p.name}</div>
                            <div className="text-xs opacity-50">{new Date(p.deletedAt ?? p.updatedAt).toLocaleString()}</div>
                        </div>
                        {tab !== "trash" ? <>
                            <Button type="text" icon={<FolderOpen size={15} />} onClick={() => nav(`/studio/p/${p.id}`)} title="打开" />
                            <Button type="text" icon={<Copy size={15} />} title="复制" onClick={act(() => api.post(`/projects/${p.id}/duplicate`), "已复制")} />
                            <Button type="text" icon={<Archive size={15} />} title={tab === "archived" ? "取消归档" : "归档"} onClick={act(() => api.patch(`/projects/${p.id}`, { status: tab === "archived" ? "active" : "archived" }))} />
                            <Button type="text" danger icon={<Trash2 size={15} />} title="移到回收站" onClick={act(() => api.del(`/projects/${p.id}`), "已移到回收站")} />
                        </> : <>
                            <Button type="text" icon={<RotateCcw size={15} />} title="恢复" onClick={act(() => api.post(`/projects/${p.id}/restore`), "已恢复")} />
                            <Button type="text" danger icon={<Trash2 size={15} />} title="永久删除" onClick={() => modal.confirm({ title: `永久删除「${p.name}」？`, content: "所有资产、镜头、生成记录和媒体文件都会被清除，无法恢复。", okType: "danger", onOk: act(() => api.del(`/projects/${p.id}/permanent`), "已永久删除") })} />
                        </>}
                    </div>
                ))}
                {!items.length && <div className="col-span-full py-16 text-center text-sm opacity-50">{tab === "active" ? "还没有项目，起个名字开始制片。" : "空"}</div>}
            </div>
        </div>
    );
}
