import { useMemo, useRef, useState } from "react";
import { Button, InputNumber } from "antd";
import { Lock, Unlock, Volume2, VolumeX } from "lucide-react";

import type { Clip, Edit } from "./use-edit";

const HEAD = 150;
const SNAP_PX = 8;
const COLOR: Record<string, string> = { take: "bg-emerald-500/70", hero: "bg-indigo-500/60", missing: "bg-neutral-400/60", media: "bg-sky-500/60" };

type Drag = { id: string; mode: "move" | "l" | "r"; x0: number; y0: number; o: Clip; start: number; duration: number; in: number; trackId: string; moved: boolean };

/** Multi-track timeline: ruler, scrub, drag to move, drag edges to trim, snapping to clip edges / markers / playhead. */
export function Timeline({ edit, zoom, playhead, setPlayhead, selected, onSelect, run }: { edit: Edit; zoom: number; playhead: number; setPlayhead: (t: number) => void; selected: string | null; onSelect: (id: string | null) => void; run: (ops: any[]) => Promise<any> }) {
    const [drag, setDrag] = useState<Drag | null>(null);
    const lanes = useRef<Record<string, HTMLDivElement | null>>({});
    const total = Math.max(edit.duration + 4, 12);
    const width = total * zoom;
    const step = zoom >= 80 ? 1 : zoom >= 40 ? 2 : zoom >= 20 ? 5 : 10;

    const snapPoints = useMemo(() => {
        const p = [0, playhead, ...edit.markers.map((m) => m.t)];
        for (const c of edit.clips) if (c.id !== drag?.id) p.push(c.start, c.start + c.duration);
        return p;
    }, [edit, playhead, drag?.id]);
    const snap = (t: number) => { let best = t, d = SNAP_PX / zoom; for (const p of snapPoints) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; } return best; };

    const down = (e: React.PointerEvent, c: Clip, mode: Drag["mode"]) => {
        const tk = edit.tracks.find((t) => t.id === c.trackId);
        e.stopPropagation();
        onSelect(c.id);
        if (tk?.locked) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setDrag({ id: c.id, mode, x0: e.clientX, y0: e.clientY, o: c, start: c.start, duration: c.duration, in: c.in, trackId: c.trackId, moved: false });
    };
    const move = (e: React.PointerEvent) => {
        if (!drag) return;
        const dt = (e.clientX - drag.x0) / zoom, o = drag.o;
        const next = { ...drag, moved: drag.moved || Math.abs(e.clientX - drag.x0) > 3 };
        if (drag.mode === "move") {
            let s = Math.max(0, o.start + dt);
            const a = snap(s), b = snap(s + o.duration) - o.duration;
            s = Math.abs(a - s) <= Math.abs(b - s) ? a : b;
            next.start = Math.max(0, s);
            const hit = Object.entries(lanes.current).find(([, el]) => { const r = el?.getBoundingClientRect(); return r && e.clientY >= r.top && e.clientY < r.bottom; });
            const target = hit && edit.tracks.find((t) => t.id === hit[0]);
            const cur = edit.tracks.find((t) => t.id === o.trackId);
            next.trackId = target && cur && target.kind === cur.kind ? target.id : o.trackId;
        } else if (drag.mode === "l") {
            const edge = snap(o.start + dt);
            let d = edge - o.start;
            d = Math.max(-o.in / o.speed, Math.min(o.duration - 0.1, d));
            next.start = o.start + d; next.duration = o.duration - d; next.in = o.in + d * o.speed;
        } else {
            const maxD = o.source.srcDuration != null ? (o.source.srcDuration - o.in) / o.speed : Infinity;
            const end = snap(o.start + o.duration + dt);
            next.duration = Math.max(0.1, Math.min(maxD, end - o.start));
        }
        setDrag(next);
    };
    const up = async () => {
        const d = drag;
        setDrag(null);
        if (!d?.moved) return;
        const r = (n: number) => Math.round(n * 1000) / 1000;
        if (d.mode === "move") await run([{ type: "move_clip", id: d.id, start: r(d.start), ...(d.trackId !== d.o.trackId ? { trackId: d.trackId } : {}) }]);
        else if (d.mode === "l") await run([{ type: "trim_clip", id: d.id, in: r(d.in), start: r(d.start), duration: r(d.duration) }]);
        else await run([{ type: "trim_clip", id: d.id, duration: r(d.duration) }]);
    };

    const scrub = (e: React.PointerEvent) => {
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const set = (x: number) => setPlayhead(Math.max(0, Math.round(((x - box.left) / zoom) * 100) / 100));
        set(e.clientX);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        const mv = (ev: PointerEvent) => set(ev.clientX), end = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", end); };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", end);
    };

    const ticks = Array.from({ length: Math.ceil(total / step) + 1 }, (_, i) => i * step);
    return (
        <div className="overflow-auto rounded border border-black/10 text-xs dark:border-white/10" onPointerMove={move} onPointerUp={up}>
            <div style={{ width: HEAD + width }} className="relative">
                {/* ruler */}
                <div className="sticky top-0 z-20 flex h-6 border-b border-black/10 bg-[var(--ant-color-bg-container,transparent)] dark:border-white/10">
                    <div style={{ width: HEAD }} className="sticky left-0 z-30 shrink-0 border-r border-black/10 bg-[var(--ant-color-bg-container,transparent)] px-2 leading-6 opacity-60 dark:border-white/10">{edit.fps}fps</div>
                    <div className="relative cursor-col-resize" style={{ width }} onPointerDown={scrub}>
                        {ticks.map((t) => <span key={t} style={{ left: t * zoom }} className="absolute top-0 h-full border-l border-black/20 pl-1 text-[10px] opacity-60 dark:border-white/20">{Math.floor(t / 60)}:{String(t % 60).padStart(2, "0")}</span>)}
                        {edit.markers.map((m) => <span key={m.id} title={m.label || "marker"} style={{ left: m.t * zoom }} className="absolute bottom-0 h-2 w-2 -translate-x-1 rotate-45 bg-amber-500" />)}
                    </div>
                </div>
                {edit.tracks.map((tk) => {
                    const h = tk.kind === "video" ? 48 : 36;
                    return (
                        <div key={tk.id} className="flex border-b border-black/10 dark:border-white/10" style={{ height: h }}>
                            <div style={{ width: HEAD }} className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-black/10 bg-[var(--ant-color-bg-container,transparent)] px-1 dark:border-white/10">
                                <span className="min-w-0 flex-1 truncate" title={tk.name}>{tk.name}</span>
                                <Button type="text" size="small" className="!px-1" title={tk.muted ? "取消静音" : "静音/隐藏"} icon={tk.muted ? <VolumeX size={13} /> : <Volume2 size={13} />} onClick={() => run([{ type: "update_track", id: tk.id, muted: !tk.muted }])} />
                                <Button type="text" size="small" className="!px-1" title={tk.locked ? "解锁" : "锁定"} icon={tk.locked ? <Lock size={13} className="text-amber-500" /> : <Unlock size={13} />} onClick={() => run([{ type: "update_track", id: tk.id, locked: !tk.locked }])} />
                                <InputNumber size="small" className="!w-12" controls={false} title="轨道增益 dB" value={tk.gainDb} min={-60} max={24} onChange={() => {}} onBlur={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v) && v !== tk.gainDb) void run([{ type: "update_track", id: tk.id, gainDb: v }]); }} />
                            </div>
                            <div ref={(el) => { lanes.current[tk.id] = el; }} className={`relative ${tk.muted ? "opacity-40" : ""}`} style={{ width }} onPointerDown={(e) => { if (e.target === e.currentTarget) { onSelect(null); scrub(e); } }}>
                                {edit.clips.filter((c) => (drag?.id === c.id ? drag.trackId : c.trackId) === tk.id).map((c) => {
                                    const g = drag?.id === c.id ? drag : null;
                                    const s = g ? g.start : c.start, d = g ? g.duration : c.duration;
                                    const kind = c.type === "media" ? "media" : c.source.kind;
                                    return (
                                        <div key={c.id} onPointerDown={(e) => down(e, c, "move")} style={{ left: s * zoom, width: Math.max(4, d * zoom), top: 3, height: h - 6 }} className={`absolute cursor-grab select-none overflow-hidden rounded border text-[10px] ${COLOR[kind] ?? COLOR.media} ${selected === c.id ? "border-indigo-500 ring-1 ring-indigo-500" : "border-black/30"}`}>
                                            <div onPointerDown={(e) => down(e, c, "l")} className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize bg-black/30" />
                                            <div onPointerDown={(e) => down(e, c, "r")} className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize bg-black/30" />
                                            <div className="truncate px-2 pt-0.5">{c.shotOrder !== null ? `#${c.shotOrder + 1} ` : ""}{c.label}</div>
                                            <div className="truncate px-2 opacity-70">{c.speed !== 1 ? `${c.speed}× ` : ""}{c.transition.type !== "cut" ? `⇄ ${c.transition.type === "dissolve" ? "叠化" : "闪黑"} ${c.transition.duration}s` : ""}</div>
                                            {c.transition.type === "dissolve" && <div style={{ width: c.transition.duration * zoom }} className="absolute inset-y-0 left-0 bg-gradient-to-r from-white/50 to-transparent" />}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
                {/* playhead */}
                <div className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-red-500" style={{ left: HEAD + playhead * zoom }}><span className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-red-500" /></div>
            </div>
        </div>
    );
}
