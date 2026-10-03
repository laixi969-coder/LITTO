import { useEffect, useState } from "react";
import { App, Alert, Button, Empty, Input, Select, Tag } from "antd";

import { FF_BASE, api } from "@/services/api/filmflow";
import { Media } from "./media";
import { useWorkbench } from "./use-workbench";

const KIND_BG: Record<string, string> = { take: "bg-emerald-500/70", hero: "bg-indigo-500/60", missing: "bg-neutral-400/50" };
const KIND_LABEL: Record<string, string> = { take: "Approved Take", hero: "仅 Hero 静帧", missing: "缺失" };

/** Assembly (Phase 5): approved Take per shot in order, subtitles, audio refs, EDL / SRT / package export, optional ffmpeg render. */
export function Assembly() {
    const wb = useWorkbench();
    const { message } = App.useApp();
    const seqId = wb.activeSeq;
    const [tl, setTl] = useState<any>(null);
    const [renders, setRenders] = useState<any[]>([]);
    const [subs, setSubs] = useState<Record<string, string>>({});
    const [focus, setFocus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        if (!seqId) return;
        try { const t = await api.get(`/sequences/${seqId}/timeline`); setTl(t); setRenders(await api.get(`/sequences/${seqId}/renders`)); } catch (e: any) { message.error(e.message); }
    };
    useEffect(() => { setTl(null); setSubs({}); void load(); }, [seqId, wb.shots.length]);
    useEffect(() => {
        if (!renders.some((r) => r.status === "RUNNING")) return;
        const t = setInterval(() => void load(), 1500);
        return () => clearInterval(t);
    }, [renders]);

    if (!seqId) return <Empty className="mt-16" description="先创建序列并拆出镜头" />;
    if (!tl) return null;
    const clipsByShot = new Map<string, any>(tl.clips.map((c: any) => [c.shotId, c]));
    const sel = clipsByShot.get(focus ?? wb.sel?.id ?? "") ?? tl.clips[0];
    const shot = sel && wb.shots.find((s) => s.id === sel.shotId);
    const media = shot?.approvedTake?.media ?? shot?.heroKeyframe?.media;
    const dirty = Object.keys(subs).length > 0;
    const saveSubs = async () => {
        try { await api.put(`/sequences/${seqId}/subtitles`, { lines: Object.entries(subs).map(([shotId, text]) => ({ shotId, text })) }); setSubs({}); message.success("字幕已保存"); await wb.reload(); await load(); } catch (e: any) { message.error(e.message); }
    };
    const render = async () => { setBusy(true); try { await api.post(`/sequences/${seqId}/render`); message.info("已开始渲染"); await load(); } catch (e: any) { message.error(e.message); } setBusy(false); };
    const dl = (path: string) => window.open(`${FF_BASE}/sequences/${seqId}/${path}`, "_blank");
    const mm = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;

    return (
        <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
                <Select size="small" className="!w-44" value={seqId} onChange={wb.setActiveSeq} options={wb.sequences.map((s) => ({ value: s.id, label: s.name }))} />
                <span className="text-xs opacity-60">{tl.clips.length} 镜 · {mm(tl.duration)} · {tl.fps}fps</span>
                <div className="flex-1" />
                <Button size="small" onClick={() => dl("export")}>导出交换包 (.zip)</Button>
                <Button size="small" onClick={() => dl("timeline.edl")}>EDL</Button>
                <Button size="small" onClick={() => dl("subtitles.srt")}>SRT</Button>
                <Button size="small" type="primary" loading={busy || renders[0]?.status === "RUNNING"} onClick={render}>渲染 MP4</Button>
            </div>
            {tl.warnings.map((w: string) => <Alert key={w} type="warning" showIcon message={w} className="!py-0.5 !text-xs" />)}

            <div>
                <div className="flex h-14 w-full overflow-hidden rounded border border-black/10 dark:border-white/10">
                    {tl.clips.map((c: any) => (
                        <button key={c.shotId} title={`#${c.order + 1} ${c.title} · ${KIND_LABEL[c.kind]} · ${c.duration}s`} onClick={() => { setFocus(c.shotId); wb.select({ kind: "shot", id: c.shotId }); }} style={{ width: `${(c.duration / (tl.duration || 1)) * 100}%` }} className={`relative min-w-[18px] overflow-hidden border-r border-black/20 text-left text-[10px] ${KIND_BG[c.kind]} ${sel?.shotId === c.shotId ? "outline outline-2 -outline-offset-2 outline-indigo-500" : ""}`}>
                            <span className="px-1">#{c.order + 1}</span><span className="block truncate px-1 opacity-80">{c.title}</span>
                        </button>
                    ))}
                </div>
                <div className="mt-1 flex gap-3 text-[11px] opacity-70">{Object.entries(KIND_LABEL).map(([k, l]) => <span key={k} className="flex items-center gap-1"><i className={`inline-block h-2 w-3 rounded-sm ${KIND_BG[k]}`} />{l}</span>)}</div>
                {tl.audio.length > 0 && <div className="mt-2 space-y-0.5 text-xs">{tl.audio.map((a: any) => <div key={a.referenceId + a.shotId} className="flex items-center gap-2 rounded bg-sky-500/15 px-2 py-0.5"><span>🔊 {a.name ?? "音频"}</span><span className="opacity-60">{mm(a.start)} – {mm(a.start + a.duration)}</span></div>)}</div>}
            </div>

            {sel && (
                <div className="grid gap-3 md:grid-cols-[320px_1fr]">
                    <div className="space-y-1"><Media media={media} controls className="aspect-video w-full rounded" /><div className="text-xs opacity-70">#{sel.order + 1} {sel.title} · {mm(sel.start)} <Tag className="!m-0">{KIND_LABEL[sel.kind]}</Tag></div></div>
                    <div className="space-y-1">
                        <div className="flex items-center gap-2"><b>字幕 / 台词</b><Button size="small" type="primary" disabled={!dirty} onClick={saveSubs}>保存字幕</Button></div>
                        <div className="max-h-72 space-y-1 overflow-auto">
                            {tl.clips.map((c: any) => <div key={c.shotId} className="flex items-center gap-2"><span className="w-8 text-xs opacity-50">#{c.order + 1}</span><Input size="small" value={subs[c.shotId] ?? c.subtitle} placeholder="（无字幕）" onFocus={() => setFocus(c.shotId)} onChange={(e) => setSubs({ ...subs, [c.shotId]: e.target.value })} /></div>)}
                        </div>
                    </div>
                </div>
            )}

            {renders.length > 0 && (
                <div className="space-y-1">
                    <b>渲染记录</b>
                    {renders.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 text-xs"><Tag color={r.status === "SUCCEEDED" ? "success" : r.status === "FAILED" ? "error" : "processing"}>{r.status}</Tag><span className="opacity-60">{new Date(r.createdAt).toLocaleString()}</span>
                            {r.media && <a href={FF_BASE + r.media.url} target="_blank" rel="noreferrer">下载 MP4</a>}{r.error && <span className="text-red-500">{r.error}</span>}</div>
                    ))}
                    <div className="text-[11px] opacity-50">渲染需要服务端安装 ffmpeg，且每个镜头都有真实视频的 Approved Take；否则请使用「导出交换包」导入剪辑软件。</div>
                </div>
            )}
        </div>
    );
}
