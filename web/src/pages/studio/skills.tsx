import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Drawer, Empty, Form, Input, InputNumber, Select, Switch, Tag } from "antd";
import { Play, Puzzle } from "lucide-react";

import { api } from "@/services/api/ovia";
import { useOviaStore } from "@/stores/use-ovia-store";

type Skill = { id: string; slug: string; name: string; version: string; author: string; description: string; builtin: boolean; target: string; runnable: boolean; installed?: boolean; inputSchema?: any; apply?: { to: string; from: string }[] };
const TARGET_LABEL: Record<string, string> = { shot: "镜头", asset: "资产", sequence: "序列", project: "项目" };

function InputForm({ schema, value, onChange }: { schema?: any; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
    const props = Object.entries<any>(schema?.properties ?? {});
    if (!props.length) return <div className="text-xs opacity-60">此 Skill 不需要额外输入。</div>;
    return (
        <Form layout="vertical" size="small">
            {props.map(([k, p]) => (
                <Form.Item key={k} label={`${k}${schema.required?.includes(k) ? " *" : ""}`} extra={p.description} className="!mb-2">
                    {p.enum ? <Select allowClear value={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} options={p.enum.map((x: any) => ({ value: x }))} />
                        : p.type === "number" ? <InputNumber className="!w-full" value={value[k]} onChange={(v) => onChange({ ...value, [k]: v ?? undefined })} />
                        : p.type === "boolean" ? <Switch checked={!!value[k]} onChange={(v) => onChange({ ...value, [k]: v })} />
                        : <Input.TextArea rows={2} value={value[k] ?? ""} onChange={(e) => onChange({ ...value, [k]: e.target.value || undefined })} />}
                </Form.Item>
            ))}
        </Form>
    );
}

function RunDrawer({ skill, onClose }: { skill: Skill; onClose: () => void }) {
    const { message, modal } = App.useApp();
    const [projects, setProjects] = useState<any[]>([]);
    const [pid, setPid] = useState<string>();
    const [items, setItems] = useState<any[]>([]);
    const [targetId, setTargetId] = useState<string>();
    const [input, setInput] = useState<Record<string, any>>({});
    const [res, setRes] = useState<any>(null);
    const [picked, setPicked] = useState<number[]>([]);
    const [busy, setBusy] = useState(false);
    const [errs, setErrs] = useState<string[]>([]);
    useEffect(() => void api.get("/projects").then(setProjects).catch((e) => message.error(e.message)), []);
    useEffect(() => {
        setItems([]); setTargetId(undefined);
        if (!pid || skill.target === "project") return;
        const path = { shot: "shots", asset: "assets", sequence: "sequences" }[skill.target];
        void api.get(`/projects/${pid}/${path}`).then(setItems).catch((e) => message.error(e.message));
    }, [pid, skill.target]);
    const idKey = `${skill.target}Id`;
    const body = () => ({ input, ...(skill.target === "project" ? { projectId: pid } : { [idKey]: targetId }) });

    const run = async () => {
        setBusy(true); setErrs([]); setRes(null);
        try { const r = await api.post(`/skills/${skill.id}/run`, body()); setRes(r); setPicked(r.patches.map((_: any, i: number) => i)); }
        catch (e: any) { setErrs(Array.isArray(e.details) ? e.details : [e.message]); message.error(e.message); }
        setBusy(false);
    };
    const apply = async (confirm = false) => {
        try {
            await api.post(`/skills/${skill.id}/apply`, { patches: picked.map((i) => res.patches[i]), [idKey]: targetId, confirm });
            message.success("已应用"); setRes(null);
        } catch (e: any) {
            if (e.code === "needs_confirmation") modal.confirm({ title: "改变核心镜头意图", content: "该镜头已有 Hero Frame / Approved Take，应用会影响它们。确认继续？", okType: "danger", onOk: () => apply(true) });
            else if (e.code === "asset_locked") message.error("该资产已批准并锁定，请先在工作台创建新版本");
            else message.error(e.message);
        }
    };
    const needsTarget = skill.target !== "project";
    return (
        <Drawer open width={560} title={`运行：${skill.name}`} onClose={onClose}>
            <div className="mb-3 text-xs opacity-70">{skill.description}</div>
            <div className="grid grid-cols-2 gap-2">
                <Select placeholder="项目" value={pid} onChange={setPid} options={projects.map((p) => ({ value: p.id, label: p.name }))} />
                {needsTarget && <Select placeholder={`选择${TARGET_LABEL[skill.target]}`} value={targetId} onChange={setTargetId} options={items.map((x) => ({ value: x.id, label: skill.target === "shot" ? `#${x.ord + 1} ${x.title || x.narrativeFunction}` : x.name }))} />}
            </div>
            <div className="mt-3"><InputForm schema={skill.inputSchema} value={input} onChange={setInput} /></div>
            <Button type="primary" className="mt-3" icon={<Play size={14} />} loading={busy} disabled={!pid || (needsTarget && !targetId)} onClick={run}>运行</Button>
            {errs.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-red-500">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
            {res && (
                <div className="mt-4 space-y-3">
                    <div><div className="mb-1 text-xs font-medium opacity-60">输出（已按 outputSchema 校验）{res.model && <Tag className="!ml-2">{res.model}</Tag>}</div><pre className="max-h-60 overflow-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">{JSON.stringify(res.output, null, 1)}</pre></div>
                    {res.patches.length > 0 ? (
                        <div>
                            <div className="mb-1 text-xs font-medium opacity-60">补丁预览（运行本身不会修改任何数据，勾选后再应用）</div>
                            {res.patches.map((p: any, i: number) => (
                                <label key={i} className="mb-1 flex gap-2 rounded border border-black/10 p-2 text-xs dark:border-white/10">
                                    <Checkbox checked={picked.includes(i)} onChange={(e) => setPicked(e.target.checked ? [...picked, i] : picked.filter((x) => x !== i))} />
                                    <div className="min-w-0 flex-1"><b>{p.to}</b><pre className="m-0 overflow-auto whitespace-pre-wrap">{JSON.stringify(p.value)}</pre></div>
                                </label>
                            ))}
                            <Button type="primary" disabled={!picked.length || !targetId} onClick={() => apply(false)}>应用选中的补丁</Button>
                        </div>
                    ) : <div className="text-xs opacity-60">此 Skill 只产出建议，没有可应用的补丁。</div>}
                </div>
            )}
        </Drawer>
    );
}

/** Skills marketplace: built-in directors + published third-party (declarative) skills. */
export default function SkillsPage() {
    const { message } = App.useApp();
    const role = useOviaStore((s) => s.role);
    const canInstall = role === "OWNER" || role === "ADMIN";
    const [list, setList] = useState<Skill[]>([]);
    const [q, setQ] = useState("");
    const [run, setRun] = useState<Skill | null>(null);
    const load = () => api.get("/skills").then(setList).catch((e) => message.error(e.message));
    useEffect(() => void load(), []);
    const shown = useMemo(() => list.filter((s) => `${s.name} ${s.slug} ${s.description} ${s.author}`.toLowerCase().includes(q.toLowerCase())), [list, q]);
    const toggle = async (s: Skill, on: boolean) => { try { await (on ? api.post(`/skills/${s.id}/install`) : api.del(`/skills/${s.id}/install`)); message.success(on ? "已安装" : "已卸载"); await load(); } catch (e: any) { message.error(e.message); } };
    return (
        <div className="mx-auto h-full max-w-5xl overflow-auto p-8">
            <div className="mb-4 flex items-center gap-3"><Puzzle size={18} /><h1 className="text-xl font-semibold">Skills</h1><div className="flex-1" /><Input.Search className="!w-64" placeholder="搜索" allowClear onChange={(e) => setQ(e.target.value)} /></div>
            <p className="mb-4 text-xs opacity-60">Skills 是声明式包（提示词模板 + 输入/输出 Schema + 应用映射），不会执行任何第三方代码；输出经校验后以补丁预览形式给出，由你确认应用。{!canInstall && " 安装需要工作区 ADMIN 及以上角色。"}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {shown.map((s) => (
                    <div key={s.id} className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/10">
                        <div className="flex items-center gap-2"><b className="truncate">{s.name}</b>{s.builtin ? <Tag color="blue" className="!m-0">内置</Tag> : <Tag className="!m-0">v{s.version}</Tag>}<Tag className="!m-0">{TARGET_LABEL[s.target]}</Tag><div className="flex-1" />
                            {!s.builtin && <Switch size="small" disabled={!canInstall} checked={!!s.installed} onChange={(v) => toggle(s, v)} checkedChildren="已装" unCheckedChildren="未装" />}</div>
                        <div className="text-xs opacity-70">{s.description}</div>
                        <div className="flex items-center text-[11px] opacity-50"><span>{s.author}</span><div className="flex-1" /><Button size="small" disabled={!s.runnable || !s.installed} onClick={() => setRun(s)}>{s.runnable ? "运行" : "见 Director / QC"}</Button></div>
                    </div>
                ))}
                {!shown.length && <div className="col-span-full"><Empty description="没有匹配的 Skill" /></div>}
            </div>
            {run && <RunDrawer skill={run} onClose={() => setRun(null)} />}
        </div>
    );
}
