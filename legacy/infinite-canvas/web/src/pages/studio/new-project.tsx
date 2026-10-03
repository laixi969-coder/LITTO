import { useEffect, useState } from "react";
import { App, Input, Modal } from "antd";
import { useNavigate } from "react-router-dom";

import { api } from "@/services/api/litto";

const SAMPLE = `INT. APARTMENT - NIGHT
Mara stands by the window, watching the rain. Eli enters, quiet.
Mara notices the Letter on the table. She picks it up.
MARA: You read it, didn't you?
ELI: I had to know.`;

/** One step: name + style + (optional) script. Characters, locations, props, look, world and shots are created for you. */
export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [name, setName] = useState("");
    const [style, setStyle] = useState("film");
    const [script, setScript] = useState("");
    const [presets, setPresets] = useState<any[]>([]);
    const [busy, setBusy] = useState(false);
    const { message } = App.useApp();
    const nav = useNavigate();
    useEffect(() => { if (open) void api.get("/presets/looks").then(setPresets).catch(() => {}); }, [open]);
    const go = async () => {
        if (!name.trim()) return message.info("给项目起个名字");
        setBusy(true);
        try {
            const p = await api.post("/projects", { name: name.trim() });
            const r = await api.post(`/projects/${p.id}/bootstrap`, { script, lookPresetId: style });
            if (r.shotIds.length) message.success(`已创建 ${r.assets.length} 个资产、${r.shotIds.length} 个镜头`);
            onClose(); nav(`/studio/p/${p.id}`);
        } catch (e: any) { message.error(e.message); }
        setBusy(false);
    };
    return (
        <Modal open={open} title="新建项目" onCancel={onClose} onOk={go} okText={script.trim() ? "创建并拆镜" : "创建"} confirmLoading={busy} width={640}>
            <div className="space-y-4">
                <Input size="large" placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                <div>
                    <div className="mb-1.5 text-sm">选一个画面风格（之后随时能改）</div>
                    <div className="grid grid-cols-3 gap-2">{presets.map((p) => <button type="button" key={p.id} onClick={() => setStyle(p.id)} className={`rounded border p-2 text-left ${style === p.id ? "border-indigo-500 bg-indigo-500/10" : "border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"}`}><div className="text-sm font-medium">{p.name}</div><div className="text-[11px] opacity-60">{p.desc}</div></button>)}</div>
                </div>
                <div>
                    <div className="mb-1.5 flex items-center justify-between text-sm"><span>剧本（可选）</span><button type="button" className="text-xs text-indigo-500" onClick={() => setScript(SAMPLE)}>填入示例</button></div>
                    <Input.TextArea rows={7} value={script} onChange={(e) => setScript(e.target.value)} placeholder="粘贴剧本，会自动识别角色、场景、道具，并按叙事拆成镜头。可以先留空，进去再加。" />
                </div>
            </div>
        </Modal>
    );
}
