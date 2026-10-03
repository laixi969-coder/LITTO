import { useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";

import { watchersOf } from "./use-collab";
import { useWorkbench } from "./use-workbench";
import { BindDialog } from "./bind-dialog";
import { Media } from "./media";

const W = 190, H = 84;
const KIND_STYLE: Record<string, string> = { world: "#0ea5e9", look: "#a855f7", Character: "#f97316", Wardrobe: "#ec4899", Environment: "#22c55e", Prop: "#eab308", Product: "#eab308", Vehicle: "#eab308", Creature: "#f97316", Custom: "#64748b", shot: "#6366f1", reference: "#94a3b8" };

type N = { id: string; kind: string; refId: string; x: number; y: number; title: string; sub?: string; color: string; approved?: boolean; shot?: any };

/** Domain canvas: node layout is persisted as canvas JSON (coords only); meaning lives in the domain tables, so edges are derived from real relations. */
export function DomainCanvas() {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const ref = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<null | { type: "pan" | "node" | "marquee"; sx: number; sy: number; id?: string; ox?: number; oy?: number; moved?: boolean }>(null);
    const [marquee, setMarquee] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
    const [bind, setBind] = useState<null | { shotId: string; refId: string }>(null);
    const vp = wb.canvas.viewport;

    const nodes: N[] = useMemo(() => {
        const saved = new Map(wb.canvas.nodes.map((n) => [`${n.kind}:${n.refId}`, n]));
        const out: N[] = [];
        const put = (kind: string, refId: string, title: string, color: string, dx: number, dy: number, extra: Partial<N> = {}) => {
            const s = saved.get(`${kind}:${refId}`);
            out.push({ id: `${kind}:${refId}`, kind, refId, x: s?.x ?? dx, y: s?.y ?? dy, title, color, ...extra });
        };
        put("world", wb.world?.id ?? "w", "World", KIND_STYLE.world, 0, 0, { sub: wb.world?.architecture || wb.world?.locationLogic || "定义世界" });
        put("look", wb.look?.id ?? "l", "Look", KIND_STYLE.look, 0, 110, { sub: (wb.look?.palette ?? []).join(" / ") || "定义影调" });
        wb.assets.forEach((a, i) => put("asset", a.id, a.name, KIND_STYLE[a.type] ?? "#64748b", 0, 240 + i * 100, { sub: `${a.type} · v${a.version}`, approved: a.approvalStatus === "approved" }));
        const seqIds = wb.sequences.map((s) => s.id);
        wb.shots.forEach((s) => {
            const row = Math.max(0, seqIds.indexOf(s.sequenceId));
            put("shot", s.id, `#${s.ord + 1} ${s.title || s.narrativeFunction}`, KIND_STYLE.shot, 300 + (s.ord % 5) * 250, row * 640 + Math.floor(s.ord / 5) * 200, { sub: `${s.narrativeFunction} · ${s.camera?.shotSize ?? ""} ${s.camera?.lensMm ?? ""}mm`, shot: s });
        });
        return out;
    }, [wb.assets, wb.shots, wb.world, wb.look, wb.sequences, wb.canvas.nodes]);
    const pos = new Map(nodes.map((n) => [n.id, n]));

    const edges = useMemo(() => {
        const e: { id: string; a: string; b: string; label: string; dash?: boolean }[] = [];
        for (const s of wb.shots) {
            for (const aid of s.assetIds ?? []) if (pos.has(`asset:${aid}`)) e.push({ id: `u${aid}${s.id}`, a: `asset:${aid}`, b: `shot:${s.id}`, label: "uses" });
            for (const b of s.bindings ?? []) { const asset = wb.assets.find((a) => a.references?.includes(b.referenceId)); if (asset && !s.assetIds?.includes(asset.id) && pos.has(`asset:${asset.id}`)) e.push({ id: `b${b.id}`, a: `asset:${asset.id}`, b: `shot:${s.id}`, label: b.role, dash: true }); }
        }
        const bySeq = new Map<string, any[]>();
        wb.shots.forEach((s) => bySeq.set(s.sequenceId, [...(bySeq.get(s.sequenceId) ?? []), s]));
        for (const list of bySeq.values()) list.sort((a, b) => a.ord - b.ord).forEach((s, i) => i && e.push({ id: `n${s.id}`, a: `shot:${list[i - 1].id}`, b: `shot:${s.id}`, label: "state →" }));
        if (wb.world) for (const s of wb.shots.slice(0, 1)) e.push({ id: "wl", a: "world:" + wb.world.id, b: `shot:${s.id}`, label: "governs", dash: true });
        return e;
    }, [wb.shots, wb.assets, wb.world, nodes]);

    const toWorld = (cx: number, cy: number) => { const r = ref.current!.getBoundingClientRect(); return { x: (cx - r.left - vp.x) / vp.k, y: (cy - r.top - vp.y) / vp.k }; };
    const commit = (nx: N[], viewport = vp) => wb.saveCanvas({ ...wb.canvas, viewport, nodes: nx.map((n) => ({ id: n.id, kind: n.kind, refId: n.refId, x: Math.round(n.x), y: Math.round(n.y) })) });

    const onWheel = (e: React.WheelEvent) => {
        const k = Math.min(2, Math.max(0.25, vp.k * (e.deltaY < 0 ? 1.1 : 0.9)));
        const r = ref.current!.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        commit(nodes, { k, x: mx - ((mx - vp.x) / vp.k) * k, y: my - ((my - vp.y) / vp.k) * k });
    };
    const down = (e: React.PointerEvent, id?: string) => {
        e.stopPropagation();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        if (id) { const n = pos.get(id)!; setDrag({ type: "node", sx: e.clientX, sy: e.clientY, id, ox: n.x, oy: n.y }); return; }
        if (e.shiftKey) { const w = toWorld(e.clientX, e.clientY); setDrag({ type: "marquee", sx: e.clientX, sy: e.clientY }); setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y }); return; }
        setDrag({ type: "pan", sx: e.clientX, sy: e.clientY, ox: vp.x, oy: vp.y });
    };
    const move = (e: React.PointerEvent) => {
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.type === "pan") wb.saveCanvas({ ...wb.canvas, viewport: { ...vp, x: drag.ox! + dx, y: drag.oy! + dy } });
        else if (drag.type === "node") commit(nodes.map((n) => (n.id === drag.id ? { ...n, x: drag.ox! + dx / vp.k, y: drag.oy! + dy / vp.k } : n)));
        else if (marquee) { const w = toWorld(e.clientX, e.clientY); setMarquee({ ...marquee, x1: w.x, y1: w.y }); }
    };
    const up = () => {
        if (drag?.type === "marquee" && marquee) {
            const [x0, x1] = [Math.min(marquee.x0, marquee.x1), Math.max(marquee.x0, marquee.x1)], [y0, y1] = [Math.min(marquee.y0, marquee.y1), Math.max(marquee.y0, marquee.y1)];
            wb.setMulti(nodes.filter((n) => n.kind === "shot" && n.x + W > x0 && n.x < x1 && n.y + H > y0 && n.y < y1).map((n) => n.refId));
        } else if (drag?.type === "node" && !drag.moved) {
            const n = pos.get(drag.id!)!;
            wb.select({ kind: n.kind as any, id: n.refId });
            wb.setMulti([]);
        } else if (drag?.type === "pan" && !drag.moved) { wb.select(null); wb.setMulti([]); }
        setDrag(null); setMarquee(null);
    };
    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const refId = e.dataTransfer.getData("application/x-litto-ref");
        if (!refId) return;
        const w = toWorld(e.clientX, e.clientY);
        const hit = nodes.find((n) => n.kind === "shot" && w.x >= n.x && w.x <= n.x + W && w.y >= n.y && w.y <= n.y + H);
        if (hit) setBind({ shotId: hit.refId, refId }); else message.info("把参考图拖到某个镜头节点上，选择「参考什么」");
    };
    useEffect(() => { if (!wb.canvas.nodes.length && nodes.length) commit(nodes); }, [nodes.length]);

    return (
        <div ref={ref} className="relative h-full w-full touch-none overflow-hidden bg-[radial-gradient(circle,rgba(128,128,128,.25)_1px,transparent_1px)] [background-size:24px_24px]" onWheel={onWheel} onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <div style={{ transform: `translate(${vp.x}px,${vp.y}px) scale(${vp.k})`, transformOrigin: "0 0" }} className="absolute left-0 top-0">
                <svg className="pointer-events-none absolute overflow-visible" width="1" height="1">
                    {edges.map((e) => {
                        const a = pos.get(e.a), b = pos.get(e.b);
                        if (!a || !b) return null;
                        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
                        return (
                            <g key={e.id} opacity={0.55}>
                                <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray={e.dash ? "4 4" : undefined} />
                                {e.label !== "uses" && <text x={mx} y={(y1 + y2) / 2 - 4} fontSize={10} textAnchor="middle" fill="currentColor">{e.label}</text>}
                            </g>
                        );
                    })}
                </svg>
                {nodes.map((n) => {
                    const selected = wb.sel?.id === n.refId || wb.multi.includes(n.refId);
                    const hero = n.shot?.heroKeyframe?.media;
                    const watchers = n.kind === "shot" || n.kind === "asset" ? watchersOf(wb.presence, n.kind, n.refId) : [];
                    const ring = watchers[0]?.color;
                    return (
                        <div key={n.id} onPointerDown={(e) => down(e, n.id)} style={{ left: n.x, top: n.y, width: W, height: H, borderColor: ring ?? (selected ? n.color : undefined), boxShadow: ring ? `0 0 0 2px ${ring}88` : selected ? `0 0 0 2px ${n.color}55` : undefined }} className="absolute cursor-grab select-none overflow-hidden rounded-lg border border-black/15 bg-white/90 dark:border-white/15 dark:bg-neutral-900/90">
                            <div style={{ background: n.color }} className="absolute inset-y-0 left-0 w-1" />
                            {watchers[0] && <span style={{ background: ring }} className="absolute right-0 top-0 z-10 max-w-[70%] truncate rounded-bl px-1 text-[10px] text-white">{watchers.map((x) => x.email.split("@")[0]).join(", ")}</span>}
                            {n.kind === "shot" && <Media media={hero} className="absolute right-0 top-0 h-full w-[84px] opacity-90" />}
                            <div className="relative h-full pl-3 pr-2 pt-1.5" style={n.kind === "shot" ? { paddingRight: 90 } : undefined}>
                                <div className="truncate text-[13px] font-medium">{n.title} {n.approved && <span title="Approved · LOCK">🔒</span>}</div>
                                <div className="mt-0.5 line-clamp-2 text-[11px] opacity-60">{n.sub}</div>
                                {n.shot && <div className="absolute bottom-1 left-3 flex gap-1 text-[10px]"><span className="rounded bg-black/10 px-1 dark:bg-white/15">{n.shot.status}</span>{n.shot.issues?.some((i: any) => i.severity === "high") && <span className="rounded bg-red-500/80 px-1 text-white">连续性</span>}</div>}
                            </div>
                        </div>
                    );
                })}
                {marquee && <div className="absolute border border-indigo-500 bg-indigo-500/10" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
            </div>
            <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] opacity-50">滚轮缩放 · 拖拽平移 · Shift+拖拽框选镜头批处理 · 拖参考图到镜头节点绑定 · {Math.round(vp.k * 100)}%</div>
            {bind && <BindDialog shotId={bind.shotId} referenceId={bind.refId} onClose={() => setBind(null)} />}
        </div>
    );
}
