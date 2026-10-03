import { useState } from "@infinite-canvas/plugin-sdk";
import * as api from "./api";
import { btn, input, meta, panelBox, stop, useLive, type Ctx } from "./shared";

const ROLES = ["IDENTITY", "GEOMETRY", "WARDROBE", "ENVIRONMENT", "COMPOSITION", "LIGHTING", "LOOK", "PERFORMANCE", "CAMERA_MOTION", "START_FRAME", "END_FRAME", "AUDIO", "DEPTH", "PANORAMA"];
const TABS: [string, string][] = [["spec", "规格"], ["ref", "参考"], ["gen", "生成"], ["qc", "QC"], ["state", "状态"], ["hist", "历史"]];
const SEV: Record<string, string> = { high: "#ef4444", medium: "#f59e0b", low: "#94a3b8" };
const openStudio = (pid?: string) => window.open(`/studio${pid ? `/p/${pid}` : ""}`, "_blank");

export const hasPending = (d: any) => d?.__pending;
export async function loadShot(id: string) {
    const [d, jobs] = await Promise.all([api.get(`/shots/${id}`), api.get(`/generations?targetId=${id}`)]);
    return { ...d, __pending: jobs.some((j: any) => j.status === "QUEUED" || j.status === "RUNNING") };
}

type PanelProps = { ctx: Ctx; s: any; changed: () => void; say: (m: string) => void; act: (fn: () => Promise<any>, ok?: string) => () => Promise<any> };
const sep = (ctx: Ctx) => ({ borderTop: `1px solid ${ctx.theme.node.stroke}`, paddingTop: 6 });
const link = (color = "#6366f1") => ({ cursor: "pointer", color }) as const;

// ------------------------------------------------------------------ 规格
function Spec({ ctx, s, changed, say }: PanelProps) {
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [confirm, setConfirm] = useState<{ fields: string[]; patch: any } | null>(null);
    const dirty = Object.keys(draft).length > 0;
    const send = async (patch: any, confirmed = false) => {
        try { await api.patch(`/shots/${s.id}`, { ...patch, ...(confirmed ? { confirm: true } : {}) }); setDraft({}); setConfirm(null); say("已保存，状态链已重算"); changed(); }
        catch (e: any) { e.code === "needs_confirmation" ? setConfirm({ fields: e.details?.fields ?? [], patch }) : say(e.message); }
    };
    const save = () => send({
        ...(draft.action !== undefined ? { action: draft.action } : {}),
        ...(draft.subtitle !== undefined ? { subtitle: draft.subtitle } : {}),
        ...(draft.shotSize || draft.lensMm ? { camera: { ...s.camera, ...(draft.shotSize ? { shotSize: draft.shotSize } : {}), ...(draft.lensMm ? { lensMm: Number(draft.lensMm) } : {}) } } : {}),
    });
    return (
        <>
            <label>动作</label>
            <textarea rows={2} style={input(ctx)} value={draft.action ?? s.action ?? ""} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
            <label>字幕 / 台词</label>
            <input style={input(ctx)} value={draft.subtitle ?? s.subtitle ?? ""} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
            <div style={{ display: "flex", gap: 6 }}>
                <select style={input(ctx)} value={draft.shotSize ?? s.camera?.shotSize} onChange={(e) => setDraft({ ...draft, shotSize: e.target.value })}>{["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS"].map((v) => <option key={v}>{v}</option>)}</select>
                <input style={input(ctx)} type="number" value={draft.lensMm ?? s.camera?.lensMm} onChange={(e) => setDraft({ ...draft, lensMm: e.target.value })} />
                <button style={btn(ctx)} disabled={!dirty} onClick={save}>保存</button>
            </div>
            {confirm && (
                <div style={{ border: "1px solid #f59e0b", borderRadius: 8, padding: 8 }}>
                    <b style={{ color: "#f59e0b" }}>改变核心意图会影响已有的 Hero Frame / Approved Take</b>
                    <div style={{ opacity: 0.8 }}>涉及：{confirm.fields.join("、")}（旧版本会保留，不会被静默覆盖）</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}><button style={btn(ctx, true)} onClick={() => send(confirm.patch, true)}>确认修改</button><button style={btn(ctx)} onClick={() => setConfirm(null)}>取消</button></div>
                </div>
            )}
        </>
    );
}

// ------------------------------------------------------------------ 参考
function Refs({ ctx, s, changed, say }: PanelProps) {
    const { oviaProjectId: pid } = meta(ctx);
    const [role, setRole] = useState<Record<string, string>>({});
    const upstreamImages = ctx.getUpstream().filter((n) => n.type === "image");
    const bindImage = async (n: any) => {
        try {
            const src = n.metadata?.images?.find((i: any) => i.id === n.metadata?.primaryImageId)?.content ?? n.metadata?.images?.[0]?.content ?? n.metadata?.content;
            if (!src) throw new Error("该图片节点还没有图片");
            const m = await api.uploadBlob(await (await fetch(src)).blob(), pid!);
            const r = await api.post(`/projects/${pid}/references`, { kind: "image", name: n.title || "canvas image", mediaId: m.id, source: "canvas-node", sourceRef: n.id });
            const rl = role[n.id] ?? "IDENTITY";
            await api.post(`/shots/${s.id}/bindings`, { referenceId: r.id, role: rl, lockLevel: rl === "IDENTITY" ? "LOCK" : "CONTROL" });
            say(`已登记为参考并绑定为 ${rl}`); changed();
        } catch (e: any) { say(e.message); }
    };
    return (
        <>
            <div style={{ opacity: 0.8 }}>绑定的参考：{s.bindings.map((b: any) => `${b.role}(${b.lockLevel})`).join("、") || "无"}</div>
            {!upstreamImages.length && <div style={{ opacity: 0.6 }}>把上游图片节点连到本镜头，即可登记为参考并绑定角色。</div>}
            {upstreamImages.map((n) => (
                <div key={n.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>上游图片：{n.title}</span>
                    <select style={{ ...input(ctx), width: 120 }} value={role[n.id] ?? "IDENTITY"} onChange={(e) => setRole({ ...role, [n.id]: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
                    <button style={btn(ctx)} onClick={() => bindImage(n)}>登记为参考</button>
                </div>
            ))}
        </>
    );
}

// ------------------------------------------------------------------ 生成
function Gen({ ctx, s, changed, say, act }: PanelProps) {
    const est = useLive(ctx, () => api.post(`/shots/${s.id}/estimate`, { kind: "image", count: 3 }), [s.id, s.bindings?.length]);
    const [override, setOverride] = useState<{ takeId: string; issues: any[]; reason: string } | null>(null);
    const approve = async (takeId: string, reason?: string) => {
        try { await api.post(`/takes/${takeId}/approve`, reason ? { overrideReason: reason } : {}); setOverride(null); say("已批准 Take"); changed(); }
        catch (e: any) { e.code === "continuity_blocked" ? setOverride({ takeId, issues: e.details, reason: "" }) : say(e.message); }
    };
    return (
        <>
            <div>
                <button style={btn(ctx, true)} onClick={act(async () => { const r = await api.post(`/shots/${s.id}/keyframes`, { count: 3 }); if (r.degradations?.length) say(`模型降级：${r.degradations.map((d: any) => d.role).join(", ")}`); }, "关键帧任务已入队（刷新页面不会丢）")}>生成 3 张关键帧</button>
                {est.data && <span style={{ marginLeft: 8, opacity: 0.7 }}>{est.data.modelId} · 预计 {est.data.total.credits} 积分</span>}
                {s.__pending && <span style={{ marginLeft: 8, color: "#6366f1" }}>生成中…</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
                {s.keyframes.map((k: any) => (
                    <div key={k.id} style={{ border: `2px solid ${k.status === "hero" ? "#6366f1" : "transparent"}`, borderRadius: 6, overflow: "hidden" }}>
                        <img src={api.mediaUrl(k.media?.url)} draggable={false} style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", display: "block" }} />
                        <div style={{ display: "flex", justifyContent: "space-between", padding: 2 }}><span>{k.status === "hero" ? "HERO·LOCK" : k.status}</span>{k.status !== "hero" && <a style={link()} onClick={act(() => (k.status === "superseded" ? api.post(`/shots/${s.id}/hero/rollback`, { keyframeId: k.id }) : api.post(`/keyframes/${k.id}/promote`)))}>{k.status === "superseded" ? "回滚" : "设为Hero"}</a>}</div>
                    </div>
                ))}
            </div>
            <div><button style={btn(ctx, true)} disabled={!s.heroKeyframeId} onClick={act(() => api.post(`/shots/${s.id}/takes`, { count: 2 }), "Take 任务已入队")}>基于 Hero 生成 2 个 Take</button>{!s.heroKeyframeId && <span style={{ marginLeft: 8, opacity: 0.6 }}>先设一张 Hero Frame</span>}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 6 }}>
                {s.takes.map((t: any) => (
                    <div key={t.id} style={{ border: `2px solid ${t.status === "approved" ? "#22c55e" : "transparent"}`, borderRadius: 6, overflow: "hidden" }}>
                        <img src={api.mediaUrl(t.media?.url)} draggable={false} style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", display: "block" }} />
                        <div style={{ display: "flex", justifyContent: "space-between", padding: 2 }}><span>{t.status}</span>{t.status === "candidate" && <a style={link("#22c55e")} onClick={() => approve(t.id)}>批准</a>}{t.status === "superseded" && <a style={link()} onClick={act(() => api.post(`/shots/${s.id}/take/rollback`, { takeId: t.id }))}>回滚</a>}</div>
                    </div>
                ))}
            </div>
            {override && (
                <div style={{ border: "1px solid #ef4444", borderRadius: 8, padding: 8 }}>
                    <b style={{ color: "#ef4444" }}>高严重度连续性问题阻止批准</b>
                    <ul style={{ margin: "4px 0 4px 16px", padding: 0 }}>{override.issues.map((i) => <li key={i.id}><b>{i.category}</b>：{i.message}</li>)}</ul>
                    <input style={input(ctx)} placeholder="Override 原因（必填，写入审计）" value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}><button style={btn(ctx)} disabled={override.reason.trim().length < 3} onClick={() => approve(override.takeId, override.reason)}>仍然批准</button><button style={btn(ctx)} onClick={() => setOverride(null)}>取消</button></div>
                </div>
            )}
        </>
    );
}

// ------------------------------------------------------------------ QC
function Qc({ ctx, s, changed, say, act }: PanelProps) {
    const kinds = useLive<string[]>(ctx, () => api.get("/qc/observation-kinds"), []);
    const [target, setTarget] = useState("");
    const [picked, setPicked] = useState<string[]>([]);
    const [auto, setAuto] = useState(false);
    const [last, setLast] = useState<any>(null);
    const [ov, setOv] = useState<{ id: string; reason: string } | null>(null);
    const targets = [...s.takes.map((t: any) => ({ v: `take:${t.id}`, l: `Take ${t.status} ${t.id.slice(-4)}` })), ...s.keyframes.map((k: any) => ({ v: `keyframe:${k.id}`, l: `Keyframe ${k.status} ${k.id.slice(-4)}` }))];
    const open = s.issues.filter((i: any) => i.status !== "resolved");
    const run = async () => {
        if (!target) return say("选一个 Keyframe / Take");
        const [targetType, targetId] = target.split(":");
        try { setLast(await api.post(`/shots/${s.id}/qc`, { targetType, targetId, auto, observations: picked.map((kind) => ({ kind })) })); changed(); } catch (e: any) { say(e.message); }
    };
    const apply = async (id: string) => { try { const r = await api.post(`/repair-actions/${id}/apply`); say(r.applied ? "已创建修复任务（新变体，旧版保留）" : r.message ?? "需要手动处理"); changed(); } catch (e: any) { say(e.message); } };
    const finding = (f: any, ra: any) => (
        <div key={ra?.id ?? f.cause} style={{ background: "rgba(128,128,128,.12)", borderRadius: 6, padding: 6 }}>
            <span style={{ color: SEV[f.severity] }}>[{f.severity}]</span> <b>{f.cause}</b>
            <div style={{ opacity: 0.75 }}>→ {f.action}：{f.detail}{f.note ? `（${f.note}）` : ""}</div>
            {ra && ra.status !== "applied" && <a style={link()} onClick={() => apply(ra.id)}>应用修复</a>}{ra?.status === "applied" && <span style={{ opacity: 0.6 }}>已应用</span>}
        </div>
    );
    return (
        <>
            <div><b>连续性</b> <button style={btn(ctx)} onClick={act(() => api.post(`/sequences/${s.sequenceId}/continuity`), "已重新检查整个序列")}>重新检查序列</button></div>
            {!open.length && <div style={{ opacity: 0.6 }}>无连续性问题。</div>}
            {open.map((i: any) => (
                <div key={i.id} style={{ border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 6, padding: 6 }}>
                    <span style={{ color: SEV[i.severity] }}>[{i.severity}]</span> <b>{i.category}</b> {i.status === "overridden" && <span style={{ opacity: 0.7 }}>overridden：{i.overrideReason}</span>}
                    <div>{i.message}</div><div style={{ opacity: 0.7 }}>修复：{i.repair?.detail}</div>
                    {i.status === "open" && (ov?.id === i.id
                        ? <div style={{ display: "flex", gap: 4, marginTop: 4 }}><input style={input(ctx)} placeholder="Override 原因（写入审计）" value={ov!.reason} onChange={(e) => setOv({ id: i.id, reason: e.target.value })} /><button style={btn(ctx)} disabled={ov!.reason.trim().length < 3} onClick={act(async () => { await api.post(`/continuity-issues/${i.id}/override`, { reason: ov!.reason }); setOv(null); }, "已 Override")}>确定</button></div>
                        : <a style={link()} onClick={() => setOv({ id: i.id, reason: "" })}>Override</a>)}
                </div>
            ))}
            <div style={sep(ctx)}><b>QC / Failure Diagnosis</b></div>
            <select style={input(ctx)} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">目标：选择 Keyframe / Take</option>{targets.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(kinds.data ?? []).map((k) => <label key={k} style={{ border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 10, padding: "1px 7px", cursor: "pointer", background: picked.includes(k) ? "#6366f1" : "transparent", color: picked.includes(k) ? "#fff" : undefined }}><input type="checkbox" style={{ display: "none" }} checked={picked.includes(k)} onChange={() => setPicked(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k])} />{k}</label>)}
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />视觉自动诊断（需要视觉模型）</label>
            <button style={btn(ctx, true)} onClick={run}>诊断</button>
            {last && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div>得分 <b>{last.report.score}</b>{last.vision && <span style={{ marginLeft: 8, opacity: 0.7 }}>视觉：{last.vision.used ? `已使用 ${last.vision.model}` : `未使用（${last.vision.reason}）`}</span>}</div>
                    {last.report.findings.map((f: any, i: number) => finding(f, last.repairActions[i]))}
                </div>
            )}
            {s.qc.length > 0 && (
                <div style={sep(ctx)}>
                    <b>历史 QC 报告</b>
                    {[...s.qc].reverse().slice(0, 5).map((r: any) => (
                        <div key={r.id} style={{ marginTop: 4 }}>
                            <div style={{ opacity: 0.7 }}>{new Date(r.createdAt).toLocaleString()} · {r.targetType} {String(r.targetId).slice(-4)} · 得分 {r.score}</div>
                            {r.findings.map((f: any, i: number) => finding(f, s.repairs.filter((x: any) => x.qcReportId === r.id)[i]))}
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

// ------------------------------------------------------------------ 状态
function StateView({ title, st }: { title: string; st: any }) {
    const rows: string[] = [
        ...Object.entries<any>(st.characters ?? {}).map(([id, c]) => `👤 ${c.name ?? id.slice(-4)}${c.wardrobeId && st.wardrobe?.[c.wardrobeId] ? ` · 穿 ${st.wardrobe[c.wardrobeId].name}` : ""}`),
        ...Object.entries<any>(st.props ?? {}).map(([id, p]) => `📦 ${p.name ?? id.slice(-4)}${p.heldBy ? ` · 在 ${st.characters?.[p.heldBy]?.name ?? "?"} 手中` : ""}${p.present === false ? " · 已移出" : ""}`),
        ...Object.entries<any>(st.environment ?? {}).map(([id, e]) => `🏠 ${e.name ?? id.slice(-4)}`),
        ...(st.lighting && Object.keys(st.lighting).length ? [`💡 ${st.lighting.timeOfDay ?? ""} · 主光 ${st.lighting.keyDirection ?? ""} · ${st.lighting.colorTemp ?? ""}`] : []),
        ...Object.entries<any>(st.emotional ?? {}).map(([id, e]) => `🎭 ${st.characters?.[id]?.name ?? id.slice(-4)}：${e.emotion}`),
    ];
    return <div><b style={{ opacity: 0.7 }}>{title}</b>{rows.map((r, i) => <div key={i}>{r}</div>)}{!rows.length && <div style={{ opacity: 0.5 }}>（空）</div>}</div>;
}

function State({ ctx, s, changed, say }: PanelProps) {
    const [text, setText] = useState<string | null>(null);
    const cur = text ?? JSON.stringify(s.intendedStateDelta ?? {}, null, 1);
    let valid = true;
    try { JSON.parse(cur || "{}"); } catch { valid = false; }
    const save = async () => { try { await api.patch(`/shots/${s.id}`, { intendedStateDelta: JSON.parse(cur || "{}") }); setText(null); say("Delta 已保存，状态链已重算"); changed(); } catch (e: any) { say(e.message); } };
    return (
        <>
            <StateView title="Start State（继承自上一镜 Result）" st={s.state.start} />
            <StateView title="Result State（= Start + Intended Delta）" st={s.state.result} />
            <div style={sep(ctx)}><b>Intended State Delta (JSON)</b></div>
            <textarea rows={5} style={{ ...input(ctx), fontFamily: "monospace", resize: "vertical", borderColor: valid ? ctx.theme.node.stroke : "#ef4444" }} value={cur} onChange={(e) => setText(e.target.value)} />
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}><button style={btn(ctx)} disabled={text === null || !valid} onClick={save}>保存 Delta</button>{!valid && <span style={{ color: "#ef4444" }}>不是合法 JSON</span>}</div>
        </>
    );
}

// ------------------------------------------------------------------ 历史
function History({ ctx, s }: PanelProps) {
    const h = useLive<any[]>(ctx, () => api.get(`/shots/${s.id}/history`), [s.id, s.status, s.keyframes.length, s.takes.length]);
    const list = [...(h.data ?? [])].reverse();
    return (
        <>
            {list.map((e) => <div key={e.id}><span style={{ opacity: 0.5 }}>{new Date(e.created_at).toLocaleString()}</span> {e.entity_type} <b>{e.action}</b>{e.reason ? ` · ${e.reason}` : ""}</div>)}
            {!list.length && <div style={{ opacity: 0.6 }}>还没有审批记录</div>}
        </>
    );
}

// ------------------------------------------------------------------ panel
export function ShotPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
    const { oviaId, oviaProjectId: pid } = meta(ctx);
    const { data: s, changed } = useLive(ctx, () => loadShot(oviaId!), [oviaId], hasPending);
    const [tab, setTab] = useState("spec");
    const [msg, setMsg] = useState("");
    if (!s) return null;
    const act = (fn: () => Promise<any>, ok?: string) => async () => { try { const r = await fn(); if (ok) setMsg(ok); changed(); return r; } catch (e: any) { setMsg(e.message); } };
    const props: PanelProps = { ctx, s, changed, say: setMsg, act };
    const open = s.issues?.filter((i: any) => i.status === "open").length ?? 0;
    const Body = { spec: Spec, ref: Refs, gen: Gen, qc: Qc, state: State, hist: History }[tab] ?? Spec;
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>镜头 #{s.ord + 1} · {s.narrativeFunction} · {s.status}</b>
            <div style={{ display: "flex", gap: 4 }}>
                {TABS.map(([k, l]) => <button key={k} style={{ ...btn(ctx, tab === k), flex: 1, padding: "3px 4px" }} onClick={() => setTab(k)}>{l}{k === "qc" && open > 0 ? ` ${open}` : ""}</button>)}
            </div>
            <Body {...props} />
            {msg && <div style={{ color: "#6366f1" }}>{msg}</div>}
            <div style={{ display: "flex", gap: 6 }}><button style={btn(ctx)} onClick={() => openStudio(pid)}>在工作台打开</button><button style={btn(ctx)} onClick={onClose}>关闭</button></div>
        </div>
    );
}
