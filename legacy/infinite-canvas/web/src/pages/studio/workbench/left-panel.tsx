import { useRef, useState } from "react";
import { App, Button, Collapse, Form, Input, Modal, Progress, Select, Tabs, Tag } from "antd";
import { Lock, Plus, Upload } from "lucide-react";

import { api, uploadMedia } from "@/services/api/litto";
import { Media } from "./media";
import { useWorkbench } from "./use-workbench";

const TYPES = ["Character", "Wardrobe", "Environment", "Prop", "Product", "Vehicle", "Creature", "Custom"];

function NewAsset({ onClose }: { onClose: () => void }) {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const [f] = Form.useForm();
    const suggest = async () => {
        const v = f.getFieldsValue();
        if (!v.name || !v.type) return message.info("先填名称和类型");
        const s = await api.post(`/projects/${wb.pid}/assets/suggest`, { type: v.type, name: v.name, description: v.description ?? "" });
        f.setFieldsValue({ invariants: s.invariants, allowedVariations: s.allowedVariations, forbiddenChanges: s.forbiddenChanges });
        message.success(`Asset Director 建议：需要的视图 ${s.requiredViews.join(" / ")}`);
    };
    const ok = async () => {
        const v = await f.validateFields();
        try {
            if (!v.invariants?.length) { const sug = await api.post(`/projects/${wb.pid}/assets/suggest`, { type: v.type, name: v.name, description: v.description ?? "" }); Object.assign(v, { invariants: sug.invariants, allowedVariations: sug.allowedVariations, forbiddenChanges: sug.forbiddenChanges }); }
            const a = await api.post(`/projects/${wb.pid}/assets`, { type: v.type, name: v.name, description: v.description ?? "", references: v.references ?? [], invariants: v.invariants ?? [], allowedVariations: v.allowedVariations ?? [], forbiddenChanges: v.forbiddenChanges ?? [], attributes: v.wornBy ? { wornBy: v.wornBy } : {} });
            await wb.reload(); wb.select({ kind: "asset", id: a.id }); onClose();
        } catch (e: any) { message.error(e.message); }
    };
    const chars = wb.assets.filter((a) => a.type === "Character");
    return (
        <Modal open title="新建资产" onOk={ok} onCancel={onClose} okText="创建" width={560}>
            <Form form={f} layout="vertical" initialValues={{ type: "Character" }}>
                <div className="grid grid-cols-2 gap-3">
                    <Form.Item name="type" label="类型"><Select options={TYPES.map((t) => ({ value: t }))} /></Form.Item>
                    <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
                </div>
                <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
                <Form.Item noStyle shouldUpdate={(a, b) => a.type !== b.type}>{({ getFieldValue }) => getFieldValue("type") === "Wardrobe" && <Form.Item name="wornBy" label="穿着者"><Select allowClear options={chars.map((c) => ({ value: c.id, label: c.name }))} /></Form.Item>}</Form.Item>
                <div className="mb-2 text-xs opacity-60">创建后会自动填好「必须保持不变」的要点并锁定；想自定义再展开高级。</div>
                <Collapse ghost size="small" items={[{ key: "adv", forceRender: true, label: "高级（参考图 / 不变量 / 允许与禁止变化）", children: <>
                <Form.Item name="references" label="参考图（它是谁）"><Select mode="multiple" options={wb.refs.map((r) => ({ value: r.id, label: r.name ?? r.text?.slice(0, 20) ?? r.id }))} /></Form.Item>
                <div className="mb-2 flex items-center justify-between text-sm"><span>不变量 / 允许变化 / 禁止变化</span><Button size="small" onClick={suggest}>智能填充</Button></div>
                <Form.Item name="invariants" label="Invariants（必须不变）"><Select mode="tags" /></Form.Item>
                <Form.Item name="allowedVariations" label="Allowed variations"><Select mode="tags" /></Form.Item>
                <Form.Item name="forbiddenChanges" label="Forbidden changes"><Select mode="tags" /></Form.Item></> }]} />
            </Form>
        </Modal>
    );
}

function Assets() {
    const wb = useWorkbench();
    const [open, setOpen] = useState(false);
    return (
        <div className="space-y-1 p-2">
            <Button size="small" block icon={<Plus size={13} />} onClick={() => setOpen(true)}>新建资产</Button>
            {TYPES.map((t) => {
                const list = wb.assets.filter((a) => a.type === t);
                if (!list.length) return null;
                return (
                    <div key={t}>
                        <div className="mt-2 px-1 text-[11px] uppercase opacity-50">{t}</div>
                        {list.map((a) => (
                            <button key={a.id} onClick={() => wb.select({ kind: "asset", id: a.id })} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10 ${wb.sel?.id === a.id ? "bg-black/5 dark:bg-white/10" : ""}`}>
                                <span className="flex-1 truncate">{a.name}</span>
                                {a.approvalStatus === "approved" ? <Lock size={12} className="text-emerald-500" /> : <Tag className="!m-0 !text-[10px]">draft</Tag>}
                                <span className="text-[10px] opacity-50">v{a.version}</span>
                            </button>
                        ))}
                    </div>
                );
            })}
            {!wb.assets.length && <div className="p-4 text-center text-xs opacity-50">从角色、场景、道具开始建立「它是谁」，审批后即锁定。</div>}
            {open && <NewAsset onClose={() => setOpen(false)} />}
        </div>
    );
}

function Sequences() {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const [name, setName] = useState("");
    const add = async () => { if (!name) return; const s = await api.post(`/projects/${wb.pid}/sequences`, { name }); setName(""); wb.setActiveSeq(s.id); await wb.reload(); };
    const addShot = async (sequenceId: string) => { try { const s = await api.post(`/projects/${wb.pid}/shots`, { sequenceId, title: "新镜头" }); await wb.reload(); wb.select({ kind: "shot", id: s.id }); } catch (e: any) { message.error(e.message); } };
    return (
        <div className="space-y-2 p-2">
            <div className="flex gap-1"><Input size="small" placeholder="新序列" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={add} /><Button size="small" onClick={add}>+</Button></div>
            {wb.sequences.map((q) => (
                <div key={q.id}>
                    <div className="flex items-center justify-between px-1 text-xs"><button className={`font-medium ${wb.activeSeq === q.id ? "underline" : ""}`} onClick={() => wb.setActiveSeq(q.id)}>{q.name}</button><Button type="text" size="small" onClick={() => addShot(q.id)}>+ 镜头</Button></div>
                    {wb.shots.filter((s) => s.sequenceId === q.id).map((s) => (
                        <button key={s.id} onClick={() => wb.select({ kind: "shot", id: s.id })} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10 ${wb.sel?.id === s.id ? "bg-black/5 dark:bg-white/10" : ""}`}>
                            <span className="w-5 opacity-50">{s.ord + 1}</span><span className="flex-1 truncate">{s.title || s.narrativeFunction}</span>
                            {s.issues?.some((i: any) => i.severity === "high") && <span className="h-2 w-2 rounded-full bg-red-500" />}
                            <span className="opacity-50">{s.status}</span>
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}

function References() {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const input = useRef<HTMLInputElement>(null);
    const [text, setText] = useState("");
    const [progress, setProgress] = useState<Record<string, number>>({});
    const upload = async (files: FileList | null) => {
        try {
            for (const file of Array.from(files ?? [])) {
                const key = `${file.name}:${file.size}:${Math.random()}`;
                setProgress((p) => ({ ...p, [key]: 0 }));
                const m = await uploadMedia(file, wb.pid, (pct) => setProgress((p) => ({ ...p, [key]: pct }))).finally(() => setProgress((p) => { const { [key]: _x, ...rest } = p; return rest; }));
                await api.post(`/projects/${wb.pid}/references`, { kind: m.mime.startsWith("video/") ? "video" : m.mime.startsWith("audio/") ? "audio" : "image", name: file.name, mediaId: m.id });
            }
            await wb.reload();
        } catch (e: any) { message.error(e.message); setProgress({}); }
    };
    const addText = async () => { if (!text.trim()) return; await api.post(`/projects/${wb.pid}/references`, { kind: "text", name: text.slice(0, 20), text }); setText(""); await wb.reload(); };
    return (
        <div className="space-y-2 p-2">
            <input ref={input} type="file" hidden multiple accept="image/*,video/*,audio/*" onChange={(e) => upload(e.target.files)} />
            <Button size="small" block icon={<Upload size={13} />} onClick={() => input.current?.click()}>上传参考（图/视频/音频）</Button>
            {Object.entries(progress).map(([k, pct]) => <div key={k} className="text-[11px]"><div className="truncate opacity-70">{k.split(":")[0]}</div><Progress size="small" percent={pct} /></div>)}
            <div className="flex gap-1"><Input size="small" placeholder="文字参考" value={text} onChange={(e) => setText(e.target.value)} onPressEnter={addText} /><Button size="small" onClick={addText}>+</Button></div>
            <div className="text-[11px] opacity-50">拖到画布上的镜头节点，选择「参考什么」。</div>
            <div className="grid grid-cols-2 gap-2">
                {wb.refs.map((r) => (
                    <div key={r.id} draggable onDragStart={(e) => e.dataTransfer.setData("application/x-litto-ref", r.id)} onClick={() => wb.select({ kind: "reference", id: r.id })} className="cursor-grab overflow-hidden rounded border border-black/10 dark:border-white/10">
                        {r.kind === "text" ? <div className="h-16 overflow-hidden p-1 text-[11px] opacity-70">{r.text}</div> : <Media media={r.media} className="h-16 w-full" />}
                        <div className="truncate px-1 py-0.5 text-[11px]">{r.name}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function LeftPanel() {
    return <Tabs size="small" className="h-full [&_.ant-tabs-nav]:!mb-0 [&_.ant-tabs-nav]:!px-2" items={[{ key: "a", label: "资产", children: <Assets /> }, { key: "s", label: "序列", children: <Sequences /> }, { key: "r", label: "参考", children: <References /> }]} />;
}
