import { useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeDefinition } from "@infinite-canvas/plugin-sdk";
import * as api from "./api";
import { ShotPanel, hasPending, loadShot } from "./shot-panel";
import { SequenceContent, SequencePanel } from "./sequence";
import { Card, KIND_COLOR, Problem, btn, input, meta, panelBox, stop, useLive, type Ctx } from "./shared";

const SIZE = { world: { width: 230, height: 84 }, look: { width: 230, height: 84 }, asset: { width: 230, height: 84 }, shot: { width: 260, height: 108 }, project: { width: 260, height: 120 }, sequence: { width: 230, height: 84 } };
const studioUrl = (pid?: string) => `/studio${pid ? `/p/${pid}` : ""}`;
const open = (pid?: string) => window.open(studioUrl(pid), "_blank");

// ---------------------------------------------------------------- hub
export async function syncToCanvas(ctx: Ctx, pid: string) {
    const [world, looks, assets, shots, seqs] = await Promise.all([api.get(`/projects/${pid}/world`), api.get(`/projects/${pid}/looks`), api.get(`/projects/${pid}/assets`), api.get(`/projects/${pid}/shots`), api.get(`/projects/${pid}/sequences`)]);
    const have = new Set(ctx.getNodes().filter((n) => (n.metadata as any)?.oviaId).map((n) => n.id));
    const { x, y } = ctx.node.position;
    const ops: any[] = [];
    const add = (kind: string, oviaId: string, nodeType: string, title: string, nx: number, ny: number, size: { width: number; height: number }) => {
        const id = `ovia-${kind}-${oviaId}`;
        if (!have.has(id)) ops.push({ type: "add_node", id, nodeType, title, x: nx, y: ny, ...size, metadata: { oviaProjectId: pid, oviaKind: kind, oviaId } });
        return id;
    };
    const w = add("world", world.id, "ovia:world", "World", x + 320, y, SIZE.world);
    const lk = looks.find((l: any) => l.scope === "project");
    if (lk) add("look", lk.id, "ovia:look", "Look", x + 320, y + 110, SIZE.look);
    assets.forEach((a: any, i: number) => add(`asset`, a.id, "ovia:asset", a.name, x + 320, y + 240 + i * 110, SIZE.asset));
    const order = new Map<string, number>(seqs.map((s: any, i: number) => [s.id, i]));
    let rowBase = 0;
    for (const s of seqs) {
        const list = shots.filter((sh: any) => sh.sequenceId === s.id).sort((a: any, b: any) => a.ord - b.ord);
        let prev: string | null = null;
        const seqId = add("sequence", s.id, "ovia:sequence", `成片 · ${s.name}`, x + 660, y + rowBase - 130, SIZE.sequence);
        list.forEach((sh: any, i: number) => {
            const id = add("shot", sh.id, "ovia:shot", `#${sh.ord + 1} ${sh.title || sh.narrativeFunction}`, x + 660 + (i % 5) * 290, y + rowBase + Math.floor(i / 5) * 190, SIZE.shot);
            for (const aid of sh.assetIds ?? []) ops.push({ type: "connect_nodes", fromNodeId: `ovia-asset-${aid}`, toNodeId: id, label: "uses" });
            if (prev) ops.push({ type: "connect_nodes", fromNodeId: prev, toNodeId: id, label: "state →" }); // state flows shot → shot
            prev = id;
        });
        if (list.length) ops.push({ type: "connect_nodes", fromNodeId: `ovia-shot-${list[list.length - 1].id}`, toNodeId: seqId, label: "assembles" }); // last shot → assembly
        rowBase += Math.ceil(Math.max(list.length, 1) / 5) * 190 + 120;
    }
    void order;
    ops.push({ type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: w, label: "governs" });
    // node ops must land before connections referencing them
    ctx.applyOps(ops.filter((o) => o.type === "add_node"));
    setTimeout(() => ctx.applyOps(ops.filter((o) => o.type === "connect_nodes")), 50);
    return { added: ops.filter((o) => o.type === "add_node").length };
}

function HubContent({ ctx }: { ctx: Ctx }) {
    const pid = meta(ctx).oviaProjectId;
    const { data, err } = useLive(ctx, async () => (pid ? { p: await api.get(`/projects/${pid}`), shots: await api.get(`/projects/${pid}/shots`), assets: await api.get(`/projects/${pid}/assets`) } : null), [pid]);
    if (err) return <Problem ctx={ctx} err={err} />;
    return <Card ctx={ctx} color="#111827" title={data?.p?.name ?? "OVIA 项目"} sub={pid ? `${data?.assets.length ?? "…"} 资产 · ${data?.shots.length ?? "…"} 镜头 — 打开面板同步领域节点` : "选中后在面板里选择项目"} />;
}

function HubPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
    const pid = meta(ctx).oviaProjectId;
    const list = useLive(ctx, () => api.get("/projects"), []);
    const [script, setScript] = useState("");
    const [useLlm, setUseLlm] = useState(false);
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);
    const run = (fn: () => Promise<string>) => async () => { setBusy(true); try { setMsg(await fn()); ctx.emit("ovia:changed"); } catch (e) { setMsg((e as Error).message); } setBusy(false); };
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>OVIA 项目枢纽</b>
            <select style={input(ctx)} value={pid ?? ""} onChange={(e) => { const p = list.data?.find((x: any) => x.id === e.target.value); ctx.updateMetadata({ oviaProjectId: e.target.value, oviaKind: "project", oviaId: e.target.value } as any); if (p) ctx.updateNode({ title: p.name }); }}>
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
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} />用 LLM 精修（若已配置文本模型）</label>
                <button style={btn(ctx)} disabled={busy || !script.trim()} onClick={run(async () => { const r = await api.post(`/projects/${pid}/director/run`, { script, minShots: 8, useLlm }); await syncToCanvas(ctx, pid); const l = r.steps.find((x: any) => x.step === "llm_refine"); return `已生成 ${r.shotIds.length} 个镜头并同步到画布${l ? `；LLM 精修：${l.detail.used ? `已使用 ${l.detail.model}` : `未使用（${l.detail.reason}）`}` : ""}`; })}>运行导演并同步</button>
            </>}
            {msg && <div style={{ color: "#6366f1" }}>{msg}</div>}
            <button style={btn(ctx)} onClick={onClose}>关闭</button>
        </div>
    );
}

// ---------------------------------------------------------------- world / look
function WorldLookContent({ ctx, kind }: { ctx: Ctx; kind: "world" | "look" }) {
    const { oviaProjectId: pid } = meta(ctx);
    const { data, err } = useLive(ctx, async () => (kind === "world" ? api.get(`/projects/${pid}/world`) : (await api.get(`/projects/${pid}/looks`)).find((l: any) => l.scope === "project")), [pid]);
    if (err) return <Problem ctx={ctx} err={err} />;
    const sub = kind === "world" ? [data?.era, data?.locationLogic, data?.architecture, data?.weather].filter(Boolean).join(" · ") : [(data?.palette ?? []).join("/"), data?.contrast, data?.grain].filter(Boolean).join(" · ");
    return <Card ctx={ctx} color={KIND_COLOR[kind]} title={kind === "world" ? "World" : "Look"} sub={sub || "点击展开面板进行定义"} />;
}

const WORLD_FIELDS: [string, string][] = [["era", "年代"], ["locationLogic", "地点逻辑"], ["architecture", "建筑"], ["culture", "文化"], ["weather", "天气"], ["time", "时间"], ["material", "材质"], ["physics", "物理"], ["realism", "真实性"]];
const LOOK_FIELDS: [string, string][] = [["contrast", "对比度"], ["saturation", "饱和度"], ["skinTone", "肤色"], ["blackLevel", "黑位"], ["highlightRolloff", "高光滚降"], ["shadowBehavior", "暗部"], ["grain", "颗粒"], ["halation", "光晕"], ["bloom", "bloom"], ["lensCharacter", "镜头性格"], ["texture", "质感"], ["sharpnessPhilosophy", "锐度哲学"]];

function WorldLookPanel({ ctx, kind, onClose }: { ctx: Ctx; kind: "world" | "look"; onClose: () => void }) {
    const { oviaProjectId: pid } = meta(ctx);
    const { data, changed } = useLive(ctx, async () => (kind === "world" ? api.get(`/projects/${pid}/world`) : (await api.get(`/projects/${pid}/looks`)).find((l: any) => l.scope === "project")), [pid]);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const fields = kind === "world" ? WORLD_FIELDS : LOOK_FIELDS;
    const presets = useLive(ctx, () => (kind === "look" ? api.get("/presets/looks") : Promise.resolve([])), [kind]).data ?? [];
    const save = async () => { await (kind === "world" ? api.put(`/projects/${pid}/world`, draft) : api.put(`/projects/${pid}/looks/project`, draft)); setDraft({}); changed(); };
    const basic = kind === "world" ? ["locationLogic", "time", "weather"] : [];
    const row = ([k, label]: [string, string]) => <label key={k} style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 6, alignItems: "center" }}>{label}<input style={input(ctx)} value={draft[k] ?? data?.[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>;
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>{kind === "world" ? "世界观：地点、时间、天气，写几个词就够" : "影调：选一个风格，需要再微调"}</b>
            {kind === "look" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>{presets.map((p: any) => <button key={p.id} style={{ ...btn(ctx), textAlign: "left" }} onClick={() => setDraft({ ...p.look })}><b>{p.name}</b><div style={{ opacity: 0.6, fontSize: 11 }}>{p.desc}</div></button>)}</div>}
            {fields.filter(([k]) => basic.includes(k)).map(row)}
            <details><summary style={{ cursor: "pointer", opacity: 0.8 }}>{kind === "world" ? "更多设定" : "高级微调（对比度 / 颗粒 / 光晕…）"}</summary><div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>{fields.filter(([k]) => !basic.includes(k)).map(row)}</div></details>
            <div style={{ display: "flex", gap: 6 }}><button style={btn(ctx, true)} disabled={!Object.keys(draft).length} onClick={save}>保存</button><button style={btn(ctx)} onClick={onClose}>关闭</button></div>
        </div>
    );
}

// ---------------------------------------------------------------- asset
function AssetContent({ ctx }: { ctx: Ctx }) {
    const { oviaId } = meta(ctx);
    const { data: a, err } = useLive(ctx, () => api.get(`/assets/${oviaId}`), [oviaId]);
    if (err) return <Problem ctx={ctx} err={err} />;
    if (!a) return null;
    const locked = a.approvalStatus === "approved";
    return <Card ctx={ctx} color={KIND_COLOR[a.type] ?? "#64748b"} title={a.name} badge={<span title={locked ? "Approved · LOCK" : "draft"}>{locked ? "🔒" : "✎"}</span>} sub={`${a.type} · v${a.version} · ${a.invariants?.length ?? 0} 条不变量 · ${a.references?.length ?? 0} 参考`} />;
}

function AssetPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
    const { oviaId } = meta(ctx);
    const { data: a, changed } = useLive(ctx, () => api.get(`/assets/${oviaId}`), [oviaId]);
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
                {!locked && <button style={btn(ctx)} disabled={desc === null} onClick={act(() => api.patch(`/assets/${oviaId}`, { description: desc }), "已保存")}>保存</button>}
                {!locked && <button style={btn(ctx, true)} onClick={act(() => api.post(`/assets/${oviaId}/approve`), "已批准并锁定")}>批准（LOCK）</button>}
                {locked && <button style={btn(ctx)} onClick={act(() => api.post(`/assets/${oviaId}/versions`, {}), "已创建新版本（草稿）")}>新版本</button>}
                <button style={btn(ctx)} onClick={() => open(meta(ctx).oviaProjectId)}>在工作台打开</button>
                <button style={btn(ctx)} onClick={onClose}>关闭</button>
            </div>
            <div style={{ opacity: 0.8 }}>版本：{[...(a.versions ?? [])].reverse().map((v: any) => (
                <span key={v.version} style={{ marginRight: 8 }}>v{v.version}·{v.approvalStatus}{v.approvalStatus === "approved" && v.version !== a.version && <a style={{ marginLeft: 3, cursor: "pointer", color: "#6366f1" }} onClick={act(() => api.post(`/assets/${oviaId}/rollback`, { version: v.version }), `已回滚到 v${v.version}`)}>回滚</a>}</span>
            ))}</div>
            {msg && <div style={{ color: "#6366f1" }}>{msg}</div>}
        </div>
    );
}

// ---------------------------------------------------------------- shot

function ShotContent({ ctx }: { ctx: Ctx }) {
    const { oviaId } = meta(ctx);
    const { data: s, err, changed } = useLive(ctx, () => loadShot(oviaId!), [oviaId], hasPending);
    // Canvas connections are the user's gesture; the domain is the truth. Connecting an Asset node to a Shot adds it to the shot.
    const upstreamAssets = ctx.getUpstream().filter((n) => n.type === "ovia:asset").map((n) => (n.metadata as any)?.oviaId as string).filter(Boolean);
    const missing = s ? upstreamAssets.filter((id) => !s.assetIds.includes(id)) : [];
    const key = missing.join(",");
    useLive(ctx, async () => { if (missing.length) { await api.patch(`/shots/${oviaId}`, { assetIds: [...s.assetIds, ...missing] }); changed(); } return null; }, [key]);
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

// ---------------------------------------------------------------- definitions
const common = { transparentBackground: false, autoOpenPanel: true, minimapColor: "#6366f1" };
export const nodes: CanvasNodeDefinition[] = [
    { ...common, type: "ovia:project", title: "OVIA 项目", icon: "🎬", description: "连接 OVIA 项目，把领域节点同步到画布", defaultSize: SIZE.project, defaultMetadata: {}, minimapColor: "#111827", Content: HubContent, Panel: HubPanel, toolbar: (ctx) => [{ id: "open", title: "在工作台打开", label: "工作台", icon: "↗", onClick: () => open(meta(ctx).oviaProjectId) }] },
    { ...common, type: "ovia:world", title: "World", icon: "🌍", defaultSize: SIZE.world, showInCreateMenu: false, minimapColor: KIND_COLOR.world, Content: (p) => <WorldLookContent ctx={p.ctx} kind="world" />, Panel: (p) => <WorldLookPanel {...p} kind="world" /> },
    { ...common, type: "ovia:look", title: "Look", icon: "🎨", defaultSize: SIZE.look, showInCreateMenu: false, minimapColor: KIND_COLOR.look, Content: (p) => <WorldLookContent ctx={p.ctx} kind="look" />, Panel: (p) => <WorldLookPanel {...p} kind="look" /> },
    { ...common, type: "ovia:asset", title: "资产", icon: "🧍", defaultSize: SIZE.asset, showInCreateMenu: false, minimapColor: KIND_COLOR.Character, Content: AssetContent, Panel: AssetPanel, resource: (n) => ({ kind: "text", text: `${n.title}` }) },
    { ...common, type: "ovia:sequence", title: "成片", icon: "🎬", description: "序列装配：时间线、字幕、导出", defaultSize: SIZE.sequence, showInCreateMenu: false, minimapColor: "#0f766e", Content: SequenceContent, Panel: SequencePanel },
    { ...common, type: "ovia:shot", title: "镜头", icon: "🎞", defaultSize: SIZE.shot, showInCreateMenu: false, Content: ShotContent, Panel: ShotPanel },
];
