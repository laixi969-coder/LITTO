import { useEffect, useState } from "@infinite-canvas/plugin-sdk";
import * as api from "./api";
import { Card, Problem, btn, input, meta, panelBox, stop, useLive, type Ctx } from "./shared";

const COLOR: Record<string, string> = { take: "#22c55e", hero: "#6366f1", missing: "#94a3b8" };
const dl = (path: string) => window.open(`/ovia-api${path}`, "_blank");

export function SequenceContent({ ctx }: { ctx: Ctx }) {
    const { oviaId } = meta(ctx);
    const { data, err } = useLive(ctx, async () => ({ seq: (await api.get(`/projects/${meta(ctx).oviaProjectId}/sequences`)).find((q: any) => q.id === oviaId), tl: await api.get(`/sequences/${oviaId}/timeline`) }), [oviaId]);
    if (err) return <Problem ctx={ctx} err={err} />;
    if (!data) return null;
    const { seq, tl } = data;
    return <Card ctx={ctx} color="#0f766e" title={`成片 · ${seq?.name ?? "Sequence"}`} sub={`${tl.duration}s · ${tl.clips.length} 镜 · ${tl.missing.length ? `⚠ ${tl.missing.length} 镜缺 Approved Take` : "全部已批准"}`} />;
}

export function SequencePanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
    const { oviaId: id } = meta(ctx);
    const { data: tl, changed } = useLive(ctx, () => api.get(`/sequences/${id}/timeline`), [id]);
    const renders = useLive<any[]>(ctx, () => api.get(`/sequences/${id}/renders`), [id], (r) => r.some((x) => x.status === "RUNNING"));
    const [edits, setEdits] = useState<Record<string, string>>({});
    const [msg, setMsg] = useState("");
    useEffect(() => void renders.reload(), []);
    if (!tl) return null;
    const dirty = Object.keys(edits).length > 0;
    const saveSubs = async () => { try { await api.put(`/sequences/${id}/subtitles`, { lines: Object.entries(edits).map(([shotId, text]) => ({ shotId, text })) }); setEdits({}); setMsg("字幕已保存"); changed(); } catch (e: any) { setMsg((e as Error).message); } };
    const render = async () => { try { await api.post(`/sequences/${id}/render`); setMsg("渲染已开始"); await renders.reload(); } catch (e: any) { setMsg((e as Error).message); } };
    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} style={panelBox(ctx)}>
            <b>成片装配 · {tl.duration}s · {tl.fps}fps</b>
            <div style={{ display: "flex", height: 34, borderRadius: 6, overflow: "hidden", border: `1px solid ${ctx.theme.node.stroke}` }}>
                {tl.clips.map((c: any) => <div key={c.shotId} title={`#${c.order + 1} ${c.title} · ${c.kind} · ${c.duration}s`} style={{ flex: c.duration, minWidth: 0, background: COLOR[c.kind], color: "#fff", fontSize: 10, padding: "2px 3px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", borderRight: "1px solid rgba(255,255,255,.5)", boxSizing: "border-box" }}>#{c.order + 1} {c.title}</div>)}
            </div>
            <div style={{ opacity: 0.7 }}><span style={{ color: COLOR.take }}>■</span> Approved Take　<span style={{ color: COLOR.hero }}>■</span> 仅 Hero 静帧　<span style={{ color: COLOR.missing }}>■</span> 缺失</div>
            {tl.warnings.map((w: string) => <div key={w} style={{ color: "#f59e0b" }}>⚠ {w}</div>)}
            <b>字幕</b>
            {tl.clips.map((c: any) => (
                <div key={c.shotId} style={{ display: "grid", gridTemplateColumns: "56px 1fr", gap: 6, alignItems: "center" }}>
                    <span style={{ opacity: 0.6 }}>{c.start}s #{c.order + 1}</span>
                    <input style={input(ctx)} placeholder="（无字幕）" value={edits[c.shotId] ?? c.subtitle} onChange={(e) => setEdits({ ...edits, [c.shotId]: e.target.value })} />
                </div>
            ))}
            <div><button style={btn(ctx)} disabled={!dirty} onClick={saveSubs}>保存字幕</button></div>
            <b>音频参考</b>
            {tl.audio.map((a: any) => <div key={a.referenceId + a.shotId}>🎵 {a.name ?? a.referenceId} · 镜头 {a.start}s 起 {a.duration}s</div>)}
            {!tl.audio.length && <div style={{ opacity: 0.6 }}>没有音频参考（给镜头绑定 AUDIO 角色的参考）。</div>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button style={btn(ctx, true)} onClick={() => dl(`/sequences/${id}/export`)}>下载导出包</button>
                <button style={btn(ctx)} onClick={() => dl(`/sequences/${id}/timeline.edl`)}>下载 EDL</button>
                <button style={btn(ctx)} onClick={() => dl(`/sequences/${id}/subtitles.srt`)}>下载 SRT</button>
                <button style={btn(ctx)} onClick={render}>渲染 MP4</button>
            </div>
            {(renders.data ?? []).slice(0, 3).map((r) => (
                <div key={r.id} style={{ opacity: 0.9 }}>
                    {new Date(r.createdAt).toLocaleTimeString()} · <b style={{ color: r.status === "FAILED" ? "#ef4444" : r.status === "SUCCEEDED" ? "#22c55e" : "#6366f1" }}>{r.status}</b>
                    {r.error && <span> · {r.error}</span>}
                    {r.media && <a style={{ marginLeft: 6, color: "#6366f1" }} href={api.mediaUrl(r.media.url)} target="_blank" rel="noreferrer">打开成片</a>}
                </div>
            ))}
            {msg && <div style={{ color: "#6366f1" }}>{msg}</div>}
            <button style={btn(ctx)} onClick={onClose}>关闭</button>
        </div>
    );
}
