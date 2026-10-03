import { useEffect, useState } from "react";
import { App, Button, InputNumber, Select, Slider, Switch, Tag } from "antd";

import { FF_BASE, api } from "@/services/api/filmflow";
import type { Edit } from "./use-edit";

/** Render options, ducking, render history with status polling, and the loudness report of the latest render. */
export function RenderPanel({ seqId, edit, run }: { seqId: string; edit: Edit; run: (ops: any[]) => Promise<any> }) {
    const { message } = App.useApp();
    const [renders, setRenders] = useState<any[]>([]);
    const [opts, setOpts] = useState({ normalizeAudio: true, targetLufs: -16, burnSubtitles: false });
    const [report, setReport] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const load = async () => setRenders(await api.get(`/sequences/${seqId}/renders`));
    useEffect(() => { void load().catch(() => {}); setReport(null); }, [seqId]);
    useEffect(() => { if (!renders.some((r) => r.status === "RUNNING")) return; const t = setInterval(() => void load(), 1500); return () => clearInterval(t); }, [renders]);

    const start = async () => { setBusy(true); try { await api.post(`/sequences/${seqId}/render`, opts); message.info("已开始渲染"); await load(); } catch (e: any) { message.error(e.message); } setBusy(false); };
    const analyse = async () => { try { setReport(await api.get(`/sequences/${seqId}/audio-report`)); } catch (e: any) { setReport(null); message.warning(e.message); } };
    const duck = edit.duck;
    return (
        <div className="space-y-3 p-3 text-xs">
            <div className="grid gap-2 md:grid-cols-2">
                <div className="space-y-1.5 rounded bg-black/5 p-2 dark:bg-white/10">
                    <b>渲染选项</b>
                    <label className="flex items-center justify-between">响度标准化 (loudnorm)<Switch size="small" checked={opts.normalizeAudio} onChange={(v) => setOpts({ ...opts, normalizeAudio: v })} /></label>
                    <label className="flex items-center justify-between">目标响度 LUFS<InputNumber size="small" className="!w-20" min={-40} max={-5} value={opts.targetLufs} disabled={!opts.normalizeAudio} onChange={(v) => setOpts({ ...opts, targetLufs: v ?? -16 })} /></label>
                    <label className="flex items-center justify-between">烧录字幕（需 libass）<Switch size="small" checked={opts.burnSubtitles} onChange={(v) => setOpts({ ...opts, burnSubtitles: v })} /></label>
                    <div className="flex gap-2"><Button size="small" type="primary" loading={busy || renders[0]?.status === "RUNNING"} onClick={start}>渲染 MP4</Button><Button size="small" onClick={analyse}>响度报告</Button></div>
                </div>
                <div className="space-y-1.5 rounded bg-black/5 p-2 dark:bg-white/10">
                    <b>自动避让 (Ducking)</b>
                    <label className="flex items-center justify-between">启用<Switch size="small" checked={!!duck} onChange={(on) => run([{ type: "set_duck", duck: on ? { underRole: "dialogue", amountDb: -12 } : null }])} /></label>
                    {duck && <>
                        <label className="flex items-center justify-between">以谁为主<Select size="small" className="!w-28" value={duck.underRole} options={[{ value: "dialogue", label: "对白" }, { value: "music", label: "音乐" }, { value: "sfx", label: "音效" }]} onChange={(underRole) => run([{ type: "set_duck", duck: { ...duck, underRole } }])} /></label>
                        <div className="flex items-center gap-2"><span>压低 {duck.amountDb} dB</span><Slider className="!m-0 flex-1" min={-30} max={-3} step={1} value={duck.amountDb} onChange={() => {}} onChangeComplete={(v) => run([{ type: "set_duck", duck: { ...duck, amountDb: v } }])} /></div>
                    </>}
                    <div className="opacity-50">其他音轨在“主”音轨出声时被压低（sidechain 压缩）。</div>
                </div>
            </div>
            {report && <div className="flex flex-wrap gap-3 rounded border border-black/10 p-2 dark:border-white/10"><span>积分响度 <b>{report.integratedLufs.toFixed(1)} LUFS</b></span><span>真峰值 <b>{report.truePeakDb.toFixed(1)} dBTP</b></span><span>响度范围 <b>{report.lra.toFixed(1)} LU</b></span><span className="opacity-50">渲染 {report.renderId.slice(-6)}</span></div>}
            <div className="space-y-1">
                {renders.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2"><Tag color={r.status === "SUCCEEDED" ? "success" : r.status === "FAILED" ? "error" : "processing"}>{r.status}</Tag><span className="opacity-60">{new Date(r.createdAt).toLocaleString()}</span>{r.media && <a href={FF_BASE + r.media.url} target="_blank" rel="noreferrer">下载 MP4</a>}{r.error && <span className="text-red-500">{r.error}</span>}</div>)}
                <div className="opacity-50">渲染需要服务端安装 ffmpeg，且每个视频片段都是真实视频；否则请使用「导出交换包」。</div>
            </div>
        </div>
    );
}
