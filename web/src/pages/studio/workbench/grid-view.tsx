import { useState } from "react";
import { App, Button, Segmented } from "antd";

import { api } from "@/services/api/filmflow";
import { Media } from "./media";
import { useWorkbench } from "./use-workbench";

/** Storyboard grid (PRD §9): 9 / 16 / 25 / 32 cells for the active sequence; shift-click to batch-select. */
export function GridView() {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const [n, setN] = useState(9);
    const [busy, setBusy] = useState(false);
    const shots = wb.shots.filter((s) => !wb.activeSeq || s.sequenceId === wb.activeSeq).sort((a, b) => a.ord - b.ord);
    const cols = { 9: 3, 16: 4, 25: 5, 32: 8 }[n]!;
    const pages = Math.max(1, Math.ceil(shots.length / n));
    const [page, setPage] = useState(0);
    const p = Math.min(page, pages - 1);
    const cells = Array.from({ length: n }, (_, i) => shots[p * n + i]);
    const click = (e: React.MouseEvent, id: string) => {
        if (e.shiftKey) wb.setMulti(wb.multi.includes(id) ? wb.multi.filter((x) => x !== id) : [...wb.multi, id]);
        else { wb.select({ kind: "shot", id }); wb.setMulti([]); }
    };
    const batch = async () => {
        setBusy(true);
        try { for (const id of wb.multi) await api.post(`/shots/${id}/keyframes`, { count: 2 }); message.success(`已为 ${wb.multi.length} 个镜头提交关键帧任务`); wb.setMulti([]); await wb.reload(); } catch (e: any) { message.error(e.message); }
        setBusy(false);
    };
    return (
        <div className="flex h-full flex-col gap-2 overflow-auto p-3">
            <div className="flex items-center gap-3 text-sm">
                <Segmented size="small" value={n} onChange={(v) => { setN(v as number); setPage(0); }} options={[9, 16, 25, 32].map((v) => ({ label: `${v} 宫格`, value: v }))} />
                {pages > 1 && <Segmented size="small" value={p} onChange={(v) => setPage(v as number)} options={Array.from({ length: pages }, (_, i) => ({ label: `${i + 1}`, value: i }))} />}
                <span className="text-xs opacity-60">共 {shots.length} 镜 · Shift+点击多选</span>
                <div className="flex-1" />
                {wb.multi.length > 0 && <Button size="small" type="primary" loading={busy} onClick={batch}>批量生成关键帧 ({wb.multi.length})</Button>}
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {cells.map((s, i) => {
                    if (!s) return <div key={`e${i}`} className="aspect-video rounded border border-dashed border-black/10 opacity-40 dark:border-white/10" />;
                    const sel = wb.sel?.id === s.id, multi = wb.multi.includes(s.id);
                    const high = s.issues?.filter((x: any) => x.severity === "high").length;
                    return (
                        <button key={s.id} onClick={(e) => click(e, s.id)} className={`overflow-hidden rounded border text-left ${multi ? "border-amber-500 ring-2 ring-amber-500/40" : sel ? "border-indigo-500 ring-2 ring-indigo-500/40" : "border-black/10 dark:border-white/10"}`}>
                            <div className="relative"><Media media={s.approvedTake?.media ?? s.heroKeyframe?.media} className="aspect-video w-full" />
                                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">#{s.ord + 1}</span>
                                {high > 0 && <span className="absolute right-1 top-1 rounded bg-red-500 px-1 text-[10px] text-white">连续性 {high}</span>}
                                {s.approvedTake && <span className="absolute bottom-1 right-1 rounded bg-emerald-600 px-1 text-[10px] text-white">Take ✓</span>}</div>
                            <div className="px-1.5 py-1 text-[11px]"><div className="truncate font-medium">{s.title || s.narrativeFunction}</div><div className="truncate opacity-60">{s.narrativeFunction} · {s.status}</div></div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
