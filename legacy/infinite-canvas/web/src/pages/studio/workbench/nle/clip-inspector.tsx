import { Button, InputNumber, Select, Switch } from "antd";
import { Scissors, Trash2 } from "lucide-react";

import type { Clip, Edit } from "./use-edit";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Numeric clip properties. Every field commits through the server op list on blur/change. */
export function ClipInspector({ edit, clip, playhead, ripple, setRipple, run, openGrade }: { edit: Edit; clip: Clip | null; playhead: number; ripple: boolean; setRipple: (v: boolean) => void; run: (ops: any[]) => Promise<any>; openGrade: (shotId: string) => void }) {
    if (!clip) return <div className="p-3 text-xs opacity-60">选中时间线上的片段以编辑修剪、转场、增益与调色。拖动片段移动；拖动两端修剪；Shift 不需要，吸附自动开启。</div>;
    const tk = edit.tracks.find((t) => t.id === clip.trackId)!;
    const video = tk.kind === "video";
    const num = (label: string, value: number, apply: (v: number) => any, opts: { min?: number; max?: number; step?: number } = {}) => (
        <label className="flex items-center justify-between gap-2"><span className="opacity-70">{label}</span>
            <InputNumber size="small" className="!w-24" value={value} min={opts.min} max={opts.max} step={opts.step ?? 0.1} onChange={() => {}} onBlur={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v) && r3(v) !== r3(value)) void run([apply(v)]); }} onPressEnter={(e) => (e.target as HTMLInputElement).blur()} /></label>
    );
    return (
        <div className="space-y-1.5 p-3 text-xs">
            <div className="flex items-center gap-2"><b className="truncate">{clip.shotOrder !== null ? `#${clip.shotOrder + 1} ` : ""}{clip.label || clip.id.slice(-5)}</b><span className="opacity-50">{tk.name}</span></div>
            {num("开始 (s)", clip.start, (v) => ({ type: "move_clip", id: clip.id, start: v }), { min: 0 })}
            {num("时长 (s)", clip.duration, (v) => ({ type: "trim_clip", id: clip.id, duration: v, ripple }), { min: 0.1 })}
            {num("入点 in (s)", clip.in, (v) => ({ type: "trim_clip", id: clip.id, in: v, start: clip.start, duration: clip.duration }), { min: 0 })}
            <div className="flex justify-between opacity-60"><span>出点 out</span><span>{clip.out.toFixed(2)}s{clip.source.srcDuration != null ? ` / 源 ${clip.source.srcDuration.toFixed(2)}s` : ""}</span></div>
            {num("速度 ×", clip.speed, (v) => ({ type: "set_speed", id: clip.id, speed: v }), { min: 0.25, max: 4, step: 0.25 })}
            {video && (
                <div className="space-y-1 rounded bg-black/5 p-2 dark:bg-white/10">
                    <div className="opacity-70">入场转场</div>
                    <div className="flex gap-1"><Select size="small" className="!w-24" value={clip.transition.type} options={[{ value: "cut", label: "硬切" }, { value: "dissolve", label: "叠化" }, { value: "fade_black", label: "闪黑" }]} onChange={(type) => run([{ type: "set_transition", id: clip.id, transition: { type, duration: type === "cut" ? 0 : clip.transition.duration || 1 } }])} />
                        {clip.transition.type !== "cut" && <InputNumber size="small" className="!w-20" min={0.1} max={10} step={0.25} value={clip.transition.duration} onChange={() => {}} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== clip.transition.duration) void run([{ type: "set_transition", id: clip.id, transition: { type: clip.transition.type, duration: v } }]); }} />}</div>
                </div>
            )}
            {num("增益 dB", clip.gainDb, (v) => ({ type: "set_gain", id: clip.id, gainDb: v }), { min: -60, max: 24, step: 1 })}
            {num("淡入 (s)", clip.fadeIn, (v) => ({ type: "set_gain", id: clip.id, fadeIn: v }), { min: 0 })}
            {num("淡出 (s)", clip.fadeOut, (v) => ({ type: "set_gain", id: clip.id, fadeOut: v }), { min: 0 })}
            <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="small" icon={<Scissors size={13} />} disabled={playhead <= clip.start + 0.1 || playhead >= clip.start + clip.duration - 0.1} onClick={() => run([{ type: "split_clip", id: clip.id, at: r3(playhead) }])}>在播放头分割</Button>
                <Button size="small" danger icon={<Trash2 size={13} />} onClick={() => run([{ type: "delete_clip", id: clip.id, ripple }])}>删除</Button>
                <label className="flex items-center gap-1 opacity-80"><Switch size="small" checked={ripple} onChange={setRipple} />波纹</label>
                {clip.shotId && <Button size="small" onClick={() => openGrade(clip.shotId!)}>调色…</Button>}
            </div>
        </div>
    );
}
