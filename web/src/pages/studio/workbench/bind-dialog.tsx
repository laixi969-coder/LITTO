import { useState } from "react";
import { App, InputNumber, Modal, Radio, Select } from "antd";

import { api } from "@/services/api/filmflow";
import { useWorkbench } from "./use-workbench";

export const ROLES = ["IDENTITY", "GEOMETRY", "WARDROBE", "ENVIRONMENT", "COMPOSITION", "LIGHTING", "LOOK", "PERFORMANCE", "CAMERA_MOTION", "START_FRAME", "END_FRAME", "AUDIO", "DEPTH", "PANORAMA"];
export const ROLE_HINT: Record<string, string> = { IDENTITY: "这个人/物是谁", GEOMETRY: "形状与尺寸", WARDROBE: "服装", ENVIRONMENT: "空间/场景", COMPOSITION: "构图", LIGHTING: "光线", LOOK: "影调质感", PERFORMANCE: "表演", CAMERA_MOTION: "运镜", START_FRAME: "起始帧", END_FRAME: "结束帧", AUDIO: "声音", DEPTH: "深度图", PANORAMA: "360° 全景环境" };

/** "Drag a reference onto a shot → choose what it references" (PRD §7). */
export function BindDialog({ shotId, referenceId, onClose }: { shotId: string; referenceId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const reload = useWorkbench((s) => s.reload);
    const ref = useWorkbench((s) => s.refs.find((r) => r.id === referenceId));
    const [role, setRole] = useState("IDENTITY");
    const [weight, setWeight] = useState(1);
    const [lock, setLock] = useState("CONTROL");
    const ok = async () => {
        try { await api.post(`/shots/${shotId}/bindings`, { referenceId, role, weight, lockLevel: lock }); message.success("已绑定"); await reload(); onClose(); } catch (e: any) { message.error(e.message); }
    };
    return (
        <Modal open title={`参考「${ref?.name ?? ref?.text ?? "reference"}」用来…`} onOk={ok} onCancel={onClose} okText="绑定">
            <div className="space-y-3">
                <Select className="w-full" value={role} onChange={setRole} options={ROLES.map((r) => ({ value: r, label: `${r} — ${ROLE_HINT[r]}` }))} />
                <div className="flex items-center gap-2 text-sm">权重 <InputNumber min={0} max={1} step={0.1} value={weight} onChange={(v) => setWeight(v ?? 1)} /></div>
                <Radio.Group value={lock} onChange={(e) => setLock(e.target.value)} options={["LOCK", "CONTROL", "ALLOW", "RANDOM"]} optionType="button" />
                <div className="text-xs opacity-60">若所选模型不支持该角色，生成前会明确显示降级策略（例如改为文字描述）。</div>
            </div>
        </Modal>
    );
}
