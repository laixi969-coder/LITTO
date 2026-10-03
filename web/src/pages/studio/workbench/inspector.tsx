import { useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Tag } from "antd";
import { Lock, RotateCcw } from "lucide-react";

import { api } from "@/services/api/filmflow";
import { Media } from "./media";
import { ShotInspector } from "./shot-inspector";
import { useAsk } from "./use-ask";
import { useWorkbench } from "./use-workbench";

const tags = (name: string, label: string) => <Form.Item name={name} label={label} className="!mb-2"><Select mode="tags" size="small" /></Form.Item>;
const txt = (name: string, label: string, rows = 0) => <Form.Item name={name} label={label} className="!mb-2">{rows ? <Input.TextArea rows={rows} size="small" /> : <Input size="small" />}</Form.Item>;

function WorldForm() {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const [f] = Form.useForm();
    useEffect(() => f.setFieldsValue(wb.world), [wb.world, f]);
    const save = async () => { try { await api.put(`/projects/${wb.pid}/world`, f.getFieldsValue()); message.success("World 已保存"); await wb.reload(); } catch (e: any) { message.error(e.message); } };
    return (
        <Form form={f} layout="vertical" size="small" className="p-3">
            <div className="mb-2 text-xs opacity-60">World：整部影片共享的物理与文化设定，所有镜头的编译都会引用它。</div>
            {txt("era", "年代")}{txt("locationLogic", "地点逻辑", 2)}{txt("architecture", "建筑")}{txt("culture", "文化")}{txt("weather", "天气")}{txt("time", "时间")}{txt("material", "材质")}{txt("physics", "物理")}{txt("realism", "真实性")}{tags("environmentalConstraints", "环境约束")}
            <Button type="primary" block onClick={save}>保存 World</Button>
        </Form>
    );
}

function LookForm({ selId }: { selId?: string }) {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const [f] = Form.useForm();
    // "shot:<id>" is a not-yet-created shot override (from the shot inspector link).
    const pre = selId?.startsWith("shot:") ? selId.slice(5) : null;
    const preOwn = pre ? wb.looks.find((l) => l.scope === "shot" && l.scopeId === pre) : null;
    const [scope, setScope] = useState<"project" | "sequence" | "shot">(pre ? "shot" : "project");
    const [target, setTarget] = useState<string | undefined>(pre ?? undefined);
    useEffect(() => { if (pre) { setScope("shot"); setTarget(pre); } }, [pre]);
    const found = wb.looks.find((l) => l.scope === scope && (scope === "project" || l.scopeId === target));
    const base = wb.looks.find((l) => l.scope === "project");
    useEffect(() => { f.resetFields(); f.setFieldsValue(found ?? (scope === "project" ? base : {})); }, [found, scope, target, f, preOwn]);
    const save = async () => {
        if (scope !== "project" && !target) return message.info(scope === "shot" ? "选择镜头" : "选择序列");
        try { await api.put(`/projects/${wb.pid}/looks/${scope}${scope === "project" ? "" : `/${target}`}`, f.getFieldsValue()); message.success(scope === "project" ? "Look 已保存" : "覆盖已保存（仅填写的字段与项目不同）"); await wb.reload(); } catch (e: any) { message.error(e.message); }
    };
    return (
        <Form form={f} layout="vertical" size="small" className="p-3">
            <div className="mb-2 text-xs opacity-60">Look：项目级影调。序列 / 镜头可显式覆盖，编译时优先取镜头 &gt; 序列 &gt; 项目。</div>
            <div className="mb-2 flex gap-2"><Select size="small" className="!w-24" value={scope} onChange={(v) => { setScope(v); setTarget(undefined); }} options={[{ value: "project", label: "项目" }, { value: "sequence", label: "序列" }, { value: "shot", label: "镜头" }]} />
                {scope === "sequence" && <Select size="small" className="flex-1" placeholder="选择序列" value={target} onChange={setTarget} options={wb.sequences.map((q) => ({ value: q.id, label: `${q.name}${wb.looks.some((l) => l.scope === "sequence" && l.scopeId === q.id) ? " ·覆盖" : ""}` }))} />}
                {scope === "shot" && <Select size="small" className="flex-1" placeholder="选择镜头" value={target} onChange={setTarget} options={wb.shots.map((s) => ({ value: s.id, label: `#${s.ord + 1} ${s.title || s.narrativeFunction}${wb.looks.some((l) => l.scope === "shot" && l.scopeId === s.id) ? " ·覆盖" : ""}` }))} />}</div>
            {scope !== "project" && !found && <div className="mb-2 rounded bg-black/5 p-2 text-xs dark:bg-white/10">尚无覆盖，保存后创建。未填写的字段会是空值（编译时按空处理），建议从项目 Look 复制需要的字段。<Button size="small" type="link" onClick={() => f.setFieldsValue(base)}>复制项目 Look</Button></div>}
            <div className="grid grid-cols-2 gap-x-2">{txt("contrast", "对比度")}{txt("saturation", "饱和度")}{txt("skinTone", "肤色")}{txt("blackLevel", "黑位")}{txt("highlightRolloff", "高光滚降")}{txt("shadowBehavior", "暗部")}{txt("grain", "颗粒")}{txt("halation", "光晕 halation")}{txt("bloom", "bloom")}{txt("lensCharacter", "镜头性格")}{txt("texture", "质感")}{txt("sharpnessPhilosophy", "锐度哲学")}</div>
            {tags("palette", "色板")}
            <Button type="primary" block onClick={save}>保存 {scope === "project" ? "Look" : "覆盖"}</Button>
        </Form>
    );
}

function AssetInspector({ id }: { id: string }) {
    const wb = useWorkbench();
    const { message, modal } = App.useApp();
    const ask = useAsk();
    const [a, setA] = useState<any>(null);
    const [f] = Form.useForm();
    const load = async () => { const x = await api.get(`/assets/${id}`); setA(x); f.setFieldsValue(x); };
    useEffect(() => { setA(null); void load(); }, [id]);
    if (!a) return <div className="p-4 text-xs opacity-50">加载中…</div>;
    const locked = a.approvalStatus === "approved";
    const act = (fn: () => Promise<any>, ok?: string) => async () => { try { await fn(); ok && message.success(ok); await load(); await wb.reload(); } catch (e: any) { message.error(e.message); } };
    return (
        <div className="space-y-2 p-3">
            <div className="flex items-center gap-2"><b>{a.name}</b><Tag className="!m-0">{a.type}</Tag><Tag className="!m-0">v{a.version}</Tag>{locked ? <Tag color="green" className="!m-0"><Lock size={10} className="inline" /> Approved · LOCK</Tag> : <Tag className="!m-0">draft</Tag>}</div>
            {locked && <div className="rounded bg-emerald-500/10 p-2 text-xs">已批准，默认 LOCK：不能原地修改。需要改动请新建版本或变体。</div>}
            <Form form={f} layout="vertical" size="small" disabled={locked}>
                {txt("description", "描述", 2)}{tags("invariants", "Invariants（必须不变）")}{tags("allowedVariations", "Allowed variations")}{tags("forbiddenChanges", "Forbidden changes")}
                <Form.Item name="references" label="参考" className="!mb-2"><Select mode="multiple" size="small" options={wb.refs.map((r) => ({ value: r.id, label: r.name ?? r.text?.slice(0, 16) }))} /></Form.Item>
            </Form>
            <div className="flex flex-wrap gap-1">
                {!locked && <Button size="small" onClick={act(() => api.patch(`/assets/${id}`, { description: f.getFieldValue("description"), invariants: f.getFieldValue("invariants"), allowedVariations: f.getFieldValue("allowedVariations"), forbiddenChanges: f.getFieldValue("forbiddenChanges"), references: f.getFieldValue("references") }), "已保存")}>保存</Button>}
                {!locked && <Button size="small" type="primary" onClick={act(() => api.post(`/assets/${id}/approve`), "已批准并锁定")}>批准（LOCK）</Button>}
                {locked && <Button size="small" onClick={act(() => api.post(`/assets/${id}/versions`, {}), "已创建新版本（草稿）")}>新版本</Button>}
                <Button size="small" onClick={async () => { const name = await ask("变体名称"); if (name) void act(() => api.post(`/assets/${id}/variants`, { name }), "变体已创建")(); }}>变体</Button>
                <Button size="small" danger onClick={() => modal.confirm({ title: `删除「${a.name}」？`, content: locked ? "这是已批准资产，引用它的镜头将失去它。" : undefined, okType: "danger", onOk: act(async () => { await api.del(`/assets/${id}${locked ? "?confirm=1" : ""}`); wb.select(null); }) })}>删除</Button>
            </div>
            <div className="border-t border-black/10 pt-2 text-xs dark:border-white/10"><div className="mb-1 font-medium">版本历史</div>
                {[...a.versions].reverse().map((v: any) => <div key={v.version} className="flex items-center gap-2 py-0.5">v{v.version} <Tag className="!m-0">{v.approvalStatus}</Tag><span className="opacity-50">{new Date(v.createdAt).toLocaleString()}</span>{v.approvalStatus === "approved" && v.version !== a.version && <Button size="small" type="text" icon={<RotateCcw size={11} />} onClick={act(() => api.post(`/assets/${id}/rollback`, { version: v.version }), `已回滚到 v${v.version}（作为新版本）`)}>回滚</Button>}</div>)}</div>
        </div>
    );
}

function ReferenceInspector({ id }: { id: string }) {
    const wb = useWorkbench();
    const r = wb.refs.find((x) => x.id === id);
    if (!r) return null;
    return <div className="space-y-2 p-3 text-sm"><b>{r.name}</b> <Tag>{r.kind}</Tag><Tag>{r.source}</Tag>{r.kind === "text" ? <div className="whitespace-pre-wrap text-xs">{r.text}</div> : <Media media={r.media} className="w-full rounded" controls />}<Button size="small" danger onClick={async () => { await api.del(`/references/${id}`); wb.select(null); await wb.reload(); }}>删除</Button></div>;
}

export function Inspector() {
    const sel = useWorkbench((s) => s.sel);
    if (!sel) return <div className="p-4 text-xs leading-6 opacity-60">选中画布上的节点（World / Look / 资产 / 镜头）查看结构化属性。<br />Inspector 编辑的是领域对象；画布只记录坐标。</div>;
    if (sel.kind === "world") return <WorldForm />;
    if (sel.kind === "look") return <LookForm selId={sel.id} />;
    if (sel.kind === "asset") return <AssetInspector id={sel.id} />;
    if (sel.kind === "shot") return <ShotInspector key={sel.id} id={sel.id} />;
    return <ReferenceInspector id={sel.id} />;
}
void Modal;
