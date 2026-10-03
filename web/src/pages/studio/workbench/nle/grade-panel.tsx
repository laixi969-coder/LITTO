import { useEffect, useRef, useState } from "react";
import { App, Button, Slider, Tag } from "antd";

import { api } from "@/services/api/filmflow";

type G = { lift: number[]; gamma: number[]; gain: number[]; saturation: number; contrast: number; temperature: number; exposureStops: number; hasLut?: boolean; lutCube?: string };
const NEUTRAL: G = { lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0], saturation: 1, contrast: 1, temperature: 0, exposureStops: 0 };
const CH = ["R", "G", "B"];

/** Parametric grade for one shot (PUT /shots/:id/grade) or the whole sequence (PUT /sequences/:id/grade). LUT text is write-only. */
export function GradePanel({ scope, id, title, onSaved }: { scope: "shot" | "sequence"; id: string; title: string; onSaved?: () => void }) {
    const { message } = App.useApp();
    const [g, setG] = useState<G>(NEUTRAL);
    const [cube, setCube] = useState<string | null | undefined>(undefined); // undefined = unchanged, null = removed, string = new
    const [dirty, setDirty] = useState(false);
    const file = useRef<HTMLInputElement>(null);
    const path = `/${scope === "shot" ? "shots" : "sequences"}/${id}/grade`;
    useEffect(() => { setCube(undefined); setDirty(false); api.get(path).then((x) => setG({ ...NEUTRAL, ...(x ?? {}) })).catch((e) => message.error(e.message)); }, [path]);
    const set = (patch: Partial<G>) => { setG({ ...g, ...patch }); setDirty(true); };
    const vec = (k: "lift" | "gamma" | "gain", label: string) => (
        <div><div className="mb-0.5 opacity-70">{label}</div>
            {CH.map((c, i) => <div key={c} className="flex items-center gap-2"><span className="w-3 opacity-60">{c}</span><Slider className="!m-0 flex-1" min={-1} max={1} step={0.01} value={g[k][i]} onChange={(v) => set({ [k]: g[k].map((x, j) => (j === i ? v : x)) } as any)} /><span className="w-10 text-right tabular-nums">{g[k][i].toFixed(2)}</span></div>)}</div>
    );
    const one = (label: string, k: "saturation" | "contrast" | "temperature" | "exposureStops", min: number, max: number, step: number) => (
        <div className="flex items-center gap-2"><span className="w-16 opacity-70">{label}</span><Slider className="!m-0 flex-1" min={min} max={max} step={step} value={g[k]} onChange={(v) => set({ [k]: v } as any)} /><span className="w-10 text-right tabular-nums">{g[k]}</span></div>
    );
    const save = async (reset = false) => {
        try {
            const { hasLut, lutCube, ...params } = g;
            const grade = reset ? null : { ...params, ...(cube ? { lutCube: cube } : {}) };
            const payload: any = { grade, keepLut: !reset && cube === undefined && !!hasLut };
            if (scope === "sequence") { const e = await api.get(`/sequences/${id}/edit`); payload.expectedVersion = e.version; }
            const saved = await api.put(path, payload);
            setG({ ...NEUTRAL, ...(saved ?? {}) }); setCube(undefined); setDirty(false); message.success(reset ? "已清除调色" : "调色已保存"); onSaved?.();
        } catch (e: any) { message.error(e.message); }
    };
    const pick = async (f?: File) => { if (!f) return; if (f.size > 2 * 1024 * 1024) return message.error("LUT 不能超过 2MB"); setCube(await f.text()); setG((x) => ({ ...x, hasLut: true })); setDirty(true); };
    return (
        <div className="space-y-2 p-3 text-xs">
            <div className="flex items-center gap-2"><b>{title}</b>{(g.hasLut || cube) && <Tag className="!m-0" color="purple">LUT</Tag>}</div>
            {vec("lift", "Lift（暗部）")}{vec("gamma", "Gamma（中间调）")}{vec("gain", "Gain（高光）")}
            {one("饱和度", "saturation", 0, 3, 0.05)}{one("对比度", "contrast", 0.5, 2, 0.05)}{one("色温", "temperature", -100, 100, 1)}{one("曝光 EV", "exposureStops", -4, 4, 0.1)}
            <div className="flex flex-wrap items-center gap-2">
                <input ref={file} type="file" accept=".cube,text/plain" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
                <Button size="small" onClick={() => file.current?.click()}>上传 .cube LUT</Button>
                {(g.hasLut || cube) && <Button size="small" onClick={() => { setCube(null); setG((x) => ({ ...x, hasLut: false })); setDirty(true); }}>移除 LUT</Button>}
            </div>
            <div className="flex gap-2"><Button size="small" type="primary" disabled={!dirty} onClick={() => save(false)}>保存</Button><Button size="small" onClick={() => { setG(NEUTRAL); setCube(null); setDirty(true); }}>归零</Button><Button size="small" danger onClick={() => save(true)}>清除调色</Button></div>
            <div className="opacity-50">渲染时先应用镜头调色，再应用序列调色（需要服务端 ffmpeg）。</div>
        </div>
    );
}
