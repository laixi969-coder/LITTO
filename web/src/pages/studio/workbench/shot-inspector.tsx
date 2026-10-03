import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Slider, Tabs, Tag } from "antd";
import { Check, Crown, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";

import { api } from "@/services/api/filmflow";
import { ROLES } from "./bind-dialog";
import { Media } from "./media";
import { useAsk } from "./use-ask";
import { useWorkbench } from "./use-workbench";

const FUNCS = ["Establish", "Reveal", "Reaction", "Contrast", "Transition", "Match", "Rhythm"];
const SIZES = ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS"];
const sev = (s: string) => (s === "high" ? "red" : s === "medium" ? "orange" : "default");

/** Shot detail + polling while any of its jobs are pending. */
function useShot(id: string) {
    const reload = useWorkbench((s) => s.reload);
    const [d, setD] = useState<any>(null);
    const [poll, setPoll] = useState(0);
    const refresh = useCallback(async () => setD(await api.get(`/shots/${id}`)), [id]);
    useEffect(() => { setD(null); void refresh(); }, [id, refresh]);
    useEffect(() => {
        if (!poll) return;
        const t = setInterval(async () => {
            const jobs = await api.get(`/generations?targetId=${id}`);
            await refresh(); await reload();
            if (!jobs.some((j: any) => j.status === "QUEUED" || j.status === "RUNNING")) setPoll(0);
        }, 1200);
        return () => clearInterval(t);
    }, [poll, id, refresh, reload]);
    return { d, refresh, watch: () => setPoll(1) };
}

function LookOverride({ shot }: { shot: any }) {
    const wb = useWorkbench();
    const own = wb.looks.find((l) => l.scope === "shot" && l.scopeId === shot.id);
    const seq = wb.looks.find((l) => l.scope === "sequence" && l.scopeId === shot.sequenceId);
    const eff = own ? "镜头" : seq ? "序列" : "项目";
    return <div className="mb-2 flex items-center gap-2 rounded bg-black/5 px-2 py-1 text-xs dark:bg-white/10"><span>生效 Look：<Tag className="!m-0">{eff}</Tag></span><span className="flex-1" /><Button size="small" type="link" onClick={() => wb.select({ kind: "look", id: own?.id ?? `shot:${shot.id}` })}>{own ? "编辑镜头 Look 覆盖" : "创建镜头 Look 覆盖"}</Button></div>;
}

function Spec({ shot, onSaved }: { shot: any; onSaved: () => void }) {
    const wb = useWorkbench();
    const { message, modal } = App.useApp();
    const [f] = Form.useForm();
    const [delta, setDelta] = useState(JSON.stringify(shot.intendedStateDelta ?? {}, null, 1));
    useEffect(() => { f.setFieldsValue(shot); setDelta(JSON.stringify(shot.intendedStateDelta ?? {}, null, 1)); }, [shot.id, f]);
    const save = async () => {
        const v = f.getFieldsValue(true);
        let intendedStateDelta;
        try { intendedStateDelta = JSON.parse(delta || "{}"); } catch { return message.error("State delta 不是合法 JSON"); }
        try {
            const body = { title: v.title, subtitle: v.subtitle, narrativeFunction: v.narrativeFunction, assetIds: v.assetIds, action: v.action, performance: v.performance, blocking: v.blocking, camera: v.camera, lighting: v.lighting, freedomMap: v.freedomMap, duration: v.duration, intendedStateDelta };
            const done = async () => { message.success("已保存，状态链已重算"); await wb.reload(); onSaved(); };
            try { await api.patch(`/shots/${shot.id}`, body); await done(); }
            catch (e: any) {
                if (e.code !== "needs_confirmation") throw e;
                const names: Record<string, string> = { narrativeFunction: "叙事功能", action: "动作", assetIds: "资产" };
                modal.confirm({ title: "修改核心镜头意图？", content: `你正在修改「${(e.details?.fields ?? []).map((f: string) => names[f] ?? f).join("、")}」，而该镜头已有 Hero Frame / Approved Take。已批准内容不会被覆盖，但它们可能与新意图不一致。`, okText: "确认修改", onOk: async () => { try { await api.patch(`/shots/${shot.id}`, { ...body, confirm: true }); await done(); } catch (e2: any) { message.error(e2.message); } } });
            }
        } catch (e: any) { message.error(e.message); }
    };
    const t = (label: string, name: (string | number)[], el?: React.ReactNode) => <Form.Item label={label} name={name} className="!mb-2">{el ?? <Input size="small" />}</Form.Item>;
    return (
        <Form form={f} layout="vertical" size="small" className="p-3">
            <LookOverride shot={shot} />
            {t("标题", ["title"])}
            <div className="grid grid-cols-2 gap-2">{t("叙事功能", ["narrativeFunction"], <Select size="small" options={FUNCS.map((v) => ({ value: v }))} />)}{t("时长(s)", ["duration"], <InputNumber size="small" min={1} max={30} className="!w-full" />)}</div>
            {t("资产", ["assetIds"], <Select mode="multiple" size="small" options={wb.assets.map((a) => ({ value: a.id, label: `${a.name} (${a.type})` }))} />)}
            {t("动作", ["action"], <Input.TextArea rows={2} />)}
            {t("台词 / 字幕", ["subtitle"], <Input.TextArea rows={2} placeholder="出现在成片字幕里" />)}
            <div className="mb-1 mt-2 text-xs font-medium opacity-60">表演</div>
            <div className="grid grid-cols-2 gap-2">{t("情绪", ["performance", "emotion"])}{t("强度", ["performance", "intensity"], <Slider min={0} max={1} step={0.05} />)}{t("视线 Eyeline", ["performance", "eyeline"])}{t("手势", ["performance", "gesture"])}</div>
            <div className="mb-1 mt-2 text-xs font-medium opacity-60">镜头</div>
            <div className="grid grid-cols-3 gap-2">
                {t("景别", ["camera", "shotSize"], <Select size="small" options={SIZES.map((v) => ({ value: v }))} />)}{t("焦段mm", ["camera", "lensMm"], <InputNumber size="small" className="!w-full" />)}{t("高度", ["camera", "height"])}
                {t("角度", ["camera", "angle"])}{t("机位", ["camera", "position"])}{t("焦点", ["camera", "focus"])}
                {t("景深", ["camera", "depth"])}{t("运动", ["camera", "motion"])}{t("运动动机", ["camera", "motivation"])}
                {t("180°轴侧", ["camera", "side"], <Select size="small" options={["A", "B", "none"].map((v) => ({ value: v }))} />)}{t("屏幕方向", ["camera", "screenDirection"], <Select size="small" options={["left", "right", "none"].map((v) => ({ value: v }))} />)}
            </div>
            <div className="mb-1 mt-2 text-xs font-medium opacity-60">灯光</div>
            <div className="grid grid-cols-3 gap-2">
                {t("动机光源", ["lighting", "motivatedLight"])}{t("主光", ["lighting", "key"])}{t("补光", ["lighting", "fill"])}
                {t("负补光", ["lighting", "negativeFill"])}{t("曝光", ["lighting", "exposure"])}{t("主光方向", ["lighting", "keyDirection"], <Select size="small" options={["left", "right", "front", "back", "top", "none"].map((v) => ({ value: v }))} />)}
                {t("时间", ["lighting", "timeOfDay"])}{t("色温", ["lighting", "colorTemp"])}{t("实景光", ["lighting", "practicals"], <Select mode="tags" size="small" />)}
            </div>
            <div className="mb-1 mt-2 text-xs font-medium opacity-60">Freedom Map（空则取默认）</div>
            {(["LOCK", "CONTROL", "ALLOW", "RANDOM"] as const).map((k) => t(k, ["freedomMap", k], <Select mode="tags" size="small" />))}
            <Form.Item label="Intended State Delta (JSON：PreviousState → Delta → ResultState)" className="!mb-2"><Input.TextArea rows={4} value={delta} onChange={(e) => setDelta(e.target.value)} className="font-mono !text-xs" /></Form.Item>
            <Button type="primary" block onClick={save}>保存镜头</Button>
        </Form>
    );
}

function Refs({ shot, onSaved }: { shot: any; onSaved: () => void }) {
    const wb = useWorkbench();
    const { message, modal } = App.useApp();
    const [add, setAdd] = useState<{ referenceId?: string; role: string }>({ role: "IDENTITY" });
    const [route, setRoute] = useState<any>(null);
    const roles = (shot.bindings ?? []).map((b: any) => b.role);
    useEffect(() => { api.post("/models/route-preview", { kind: "image", roles, projectId: wb.pid }).then(setRoute).catch(() => {}); }, [JSON.stringify(roles)]);
    const upd = async (id: string, patch: any) => { await api.patch(`/bindings/${id}`, patch); onSaved(); await wb.reload(); };
    const del = (b: any) => {
        const go = async () => { try { await api.del(`/bindings/${b.id}${b.lockLevel === "LOCK" ? "?confirm=1" : ""}`); onSaved(); await wb.reload(); } catch (e: any) { message.error(e.message); } };
        b.lockLevel === "LOCK" ? modal.confirm({ title: "移除 LOCK 绑定？", content: "这是锁定的参考（如身份），移除后模型可能漂移。", okType: "danger", onOk: go }) : go();
    };
    return (
        <div className="space-y-2 p-3 text-sm">
            {(shot.bindings ?? []).map((b: any) => {
                const r = wb.refs.find((x) => x.id === b.referenceId);
                return (
                    <div key={b.id} className="flex items-center gap-2 rounded border border-black/10 p-1.5 dark:border-white/10">
                        <Media media={r?.media} className="h-9 w-9 shrink-0 rounded" />
                        <div className="min-w-0 flex-1"><div className="truncate text-xs">{r?.name ?? r?.text}</div>
                            <div className="flex gap-1"><Select size="small" value={b.role} onChange={(v) => upd(b.id, { role: v })} options={ROLES.map((x) => ({ value: x }))} className="!w-28" /><Select size="small" value={b.lockLevel} onChange={(v) => upd(b.id, { lockLevel: v })} options={["LOCK", "CONTROL", "ALLOW", "RANDOM"].map((x) => ({ value: x }))} className="!w-24" /><InputNumber size="small" min={0} max={1} step={0.1} value={b.weight} onChange={(v) => upd(b.id, { weight: v })} className="!w-14" /></div></div>
                        <Button type="text" size="small" danger icon={<Trash2 size={13} />} onClick={() => del(b)} />
                    </div>
                );
            })}
            <div className="flex gap-1">
                <Select size="small" placeholder="选择参考" className="flex-1" value={add.referenceId} onChange={(v) => setAdd({ ...add, referenceId: v })} options={wb.refs.map((r) => ({ value: r.id, label: r.name ?? r.text?.slice(0, 16) }))} />
                <Select size="small" value={add.role} onChange={(v) => setAdd({ ...add, role: v })} options={ROLES.map((x) => ({ value: x }))} className="!w-28" />
                <Button size="small" disabled={!add.referenceId} onClick={async () => { try { await api.post(`/shots/${shot.id}/bindings`, { referenceId: add.referenceId, role: add.role, lockLevel: add.role === "IDENTITY" ? "LOCK" : "CONTROL" }); onSaved(); await wb.reload(); } catch (e: any) { message.error(e.message); } }}>绑定</Button>
            </div>
            {route && <div className="rounded bg-black/5 p-2 text-xs dark:bg-white/10"><div className="font-medium">Router 预览（图像）</div>{route.candidates.slice(0, 4).map((c: any) => <div key={c.modelId} className={c.modelId === route.chosen?.modelId ? "font-medium" : "opacity-70"}>{c.modelId === route.chosen?.modelId ? "▶ " : "· "}{c.modelId}{!c.usable && " (无凭证)"}{c.degradations.map((d: any) => <div key={d.role} className="ml-4 text-orange-600 dark:text-orange-400">降级 {d.role}: {d.strategy}</div>)}</div>)}</div>}
        </div>
    );
}

function Gen({ shot, d, refresh, watch }: { shot: any; d: any; refresh: () => void; watch: () => void }) {
    const wb = useWorkbench();
    const { message, modal } = App.useApp();
    const [compiled, setCompiled] = useState<any>(null);
    const [est, setEst] = useState<any>(null);
    const [kind, setKind] = useState<"image" | "video">("image");
    const [blocked, setBlocked] = useState<{ takeId: string; issues: any[] } | null>(null);
    const [reason, setReason] = useState("");
    useEffect(() => { api.post(`/shots/${shot.id}/estimate`, { kind, count: kind === "image" ? 3 : 2 }).then(setEst).catch(() => setEst(null)); }, [shot.id, kind, shot.bindings?.length]);
    const guard = (fn: () => Promise<any>) => async () => { try { const r = await fn(); await refresh(); await wb.reload(); return r; } catch (e: any) { message.error(e.message); } };
    const gen = (k: "keyframes" | "takes") => guard(async () => { const r = await api.post(`/shots/${shot.id}/${k}`, { count: k === "keyframes" ? 3 : 2 }); r.degradations?.length && message.warning(`模型降级：${r.degradations.map((x: any) => x.role).join(", ")}`); watch(); message.info("任务已入队，刷新页面也不会丢"); });
    const approve = async (takeId: string, overrideReason?: string) => {
        try { await api.post(`/takes/${takeId}/approve`, overrideReason ? { overrideReason } : {}); setBlocked(null); setReason(""); message.success("已批准"); await refresh(); await wb.reload(); }
        catch (e: any) { if (e.code === "continuity_blocked") setBlocked({ takeId, issues: e.details }); else message.error(e.message); }
    };
    const pendingJobs = wb.jobs.filter((j) => j.targetId === shot.id && (j.status === "QUEUED" || j.status === "RUNNING"));
    return (
        <div className="space-y-3 p-3 text-sm">
            <div className="flex items-center gap-2"><Button size="small" onClick={async () => setCompiled(await api.post(`/shots/${shot.id}/compile`, { kind }))}>查看编译后的 Prompt</Button><Select size="small" value={kind} onChange={setKind} options={[{ value: "image", label: "图像" }, { value: "video", label: "视频" }]} className="!w-20" />
                {est && <span className="text-xs opacity-70">→ {est.modelId} · 预计 {est.total.credits} 积分 (${est.total.usd.toFixed(2)})</span>}</div>
            {est?.degradations?.length > 0 && <div className="text-xs text-orange-600 dark:text-orange-400">降级：{est.degradations.map((x: any) => `${x.role} → ${x.strategy}`).join("；")}</div>}
            {compiled && <div className="space-y-1 rounded bg-black/5 p-2 text-xs dark:bg-white/10"><div className="opacity-60">Prompt 是编译产物（ShotSpec + Skills + 模型能力），不是源数据 · 模型 {compiled.modelId}</div>{compiled.compiled.warnings.map((w: string) => <div key={w} className="text-orange-600">{w}</div>)}<pre className="whitespace-pre-wrap">{compiled.compiled.prompt}</pre>
                <div>Freedom Map: {(["LOCK", "CONTROL", "ALLOW", "RANDOM"] as const).map((k) => <Tag key={k} color={k === "LOCK" ? "red" : k === "CONTROL" ? "blue" : k === "ALLOW" ? "green" : "default"}>{k} {compiled.compiled.freedomMap[k].length}</Tag>)}</div>
                {compiled.compiled.degradations.map((x: any) => <div key={x.role} className="text-orange-600">降级 {x.role}: {x.strategy}</div>)}</div>}

            <div><div className="mb-1 flex items-center gap-2"><b>Keyframe 变体</b><Button size="small" type="primary" onClick={gen("keyframes")}>生成 3 张</Button>{pendingJobs.length > 0 && <Tag color="processing">{pendingJobs.length} 个任务进行中</Tag>}</div>
                <div className="grid grid-cols-3 gap-2">{d.keyframes.map((k: any) => (
                    <div key={k.id} className={`overflow-hidden rounded border ${k.status === "hero" ? "border-indigo-500" : "border-black/10 dark:border-white/10"}`}>
                        <Media media={k.media} className="aspect-video w-full" />
                        <div className="flex items-center gap-1 p-1 text-[11px]">{k.status === "hero" ? <Tag color="blue" className="!m-0">HERO · LOCK</Tag> : <Tag className="!m-0">{k.status}</Tag>}<span className="flex-1" />
                            {k.status !== "hero" && <Button size="small" type="text" icon={<Crown size={12} />} title={k.status === "superseded" ? "回滚为 Hero" : "Promote 为 Hero Frame"} onClick={guard(() => api.post(k.status === "superseded" ? `/shots/${shot.id}/hero/rollback` : `/keyframes/${k.id}/promote`, k.status === "superseded" ? { keyframeId: k.id } : {}))} />}</div>
                    </div>))}</div></div>

            <div><div className="mb-1 flex items-center gap-2"><b>Take（基于 Hero Frame 的 I2V）</b><Button size="small" type="primary" disabled={!shot.heroKeyframeId} onClick={gen("takes")}>生成 2 个</Button>{!shot.heroKeyframeId && <span className="text-xs opacity-60">先 Promote 一张 Hero Frame</span>}</div>
                <div className="grid grid-cols-2 gap-2">{d.takes.map((t: any) => (
                    <div key={t.id} className={`overflow-hidden rounded border ${t.status === "approved" ? "border-emerald-500" : "border-black/10 dark:border-white/10"}`}>
                        <Media media={t.media} className="aspect-video w-full" controls />
                        <div className="flex items-center gap-1 p-1 text-[11px]"><Tag color={t.status === "approved" ? "green" : "default"} className="!m-0">{t.status}</Tag><span className="flex-1" />
                            {t.status === "superseded" ? <Button size="small" type="text" icon={<RotateCcw size={12} />} title="回滚到此 Take" onClick={guard(() => api.post(`/shots/${shot.id}/take/rollback`, { takeId: t.id }))} /> : t.status === "candidate" && <Button size="small" type="text" icon={<Check size={12} />} onClick={() => approve(t.id)}>批准</Button>}</div>
                    </div>))}</div></div>

            <Modal open={!!blocked} title={<span className="flex items-center gap-2 text-red-500"><ShieldAlert size={16} />高严重度连续性问题阻止批准</span>} onCancel={() => setBlocked(null)} okText="仍然批准（记录原因）" okButtonProps={{ danger: true, disabled: reason.trim().length < 3 }} onOk={() => approve(blocked!.takeId, reason)}>
                <ul className="list-disc pl-5 text-sm">{blocked?.issues.map((i) => <li key={i.id}><b>{i.category}</b>：{i.message}</li>)}</ul>
                <Input.TextArea className="mt-3" rows={2} placeholder="Override 原因（必填，会写入审计）" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Modal>
            {void modal}
        </div>
    );
}

function Qc({ shot, d, refresh, watch }: { shot: any; d: any; refresh: () => void; watch: () => void }) {
    const wb = useWorkbench();
    const ask = useAsk();
    const { message } = App.useApp();
    const [kinds, setKinds] = useState<string[]>([]);
    const [all, setAll] = useState<string[]>([]);
    const [target, setTarget] = useState<string>();
    const [last, setLast] = useState<any>(null);
    const [auto, setAuto] = useState(false);
    useEffect(() => void api.get("/qc/observation-kinds").then(setAll), []);
    const targets = [...d.takes.map((t: any) => ({ v: `take:${t.id}`, l: `Take ${t.status} ${t.id.slice(-4)}` })), ...d.keyframes.map((k: any) => ({ v: `keyframe:${k.id}`, l: `Keyframe ${k.status} ${k.id.slice(-4)}` }))];
    const runQc = async () => {
        if (!target) return message.info("选一个 Keyframe / Take");
        const [targetType, targetId] = target.split(":");
        try { setLast(await api.post(`/shots/${shot.id}/qc`, { targetType, targetId, auto, observations: kinds.map((kind) => ({ kind })) })); await refresh(); await wb.reload(); } catch (e: any) { message.error(e.message); }
    };
    const apply = async (id: string) => { try { const r = await api.post(`/repair-actions/${id}/apply`); r.applied ? (watch(), message.success("已创建修复任务（新变体，旧版保留）")) : message.info(r.message); await refresh(); } catch (e: any) { message.error(e.message); } };
    return (
        <div className="space-y-3 p-3 text-sm">
            <div><b>连续性</b> <Button size="small" onClick={async () => { await api.post(`/sequences/${shot.sequenceId}/continuity`); await refresh(); await wb.reload(); }}>重新检查整个序列</Button></div>
            {d.issues.filter((i: any) => i.status !== "resolved").map((i: any) => (
                <div key={i.id} className="rounded border border-black/10 p-2 text-xs dark:border-white/10">
                    <div className="flex items-center gap-2"><Tag color={sev(i.severity)} className="!m-0">{i.severity}</Tag><b>{i.category}</b>{i.status === "overridden" && <Tag className="!m-0">overridden: {i.overrideReason}</Tag>}</div>
                    <div className="mt-1">{i.message}</div><div className="mt-1 opacity-70">修复：{i.repair?.detail}</div>
                    {i.status === "open" && <Button size="small" type="link" onClick={async () => { const reason = await ask("Override 原因（写入审计）"); if (reason && reason.length > 2) { await api.post(`/continuity-issues/${i.id}/override`, { reason }); await refresh(); await wb.reload(); } }}>Override</Button>}
                </div>))}
            {!d.issues.length && <div className="text-xs opacity-50">无连续性问题。</div>}
            <div className="border-t border-black/10 pt-2 dark:border-white/10"><b>QC / Failure Diagnosis</b>
                <div className="mt-1 flex gap-1"><Select size="small" placeholder="目标" value={target} onChange={setTarget} options={targets.map((t) => ({ value: t.v, label: t.l }))} className="!w-40" /><Select size="small" mode="multiple" placeholder="观察到的问题" value={kinds} onChange={setKinds} options={all.map((k) => ({ value: k }))} className="flex-1" /><Button size="small" type="primary" onClick={runQc}>诊断</Button></div><Checkbox className="!mt-1 !text-xs" checked={auto} onChange={(e) => setAuto(e.target.checked)}>视觉自动诊断（视觉模型看画面）</Checkbox></div>
            {last && <div className="space-y-1.5"><div>得分 <b>{last.report.score}</b></div>{last.vision && <div className="text-xs opacity-70">视觉诊断：{last.vision.used ? `已使用 ${last.vision.model}` : `未使用（${last.vision.reason}）`}</div>}{last.report.findings.map((f: any, i: number) => { const ra = last.repairActions[i]; return <div key={i} className="rounded bg-black/5 p-2 text-xs dark:bg-white/10"><div><Tag color={sev(f.severity)} className="!m-0">{f.severity}</Tag> <b>{f.cause}</b></div><div className="opacity-70">→ {f.action}：{f.detail}</div>{ra && <Button size="small" type="link" onClick={() => apply(ra.id)}>应用修复</Button>}</div>; })}</div>}
        </div>
    );
}

function State({ shot }: { shot: any }) {
    const row = (title: string, st: any) => <div><div className="mb-1 text-xs font-medium opacity-60">{title}</div><div className="space-y-0.5 text-xs">
        {Object.entries<any>(st.characters ?? {}).map(([id, c]) => <div key={id}>👤 {c.name ?? id.slice(-4)} {c.wardrobeId && st.wardrobe?.[c.wardrobeId] ? `· 穿 ${st.wardrobe[c.wardrobeId].name}` : ""}</div>)}
        {Object.entries<any>(st.props ?? {}).map(([id, p]) => <div key={id}>📦 {p.name ?? id.slice(-4)} {p.heldBy ? `· 在 ${st.characters?.[p.heldBy]?.name ?? "?"} 手中` : ""}{p.present === false ? " · 已移出" : ""}</div>)}
        {Object.entries<any>(st.environment ?? {}).map(([id, e]) => <div key={id}>🏠 {e.name ?? id.slice(-4)}</div>)}
        {st.lighting && Object.keys(st.lighting).length > 0 && <div>💡 {st.lighting.timeOfDay} · 主光 {st.lighting.keyDirection} · {st.lighting.colorTemp}</div>}
        {Object.entries<any>(st.emotional ?? {}).map(([id, e]) => <div key={id}>🎭 {st.characters?.[id]?.name ?? id.slice(-4)}：{e.emotion}</div>)}</div></div>;
    return <div className="grid gap-4 p-3">{row("Start State（继承自上一镜 Result）", shot.state.start)}{row("Result State（= Start + Intended Delta）", shot.state.result)}</div>;
}

function History({ shotId }: { shotId: string }) {
    const [h, setH] = useState<any[]>([]);
    useEffect(() => void api.get(`/shots/${shotId}/history`).then(setH), [shotId]);
    return <div className="space-y-1 p-3 text-xs">{h.map((e) => <div key={e.id}><span className="opacity-50">{new Date(e.created_at).toLocaleTimeString()}</span> {e.entity_type} <b>{e.action}</b> {e.reason && `· ${e.reason}`}</div>)}{!h.length && <div className="opacity-50">还没有审批记录</div>}</div>;
}

export function ShotInspector({ id }: { id: string }) {
    const { message, modal } = App.useApp();
    const wb = useWorkbench();
    const { d, refresh, watch } = useShot(id);
    const shot = wb.shots.find((s) => s.id === id);
    const mounted = useRef(true);
    useEffect(() => () => void (mounted.current = false), []);
    if (!d || !shot) return <div className="p-4 text-xs opacity-50">加载中…</div>;
    const merged = { ...shot, ...d };
    const del = () => {
        const go = async (confirm: boolean) => { try { await api.del(`/shots/${id}${confirm ? "?confirm=1" : ""}`); wb.select(null); await wb.reload(); } catch (e: any) { message.error(e.message); } };
        modal.confirm({ title: "删除镜头？", content: shot.heroKeyframeId || shot.approvedTakeId ? "该镜头已有 Hero Frame / Approved Take，确认后才会删除。" : undefined, okType: "danger", onOk: () => go(!!(shot.heroKeyframeId || shot.approvedTakeId)) });
    };
    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-black/10 px-3 py-2 text-sm dark:border-white/10"><b>镜头 #{shot.ord + 1}</b><Tag className="!m-0">{shot.status}</Tag><div className="flex-1" /><Button size="small" type="text" danger icon={<Trash2 size={13} />} onClick={del} /></div>
            <Tabs size="small" className="min-h-0 flex-1 overflow-auto [&_.ant-tabs-nav]:!mb-0 [&_.ant-tabs-nav]:!px-3" items={[
                { key: "spec", label: "规格", children: <Spec shot={merged} onSaved={refresh} /> },
                { key: "ref", label: `参考 ${shot.bindings?.length ?? 0}`, children: <Refs shot={merged} onSaved={refresh} /> },
                { key: "gen", label: "生成", children: <Gen shot={merged} d={d} refresh={refresh} watch={watch} /> },
                { key: "qc", label: `QC ${d.issues.filter((i: any) => i.status === "open").length || ""}`, children: <Qc shot={merged} d={d} refresh={refresh} watch={watch} /> },
                { key: "state", label: "状态", children: <State shot={merged} /> },
                { key: "hist", label: "历史", children: <History shotId={id} /> },
            ]} />
        </div>
    );
}
