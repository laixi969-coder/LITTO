import { Check, ShieldAlert } from "lucide-react";

import { Media } from "./media";
import { watchersOf } from "./use-collab";
import { useWorkbench } from "./use-workbench";

/** Bottom Shot Strip: Hero Frame / Approved Take / QC at a glance. */
export function ShotStrip() {
    const wb = useWorkbench();
    const items = wb.strip.filter((s) => !wb.activeSeq || s.sequenceId === wb.activeSeq);
    const bar = (kind: string) => ({ hero: "#6366f1", take: "#22c55e" })[kind];
    return (
        <div className="flex h-[112px] shrink-0 gap-2 overflow-x-auto border-t border-black/10 p-2 dark:border-white/10">
            {items.map((s) => {
                const w = watchersOf(wb.presence, "shot", s.shotId);
                return (
                <button key={s.shotId} onClick={() => wb.select({ kind: "shot", id: s.shotId })} style={w[0] ? { borderColor: w[0].color, boxShadow: `0 0 0 2px ${w[0].color}66` } : undefined} className={`relative w-[132px] shrink-0 overflow-hidden rounded border text-left ${wb.sel?.id === s.shotId ? "border-indigo-500" : "border-black/10 dark:border-white/10"}`}>
                    {w[0] && <span style={{ background: w[0].color }} className="absolute left-0 top-0 z-10 max-w-full truncate rounded-br px-1 text-[10px] text-white">{w.map((x) => x.email.split("@")[0]).join(", ")}</span>}
                    <Media media={s.approvedTake?.media ?? s.hero?.media} className="h-[64px] w-full" />
                    <div className="px-1.5 pt-0.5 text-[11px]"><span className="opacity-50">#{s.order + 1}</span> <span className="truncate">{s.title}</span></div>
                    <div className="flex items-center gap-1 px-1.5 text-[10px]">
                        <span style={{ background: bar("hero") }} className={`h-1.5 w-1.5 rounded-full ${s.hero ? "" : "opacity-20"}`} title="Hero Frame" />
                        <span style={{ background: bar("take") }} className={`h-1.5 w-1.5 rounded-full ${s.approvedTake ? "" : "opacity-20"}`} title="Approved Take" />
                        {s.qcScore !== null && <span className="opacity-60">QC {s.qcScore}</span>}
                        {s.highIssues > 0 ? <ShieldAlert size={11} className="ml-auto text-red-500" /> : s.approvedTake ? <Check size={11} className="ml-auto text-emerald-500" /> : null}
                    </div>
                </button>
                );
            })}
            {!items.length && <div className="m-auto text-xs opacity-50">导演指令会把剧本拆成镜头，镜头会出现在这里。</div>}
        </div>
    );
}
