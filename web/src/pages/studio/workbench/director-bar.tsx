import { useState } from "react";
import { App, Button, Input, Modal, Segmented, Steps, Switch } from "antd";
import { Sparkles } from "lucide-react";

import { api } from "@/services/api/ovia";
import { useWorkbench } from "./use-workbench";

const LABEL: Record<string, string> = { understand_goal: "理解目标", world_and_assets: "World / 已批准资产", sequence_and_shots: "Sequence / Shots", skills: "Skills", reference_plan: "Reference Plan", freedom_map: "Freedom Map", router: "Router", generate: "Generate", qc: "QC", continuity: "Continuity", repair: "Repair", llm_refine: "LLM 精修" };

/** Top Director Command: script → shots → skills → reference plan → router → (generate) → continuity → repair. */
export function DirectorBar() {
    const wb = useWorkbench();
    const { message, modal } = App.useApp();
    const [open, setOpen] = useState(false);
    const [script, setScript] = useState("");
    const [mode, setMode] = useState<"simple" | "director">("simple");
    const [generate, setGenerate] = useState(false);
    const [replace, setReplace] = useState(false);
    const [useLlm, setUseLlm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<any>(null);

    const run = async (confirm = false) => {
        setBusy(true);
        try {
            const r = await api.post(`/projects/${wb.pid}/director/run`, { script, goal: wb.look?.palette?.join(" "), mode, generate, replace, useLlm, confirm, sequenceId: replace ? wb.activeSeq ?? undefined : undefined });
            if (r.needsConfirmation) {
                const step = r.steps.find((s: any) => s.status === "needs_confirmation");
                modal.confirm({ title: "需要确认", content: step.detail.reason + "。继续会替换这些镜头（已批准的内容不会被静默覆盖，旧版本保留）。", okText: "确认替换", onOk: () => run(true) });
            } else { setResult(r); await wb.reload(); message.success(`已生成 ${r.shotIds.length} 个镜头`); if (r.sequenceId) wb.setActiveSeq(r.sequenceId); }
        } catch (e: any) { message.error(e.message); }
        setBusy(false);
    };
    const seq = wb.sequences.find((s) => s.id === wb.activeSeq);
    return (
        <>
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-black/10 px-3 dark:border-white/10">
                <span className="max-w-[240px] truncate text-sm font-semibold">{wb.project?.name}</span>
                <Input className="!max-w-xl flex-1" prefix={<Sparkles size={14} />} placeholder="Director Command：粘贴剧本，让导演拆成镜头…" onFocus={() => { setScript(script || seq?.script || ""); setOpen(true); }} readOnly />
                <Segmented size="small" value={mode} onChange={(v) => setMode(v as any)} options={[{ label: "Simple", value: "simple" }, { label: "Director", value: "director" }]} />
                {wb.presence.length > 0 && <div className="flex -space-x-1.5" title={wb.presence.map((p) => p.email).join("、") + " 正在协作"}>{[...new Map(wb.presence.map((p) => [p.userId, p])).values()].map((p) => <span key={p.userId} style={{ background: p.color }} className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold uppercase text-white ring-2 ring-white dark:ring-black" title={p.email}>{p.email[0]}</span>)}</div>}
                {wb.multi.length > 0 && <Button size="small" type="primary" onClick={async () => { for (const id of wb.multi) await api.post(`/shots/${id}/keyframes`, { count: 2 }).catch((e) => message.error(e.message)); message.success(`已为 ${wb.multi.length} 个镜头提交关键帧任务`); wb.setMulti([]); }}>批量生成关键帧 ({wb.multi.length})</Button>}
            </div>
            <Modal open={open} title="Director Agent" width={760} onCancel={() => setOpen(false)} footer={<div className="flex items-center gap-3"><span className="text-xs">生成关键帧 <Switch size="small" checked={generate} onChange={setGenerate} /></span><span className="text-xs">LLM 精修 <Switch size="small" checked={useLlm} onChange={setUseLlm} /></span><span className="text-xs">替换当前序列镜头 <Switch size="small" checked={replace} onChange={setReplace} /></span><div className="flex-1" /><Button onClick={() => setOpen(false)}>关闭</Button><Button type="primary" loading={busy} disabled={!script.trim()} onClick={() => run(false)}>运行</Button></div>}>
                <Input.TextArea rows={9} value={script} onChange={(e) => setScript(e.target.value)} placeholder={"INT. APARTMENT - NIGHT\nMara notices the Letter on the table. She picks up the Letter.\nMARA: You read it, didn't you?\nELI: I had to know."} />
                <div className="mt-1 text-xs opacity-60">按叙事功能（Establish / Reveal / Reaction / Contrast / Transition / Match / Rhythm）切镜，不按句号切。资产名出现在剧本里会自动挂到镜头。{mode === "simple" ? "Simple：只展示结果。" : "Director：展示每一步的结构化输出。"}</div>
                {result && (mode === "director" ? <div className="mt-3 max-h-72 space-y-2 overflow-auto text-xs">{result.steps.map((s: any) => <details key={s.step} open={s.step === "continuity"}><summary className="cursor-pointer">{s.status === "done" ? "✓" : s.status === "skipped" ? "–" : "!"} {LABEL[s.step]}</summary><pre className="overflow-auto rounded bg-black/5 p-2 dark:bg-white/10">{JSON.stringify(s.detail, null, 1)}</pre></details>)}</div> : <Steps className="mt-3" size="small" current={result.steps.length} items={result.steps.map((s: any) => ({ title: LABEL[s.step] }))} />)}
            </Modal>
        </>
    );
}
