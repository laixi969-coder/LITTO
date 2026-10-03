import { useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeDefinition } from "@infinite-canvas/plugin-sdk";
import * as api from "./api";
import { Card, KIND_COLOR, Problem, btn, input, meta, panelBox, stop, useLive, type Ctx } from "./shared";

const SIZE = { world: { width: 230, height: 84 }, look: { width: 230, height: 84 }, asset: { width: 230, height: 84 }, shot: { width: 260, height: 108 }, project: { width: 260, height: 120 } };
const SHOT_ROLES = ["IDENTITY", "GEOMETRY", "WARDROBE", "ENVIRONMENT", "COMPOSITION", "LIGHTING", "LOOK", "PERFORMANCE", "CAMERA_MOTION", "START_FRAME", "END_FRAME", "AUDIO"];
const studioUrl = (pid?: string) => `/studio${pid ? `/p/${pid}` : ""}`;
const open = (pid?: string) => window.open(studioUrl(pid), "_blank");

// ---------------------------------------------------------------- hub
export async function syncToCanvas(ctx: Ctx, pid: string) {
    const [world, looks, assets, shots, seqs] = await Promise.all([api.get(`/projects/${pid}/world`), api.get(`/projects/${pid}/looks`), api.get(`/projects/${pid}/assets`), api.get(`/projects/${pid}/shots`), api.get(`/projects/${pid}/sequences`)]);
    const have = new Set(ctx.getNodes().filter((n) => (n.metadata as any)?.ffId).map((n) => n.id));
    const { x, y } = ctx.node.position;
    const ops: any[] = [];
    const add = (kind: string, ffId: string, nodeType: string, title: string, nx: number, ny: number, size: { width: number; height: number }) => {
        const id = `ff-${kind}-${ffId}`;
        if (!have.has(id)) ops.push({ type: "add_node", id, nodeType, title, x: nx, y: ny, ...size, metadata: { ffProjectId: pid, ffKind: kind, ffId } });
        return id;
    };
    const w = add("world", world.id, "filmflow:world", "World", x + 320, y, SIZE.world);
    const lk = looks.find((l: any) => l.scope === "project");
    if (lk) add("look", lk.id, "filmflow:look", "Look", x + 320, y + 110, SIZE.look);
    assets.forEach((a: any, i: number) => add(`asset`, a.id, "filmflow:asset", a.name, x + 320, y + 240 + i * 110, SIZE.asset));
    const order = new Map<string, number>(seqs.map((s: any, i: number) => [s.id, i]));
    let rowBase = 0;
    for (const s of seqs) {
        const list = shots.filter((sh: any) => sh.sequenceId === s.id).sort((a: any, b: any) => a.ord - b.ord);
        let prev: string | null = null;
        list.forEach((sh: any, i: number) => {
            const id = add("shot", sh.id, "filmflow:shot", `#${sh.ord + 1} ${sh.title || sh.narrativeFunction}`, x + 660 + (i % 5) * 290, y + rowBase + Math.floor(i / 5) * 190, SIZE.shot);
            for (const aid of sh.assetIds ?? []) ops.push({ type: "connect_nodes", fromNodeId: `ff-asset-${aid}`, toNodeId: id });
            if (prev) ops.push({ type: "connect_nodes", fromNodeId: prev, toNodeId: id }); // state flows shot → shot
            prev = id;
        });
        rowBase += Math.ceil(Math.max(list.length, 1) / 5) * 190 + 120;
    }
    void order;
    ops.push({ type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: w });
    // node ops must land before connections referencing them
    ctx.applyOps(ops.filter((o) => o.type === "add_node"));
    setTimeout(() => ctx.applyOps(ops.filter((o) => o.type === "connect_nodes")), 50);
    return { added: ops.filter((o) => o.type === "add_node").length };
}

function HubContent({ ctx }: { ctx: Ctx }) {
    const pid = meta(ctx).ffProjectId;
    const { data, err } = useLive(ctx, async () => (pid ? { p: await api.get(`/projects/${pid}`), shots: await api.get(`/projects/${pid}/shots`), assets: await api.get(`/projects/${pid}/assets`) } : null), [pid]);
    if (err) return <Problem ctx={ctx} err={err} />;
    return <Card ctx={ctx} color="#111827" title={data?.p?.name ?? "FilmFlow 项目"} sub={pid ? `${data?.assets.length ?? "…"} 资产 · ${data?.shots.length ?? "…"} 镜头 — 打开面板同步领域节点` : "选中后在面板里选择项目"} />;
}

function HubPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
    const pid = meta(ctx).ffProjectId;
    const list = useLive(ctx, () => api.get("/projects"), []);
    const [script, setScript] = useState("");
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);
    const run = (fn: () => Promise<string>) => async () => { setBusy(true); try { setMsg(await fn()); ctx.emit("filmflow:changed"); } catch (e) { setMsg((e as Error).message); } setBusy(false); };
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>FilmFlow 项目枢纽</b>
            <select style={input(ctx)} value={pid ?? ""} onChange={(e) => { const p = list.data?.find((x: any) => x.id === e.target.value); ctx.updateMetadata({ ffProjectId: e.target.value, ffKind: "project", ffId: e.target.value } as any); if (p) ctx.updateNode({ title: p.name }); }}>
                <option value="">选择项目…</option>
                {list.data?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {list.err && <Problem ctx={ctx} err={list.err} />}
            {pid && <>
                <div style={{ display: "flex", gap: 6 }}>
                    <button style={btn(ctx, true)} disabled={busy} onClick={run(async () => `已同步，新增 ${(await syncToCanvas(ctx, pid)).added} 个领域节点`)}>同步领域节点到画布</button>
                    <button style={btn(ctx)} onClick={() => open(pid)}>在工作台打开</button>
                </div>
                <div style={{ opacity: 0.7 }}>导演指令：粘贴剧本 → 按叙事功能拆镜 → 自动同步到画布</div>
                <textarea rows={6} style={{ ...input(ctx), resize: "vertical" }} value={script} onChange={(e) => setScript(e.target.value)} placeholder={"INT. APARTMENT - NIGHT\nMara notices the Letter…"} />
                <button style={btn(ctx)} disabled={busy || !script.trim()} onClick={run(async () => { const r = await api.post(`/projects/${pid}/director/run`, { script, minShots: 8 }); await syncToCanvas(ctx, pid); return `已生成 ${r.shotIds.length} 个镜头并同步到画布`; })}>运行导演并同步</button>
            </>}
            {msg && <div style={{ color: "#6366f1" }}>{msg}</div>}
            <button style={btn(ctx)} onClick={onClose}>关闭</button>
        </div>
    );
}

// ---------------------------------------------------------------- world / look
function WorldLookContent({ ctx, kind }: { ctx: Ctx; kind: "world" | "look" }) {
    const { ffProjectId: pid } = meta(ctx);
    const { data, err } = useLive(ctx, async () => (kind === "world" ? api.get(`/projects/${pid}/world`) : (await api.get(`/projects/${pid}/looks`)).find((l: any) => l.scope === "project")), [pid]);
    if (err) return <Problem ctx={ctx} err={err} />;
    const sub = kind === "world" ? [data?.era, data?.locationLogic, data?.architecture, data?.weather].filter(Boolean).join(" · ") : [(data?.palette ?? []).join("/"), data?.contrast, data?.grain].filter(Boolean).join(" · ");
    return <Card ctx={ctx} color={KIND_COLOR[kind]} title={kind === "world" ? "World" : "Look"} sub={sub || "点击展开面板进行定义"} />;
}

const WORLD_FIELDS: [string, string][] = [["era", "年代"], ["locationLogic", "地点逻辑"], ["architecture", "建筑"], ["culture", "文化"], ["weather", "天气"], ["time", "时间"], ["material", "材质"], ["physics", "物理"], ["realism", "真实性"]];
const LOOK_FIELDS: [string, string][] = [["contrast", "对比度"], ["saturation", "饱和度"], ["skinTone", "肤色"], ["blackLevel", "黑位"], ["highlightRolloff", "高光滚降"], ["shadowBehavior", "暗部"], ["grain", "颗粒"], ["halation", "光晕"], ["bloom", "bloom"], ["lensCharacter", "镜头性格"], ["texture", "质感"], ["sharpnessPhilosophy", "锐度哲学"]];

function WorldLookPanel({ ctx, kind, onClose }: { ctx: Ctx; kind: "world" | "look"; onClose: () => void }) {
    const { ffProjectId: pid } = meta(ctx);
    const { data, changed } = useLive(ctx, async () => (kind === "world" ? api.get(`/projects/${pid}/world`) : (await api.get(`/projects/${pid}/looks`)).find((l: any) => l.scope === "project")), [pid]);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const fields = kind === "world" ? WORLD_FIELDS : LOOK_FIELDS;
    const save = async () => { await (kind === "world" ? api.put(`/projects/${pid}/world`, draft) : api.put(`/projects/${pid}/looks/project`, draft)); setDraft({}); changed(); };
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>{kind === "world" ? "World：整部影片共享的物理与文化设定" : "Look：项目级影调"}</b>
            {fields.map(([k, label]) => <label key={k} style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 6, alignItems: "center" }}>{label}<input style={input(ctx)} value={draft[k] ?? data?.[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>)}
            <div style={{ display: "flex", gap: 6 }}><button style={btn(ctx, true)} disabled={!Object.keys(draft).length} onClick={save}>保存</button><button style={btn(ctx)} onClick={onClose}>关闭</button></div>
        </div>
    );
}

// ---------------------------------------------------------------- asset
function AssetContent({ ctx }: { ctx: Ctx }) {
    const { ffId } = meta(ctx);
    const { data: a, err } = useLive(ctx, () => api.get(`/assets/${ffId}`), [ffId]);
    if (err) return <Problem ctx={ctx} err={err} />;
    if (!a) return null;
    const locked = a.approvalStatus === "approved";
    return <Card ctx={ctx} color={KIND_COLOR[a.type] ?? "#64748b"} title={a.name} badge={<span title={locked ? "Approved · LOCK" : "draft"}>{locked ? "🔒" : "✎"}</span>} sub={`${a.type} · v${a.version} · ${a.invariants?.length ?? 0} 条不变量 · ${a.references?.length ?? 0} 参考`} />;
}

function AssetPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
    const { ffId } = meta(ctx);
    const { data: a, changed } = useLive(ctx, () => api.get(`/assets/${ffId}`), [ffId]);
    const [msg, setMsg] = useState("");
    const [desc, setDesc] = useState<string | null>(null);
    if (!a) return null;
    const locked = a.approvalStatus === "approved";
    const act = (fn: () => Promise<unknown>, ok: string) => async () => { try { await fn(); setMsg(ok); changed(); } catch (e) { setMsg((e as Error).message); } };
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>{a.name} <span style={{ opacity: 0.6 }}>{a.type} v{a.version}</span> {locked ? "🔒 Approved · LOCK" : "draft"}</b>
            {locked && <div style={{ opacity: 0.7 }}>已批准即锁定，不能原地修改；需要改动请新建版本。</div>}
            <textarea rows={3} disabled={locked} style={input(ctx)} value={desc ?? a.description ?? ""} onChange={(e) => setDesc(e.target.value)} />
            <div><b>Invariants</b>：{(a.invariants ?? []).join("；") || "（空：批准前至少填一条）"}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {!locked && <button style={btn(ctx)} disabled={desc === null} onClick={act(() => api.patch(`/assets/${ffId}`, { description: desc }), "已保存")}>保存</button>}
                {!locked && <button style={btn(ctx, true)} onClick={act(() => api.post(`/assets/${ffId}/approve`), "已批准并锁定")}>批准（LOCK）</button>}
                {locked && <button style={btn(ctx)} onClick={act(() => api.post(`/assets/${ffId}/versions`, {}), "已创建新版本（草稿）")}>新版本</button>}
                <button style={btn(ctx)} onClick={() => open(meta(ctx).ffProjectId)}>在工作台打开</button>
                <button style={btn(ctx)} onClick={onClose}>关闭</button>
            </div>
            <div style={{ opacity: 0.8 }}>版本：{[...(a.versions ?? [])].reverse().map((v: any) => (
                <span key={v.version} style={{ marginRight: 8 }}>v{v.version}·{v.approvalStatus}{v.approvalStatus === "approved" && v.version !== a.version && <a style={{ marginLeft: 3, cursor: "pointer", color: "#6366f1" }} onClick={act(() => api.post(`/assets/${ffId}/rollback`, { version: v.version }), `已回滚到 v${v.version}`)}>回滚</a>}</span>
            ))}</div>
            {msg && <div style={{ color: "#6366f1" }}>{msg}</div>}
        </div>
    );
}

// ---------------------------------------------------------------- shot
const hasPending = (d: any) => d?.__pending;
async function loadShot(id: string) {
    const [d, jobs] = await Promise.all([api.get(`/shots/${id}`), api.get(`/generations?targetId=${id}`)]);
    return { ...d, __pending: jobs.some((j: any) => j.status === "QUEUED" || j.status === "RUNNING") };
}

function ShotContent({ ctx }: { ctx: Ctx }) {
    const { ffId } = meta(ctx);
    const { data: s, err, changed } = useLive(ctx, () => loadShot(ffId!), [ffId], hasPending);
    // Canvas connections are the user's gesture; the domain is the truth. Connecting an Asset node to a Shot adds it to the shot.
    const upstreamAssets = ctx.getUpstream().filter((n) => n.type === "filmflow:asset").map((n) => (n.metadata as any)?.ffId as string).filter(Boolean);
    const missing = s ? upstreamAssets.filter((id) => !s.assetIds.includes(id)) : [];
    const key = missing.join(",");
    useLive(ctx, async () => { if (missing.length) { await api.patch(`/shots/${ffId}`, { assetIds: [...s.assetIds, ...missing] }); changed(); } return null; }, [key]);
    if (err) return <Problem ctx={ctx} err={err} />;
    if (!s) return null;
    const hero = s.keyframes?.find((k: any) => k.status === "hero")?.media;
    const take = s.takes?.find((t: any) => t.status === "approved");
    const high = s.issues?.filter((i: any) => i.status === "open" && i.severity === "high").length ?? 0;
    const thumb = (take?.media ?? hero);
    return (
        <Card ctx={ctx} color="#6366f1" title={`#${s.ord + 1} ${s.title || s.narrativeFunction}`} sub={`${s.narrativeFunction} · ${s.camera?.shotSize} ${s.camera?.lensMm}mm · ${s.status}${s.__pending ? " · 生成中…" : ""}`}
            right={thumb ? <img src={api.mediaUrl(thumb.url)} draggable={false} style={{ width: 96, height: "100%", objectFit: "cover" }} /> : undefined}>
            <div style={{ display: "flex", gap: 4, fontSize: 10, marginTop: "auto" }}>
                {s.heroKeyframeId && <span title="Hero Frame">🎞 Hero</span>}{take && <span title="Approved Take">✅ Take</span>}{high > 0 && <span style={{ color: "#ef4444" }}>⚠ 连续性 {high}</span>}
            </div>
        </Card>
    );
}

function ShotPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
    const { ffId, ffProjectId: pid } = meta(ctx);
    const { data: s, changed } = useLive(ctx, () => loadShot(ffId!), [ffId], hasPending);
    const est = useLive(ctx, () => api.post(`/shots/${ffId}/estimate`, { kind: "image", count: 3 }), [ffId, s?.bindings?.length]);
    const [msg, setMsg] = useState("");
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [role, setRole] = useState<Record<string, string>>({});
    const [override, setOverride] = useState<{ takeId: string; issues: any[]; reason: string } | null>(null);
    if (!s) return null;
    const act = (fn: () => Promise<any>, ok?: string) => async () => { try { const r = await fn(); if (ok) setMsg(ok); changed(); return r; } catch (e: any) { setMsg(e.message); } };
    const approve = async (takeId: string, reason?: string) => {
        try { await api.post(`/takes/${takeId}/approve`, reason ? { overrideReason: reason } : {}); setOverride(null); setMsg("已批准 Take"); changed(); }
        catch (e: any) { e.code === "continuity_blocked" ? setOverride({ takeId, issues: e.details, reason: "" }) : setMsg(e.message); }
    };
    const save = act(() => api.patch(`/shots/${ffId}`, { ...(draft.action !== undefined ? { action: draft.action } : {}), camera: { ...s.camera, ...(draft.shotSize ? { shotSize: draft.shotSize } : {}), ...(draft.lensMm ? { lensMm: Number(draft.lensMm) } : {}) } }).then(() => setDraft({})), "已保存，状态链已重算");
    // Reference Routing from existing canvas nodes: any upstream image node can become a Reference and be bound with a role.
    const upstreamImages = ctx.getUpstream().filter((n) => n.type === "image");
    const bindImage = async (n: any) => {
        try {
            const src = n.metadata?.images?.find((i: any) => i.id === n.metadata?.primaryImageId)?.content ?? n.metadata?.images?.[0]?.content ?? n.metadata?.content;
            if (!src) throw new Error("该图片节点还没有图片");
            const blob = await (await fetch(src)).blob();
            const m = await api.uploadBlob(blob, pid!);
            const r = await api.post(`/projects/${pid}/references`, { kind: "image", name: n.title || "canvas image", mediaId: m.id, source: "canvas-node", sourceRef: n.id });
            const rl = role[n.id] ?? "IDENTITY";
            await api.post(`/shots/${ffId}/bindings`, { referenceId: r.id, role: rl, lockLevel: rl === "IDENTITY" ? "LOCK" : "CONTROL" });
            setMsg(`已登记为参考并绑定为 ${rl}`); changed();
        } catch (e: any) { setMsg(e.message); }
    };
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>镜头 #{s.ord + 1} · {s.narrativeFunction} · {s.status}</b>
            <textarea rows={2} style={input(ctx)} value={draft.action ?? s.action ?? ""} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
            <div style={{ display: "flex", gap: 6 }}>
                <select style={input(ctx)} value={draft.shotSize ?? s.camera?.shotSize} onChange={(e) => setDraft({ ...draft, shotSize: e.target.value })}>{["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS"].map((v) => <option key={v}>{v}</option>)}</select>
                <input style={input(ctx)} type="number" value={draft.lensMm ?? s.camera?.lensMm} onChange={(e) => setDraft({ ...draft, lensMm: e.target.value })} />
                <button style={btn(ctx)} disabled={!Object.keys(draft).length} onClick={save}>保存</button>
            </div>

            <div style={{ opacity: 0.8 }}>绑定的参考：{s.bindings.map((b: any) => `${b.role}(${b.lockLevel})`).join("、") || "无"}</div>
            {upstreamImages.map((n) => (
                <div key={n.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>上游图片：{n.title}</span>
                    <select style={{ ...input(ctx), width: 120 }} value={role[n.id] ?? "IDENTITY"} onChange={(e) => setRole({ ...role, [n.id]: e.target.value })}>{SHOT_ROLES.map((r) => <option key={r}>{r}</option>)}</select>
                    <button style={btn(ctx)} onClick={() => bindImage(n)}>登记为参考</button>
                </div>
            ))}

            <div style={{ borderTop: `1px solid ${ctx.theme.node.stroke}`, paddingTop: 6 }}>
                <button style={btn(ctx, true)} onClick={act(async () => { const r = await api.post(`/shots/${ffId}/keyframes`, { count: 3 }); if (r.degradations?.length) setMsg(`模型降级：${r.degradations.map((d: any) => d.role).join(", ")}`); }, "关键帧任务已入队（刷新页面不会丢）")}>生成 3 张关键帧</button>
                {est.data && <span style={{ marginLeft: 8, opacity: 0.7 }}>{est.data.modelId} · 预计 {est.data.total.credits} 积分</span>}
                {s.__pending && <span style={{ marginLeft: 8, color: "#6366f1" }}>生成中…</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
                {s.keyframes.map((k: any) => (
                    <div key={k.id} style={{ border: `2px solid ${k.status === "hero" ? "#6366f1" : "transparent"}`, borderRadius: 6, overflow: "hidden" }}>
                        <img src={api.mediaUrl(k.media?.url)} draggable={false} style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", display: "block" }} />
                        <div style={{ display: "flex", justifyContent: "space-between", padding: 2 }}><span>{k.status === "hero" ? "HERO·LOCK" : k.status}</span>{k.status !== "hero" && <a style={{ cursor: "pointer", color: "#6366f1" }} onClick={act(() => (k.status === "superseded" ? api.post(`/shots/${ffId}/hero/rollback`, { keyframeId: k.id }) : api.post(`/keyframes/${k.id}/promote`)))}>{k.status === "superseded" ? "回滚" : "设为Hero"}</a>}</div>
                    </div>
                ))}
            </div>
            <div><button style={btn(ctx, true)} disabled={!s.heroKeyframeId} onClick={act(() => api.post(`/shots/${ffId}/takes`, { count: 2 }), "Take 任务已入队")}>基于 Hero 生成 2 个 Take</button>{!s.heroKeyframeId && <span style={{ marginLeft: 8, opacity: 0.6 }}>先设一张 Hero Frame</span>}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 6 }}>
                {s.takes.map((t: any) => (
                    <div key={t.id} style={{ border: `2px solid ${t.status === "approved" ? "#22c55e" : "transparent"}`, borderRadius: 6, overflow: "hidden" }}>
                        <img src={api.mediaUrl(t.media?.url)} draggable={false} style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", display: "block" }} />
                        <div style={{ display: "flex", justifyContent: "space-between", padding: 2 }}><span>{t.status}</span>{t.status === "candidate" && <a style={{ cursor: "pointer", color: "#22c55e" }} onClick={() => approve(t.id)}>批准</a>}{t.status === "superseded" && <a style={{ cursor: "pointer", color: "#6366f1" }} onClick={act(() => api.post(`/shots/${ffId}/take/rollback`, { takeId: t.id }))}>回滚</a>}</div>
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
            {s.issues.filter((i: any) => i.status === "open").length > 0 && <div><b>连续性</b>{s.issues.filter((i: any) => i.status === "open").map((i: any) => <div key={i.id} style={{ color: i.severity === "high" ? "#ef4444" : undefined }}>· [{i.severity}] {i.message}</div>)}</div>}
            {msg && <div style={{ color: "#6366f1" }}>{msg}</div>}
            <div style={{ display: "flex", gap: 6 }}><button style={btn(ctx)} onClick={() => open(pid)}>在工作台打开（QC / 状态 / 历史）</button><button style={btn(ctx)} onClick={onClose}>关闭</button></div>
        </div>
    );
}

// ---------------------------------------------------------------- definitions
const common = { transparentBackground: false, autoOpenPanel: false, minimapColor: "#6366f1" };
export const nodes: CanvasNodeDefinition[] = [
    { ...common, type: "filmflow:project", title: "FilmFlow 项目", icon: "🎬", description: "连接 FilmFlow 项目，把领域节点同步到画布", defaultSize: SIZE.project, defaultMetadata: {}, minimapColor: "#111827", Content: HubContent, Panel: HubPanel, toolbar: (ctx) => [{ id: "open", title: "在工作台打开", label: "工作台", icon: "↗", onClick: () => open(meta(ctx).ffProjectId) }] },
    { ...common, type: "filmflow:world", title: "World", icon: "🌍", defaultSize: SIZE.world, showInCreateMenu: false, minimapColor: KIND_COLOR.world, Content: (p) => <WorldLookContent ctx={p.ctx} kind="world" />, Panel: (p) => <WorldLookPanel {...p} kind="world" /> },
    { ...common, type: "filmflow:look", title: "Look", icon: "🎨", defaultSize: SIZE.look, showInCreateMenu: false, minimapColor: KIND_COLOR.look, Content: (p) => <WorldLookContent ctx={p.ctx} kind="look" />, Panel: (p) => <WorldLookPanel {...p} kind="look" /> },
    { ...common, type: "filmflow:asset", title: "资产", icon: "🧍", defaultSize: SIZE.asset, showInCreateMenu: false, minimapColor: KIND_COLOR.Character, Content: AssetContent, Panel: AssetPanel, resource: (n) => ({ kind: "text", text: `${n.title}` }) },
    { ...common, type: "filmflow:shot", title: "镜头", icon: "🎞", defaultSize: SIZE.shot, showInCreateMenu: false, Content: ShotContent, Panel: ShotPanel },
];
