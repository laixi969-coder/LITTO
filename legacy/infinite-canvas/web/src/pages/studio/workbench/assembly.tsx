import { useEffect, useRef, useState } from "react";
import { App, Alert, Button, Empty, Input, Segmented, Select, Slider, Switch } from "antd";
import { Flag, Pause, Play, Redo2, RefreshCw, Undo2 } from "lucide-react";

import { LITTO_BASE, api } from "@/services/api/litto";
import { ClipInspector } from "./nle/clip-inspector";
import { GradePanel } from "./nle/grade-panel";
import { Preview } from "./nle/preview";
import { RenderPanel } from "./nle/render-panel";
import { Timeline } from "./nle/timeline";
import { useEdit } from "./nle/use-edit";
import { useWorkbench } from "./use-workbench";

const mm = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** Assembly = non-linear editor over the server's edit timeline (multi-track, trims, transitions, grade, mix, render) + interchange export. */
export function Assembly() {
    const wb = useWorkbench();
    const { message, modal } = App.useApp();
    const seqId = wb.activeSeq;
    const { edit, busy, load, run, undo, redo, conform } = useEdit(seqId);
    const [zoom, setZoom] = useState(60);
    const [t, setT] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [sel, setSel] = useState<string | null>(null);
    const [ripple, setRipple] = useState(false);
    const [tab, setTab] = useState<"clip" | "grade" | "sub" | "render">("clip");
    const [gradeShot, setGradeShot] = useState<string | null>(null);
    const [subs, setSubs] = useState<Record<string, string>>({});
    const last = useRef(0);

    // playback: advance the playhead in real time
    useEffect(() => {
        if (!playing || !edit) return;
        last.current = performance.now();
        const id = setInterval(() => { const now = performance.now(); const dt = (now - last.current) / 1000; last.current = now; setT((x) => { const n = x + dt; if (n >= edit.duration) { setPlaying(false); return edit.duration; } return n; }); }, 40);
        return () => clearInterval(id);
    }, [playing, edit?.duration]);
    // keyboard: space / S / Delete / ctrl-z
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
            if (e.code === "Space") { e.preventDefault(); setPlaying((p) => !p); }
            else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); void (e.shiftKey ? redo() : undo()); }
            else if ((e.key === "Delete" || e.key === "Backspace") && sel) void run([{ type: "delete_clip", id: sel, ripple }]);
            else if (e.key.toLowerCase() === "s" && sel && edit) { const c = edit.clips.find((x) => x.id === sel); if (c && t > c.start + 0.1 && t < c.start + c.duration - 0.1) void run([{ type: "split_clip", id: c.id, at: Math.round(t * 1000) / 1000 }]); }
        };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [sel, ripple, t, edit, run, undo, redo]);
    useEffect(() => { setSel(null); setT(0); setPlaying(false); setSubs({}); }, [seqId]);
    useEffect(() => { void load(); }, [wb.shots.length]);

    if (!seqId) return <Empty className="mt-16" description="先创建序列并拆出镜头" />;
    if (!edit) return null;
    const clip = edit.clips.find((c) => c.id === sel) ?? null;
    const dl = (path: string) => window.open(`${LITTO_BASE}/sequences/${seqId}/${path}`, "_blank");
    const shotClips = edit.clips.filter((c) => c.type === "shot").sort((a, b) => (a.shotOrder ?? 0) - (b.shotOrder ?? 0));
    const saveSubs = async () => {
        try { await api.put(`/sequences/${seqId}/subtitles`, { lines: Object.entries(subs).map(([shotId, text]) => ({ shotId, text })) }); setSubs({}); message.success("字幕已保存"); await wb.reload(); await load(); } catch (e: any) { message.error(e.message); }
    };
    const missing = edit.clips.filter((c) => c.type === "shot" && c.source.kind !== "take").length;
    const addMarker = () => run([{ type: "add_marker", t: Math.round(t * 100) / 100, label: `M${edit.markers.length + 1}` }]);
    const addAudio = async () => {
        const refs = await api.get(`/projects/${wb.pid}/references`);
        const audio = refs.filter((r: any) => r.kind === "audio" && r.mediaId);
        if (!audio.length) return message.info("先在左侧「参考」里上传音频文件");
        let pick = audio[0].id, track = edit.tracks.find((x) => x.kind === "audio" && !x.locked)?.id ?? "A1";
        modal.confirm({
            title: "添加音频片段",
            content: <div className="space-y-2"><Select className="w-full" defaultValue={pick} onChange={(v) => (pick = v)} options={audio.map((r: any) => ({ value: r.id, label: r.name }))} /><Select className="w-full" defaultValue={track} onChange={(v) => (track = v)} options={edit.tracks.filter((x) => x.kind === "audio").map((x) => ({ value: x.id, label: x.name }))} /></div>,
            onOk: async () => { const r = audio.find((x: any) => x.id === pick); await run([{ type: "add_clip", clip: { trackId: track, type: "media", mediaId: r.mediaId, start: Math.round(t * 100) / 100, label: r.name } }]); },
        });
    };

    return (
        <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
                <Select size="small" className="!w-40" value={seqId} onChange={wb.setActiveSeq} options={wb.sequences.map((s) => ({ value: s.id, label: s.name }))} />
                <Button size="small" icon={playing ? <Pause size={13} /> : <Play size={13} />} onClick={() => setPlaying(!playing)} />
                <span className="w-24 tabular-nums text-xs">{mm(t)} / {mm(edit.duration)}</span>
                <Button size="small" icon={<Undo2 size={13} />} disabled={!edit.historyDepth || busy} onClick={() => undo()} title="撤销 (⌘Z)" />
                <Button size="small" icon={<Redo2 size={13} />} disabled={!edit.futureDepth || busy} onClick={() => redo()} title="重做 (⇧⌘Z)" />
                <Button size="small" icon={<Flag size={13} />} onClick={addMarker}>标记</Button>
                <Button size="small" onClick={addAudio}>+ 音频</Button>
                <Button size="small" onClick={() => run([{ type: "add_track", kind: "audio", role: "sfx" }])}>+ 音轨</Button>
                <Button size="small" onClick={() => run([{ type: "add_track", kind: "video" }])}>+ 视频轨</Button>
                <Button size="small" icon={<RefreshCw size={13} />} onClick={() => conform(false)} title="把新增镜头/新批准的 Take 同步进时间线，保留你的手动剪辑">重新 conform</Button>
                <Button size="small" danger onClick={() => modal.confirm({ title: "重置时间线？", content: "按镜头顺序重建，所有手动剪辑、转场、音轨片段都会丢失（可撤销）。", okType: "danger", onOk: () => conform(true) })}>重置</Button>
                <div className="flex-1" />
                <span className="flex w-32 items-center gap-1 text-xs">缩放<Slider className="!m-0 flex-1" min={10} max={200} value={zoom} onChange={setZoom} /></span>
                <Button size="small" onClick={() => dl("export")}>导出交换包</Button><Button size="small" onClick={() => dl("timeline.edl")}>EDL</Button><Button size="small" onClick={() => dl("subtitles.srt")}>SRT</Button>
                <Button size="small" type="primary" onClick={() => setTab("render")}>渲染…</Button>
            </div>
            {missing > 0 && <Alert type="warning" showIcon className="!py-0.5 !text-xs" message={`${missing} 个镜头还没有已批准的 Take，渲染前需要补齐（预览会显示 Hero 静帧/黑场）。`} />}

            <div className="grid gap-3 lg:grid-cols-[minmax(260px,360px)_1fr]">
                <Preview edit={edit} t={t} playing={playing} />
                <div className="min-h-[200px] rounded border border-black/10 dark:border-white/10">
                    <Segmented size="small" className="m-2" value={tab} onChange={(v) => setTab(v as any)} options={[{ label: "片段", value: "clip" }, { label: "调色", value: "grade" }, { label: "字幕", value: "sub" }, { label: "渲染/混音", value: "render" }]} />
                    <div className="max-h-[320px] overflow-auto">
                        {tab === "clip" && <ClipInspector edit={edit} clip={clip} playhead={t} ripple={ripple} setRipple={setRipple} run={run} openGrade={(id) => { setGradeShot(id); setTab("grade"); }} />}
                        {tab === "grade" && (
                            <div className="grid gap-2 md:grid-cols-2">
                                <div>{gradeShot ? <GradePanel key={gradeShot} scope="shot" id={gradeShot} title={`镜头调色 #${(wb.shots.find((s) => s.id === gradeShot)?.ord ?? 0) + 1}`} /> : <div className="p-3 text-xs opacity-60">在「片段」页点“调色…”，或在这里选择镜头：<Select size="small" className="mt-2 !w-full" onChange={setGradeShot} options={shotClips.map((c) => ({ value: c.shotId!, label: `#${(c.shotOrder ?? 0) + 1} ${c.label}` }))} /></div>}</div>
                                <GradePanel key={seqId} scope="sequence" id={seqId} title="序列调色（最后应用）" onSaved={load} />
                            </div>
                        )}
                        {tab === "sub" && (
                            <div className="space-y-1 p-3"><div className="flex items-center gap-2"><b>字幕 / 台词</b><Button size="small" type="primary" disabled={!Object.keys(subs).length} onClick={saveSubs}>保存字幕</Button></div>
                                {shotClips.map((c) => <div key={c.id} className="flex items-center gap-2"><span className="w-8 text-xs opacity-50">#{(c.shotOrder ?? 0) + 1}</span><Input size="small" value={subs[c.shotId!] ?? c.subtitle} placeholder="（无字幕）" onFocus={() => { setSel(c.id); setT(c.start); }} onChange={(e) => setSubs({ ...subs, [c.shotId!]: e.target.value })} /></div>)}</div>
                        )}
                        {tab === "render" && <RenderPanel seqId={seqId} edit={edit} run={run} />}
                    </div>
                </div>
            </div>

            <Timeline edit={edit} zoom={zoom} playhead={t} setPlayhead={(x) => { setPlaying(false); setT(x); }} selected={sel} onSelect={setSel} run={run} />
            <div className="flex items-center gap-3 text-[11px] opacity-60">
                <span>空格 播放 · S 在播放头分割 · Delete 删除 · ⌘Z 撤销 · 拖动边缘修剪 · 自动吸附</span>
                <label className="flex items-center gap-1"><Switch size="small" checked={ripple} onChange={setRipple} />波纹编辑</label>
                {edit.markers.length > 0 && <span>标记：{edit.markers.map((m) => <button key={m.id} className="mr-1 underline" onClick={() => setT(m.t)} onDoubleClick={() => run([{ type: "remove_marker", id: m.id }])} title="点击跳转，双击删除">{m.label || mm(m.t)}</button>)}</span>}
            </div>
        </div>
    );
}
