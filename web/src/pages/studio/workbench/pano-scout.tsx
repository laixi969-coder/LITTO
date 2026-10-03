import { useEffect, useState } from "react";
import { App, Button, Select } from "antd";

import { api, mediaSrc } from "@/services/api/ovia";
import { PanoViewer, type PanoView } from "./pano-viewer";
import { useWorkbench } from "./use-workbench";

/** "360° 勘景" for Environment assets: look around the bound panorama, then write that view into a shot's camera. */
export function PanoScout({ asset, onChanged }: { asset: any; onChanged: () => void }) {
    const wb = useWorkbench();
    const { message, modal } = App.useApp();
    const panos = (asset.bindings ?? []).filter((b: any) => b.role === "PANORAMA");
    const [refId, setRefId] = useState<string | undefined>(panos[0]?.referenceId);
    const [shotId, setShotId] = useState<string | undefined>();
    const [view, setView] = useState<PanoView>({ yaw: 0, pitch: 0, fov: 90 });
    useEffect(() => setRefId(panos[0]?.referenceId), [asset.id, panos.length]);
    const ref = wb.refs.find((r) => r.id === refId);
    const shots = wb.shots.filter((s) => (s.assetIds ?? []).includes(asset.id));

    const bind = async (id: string) => { try { await api.post(`/assets/${asset.id}/bindings`, { referenceId: id, role: "PANORAMA", lockLevel: "CONTROL" }); onChanged(); } catch (e: any) { message.error(e.message); } };
    const use = async (confirm = false) => {
        const sh = wb.shots.find((s) => s.id === shotId);
        if (!sh) return;
        try {
            await api.patch(`/shots/${sh.id}`, { camera: { ...sh.camera, viewYaw: view.yaw, viewPitch: view.pitch, viewFov: view.fov }, ...(confirm ? { confirm: true } : {}) });
            message.success(`已把视角写入镜头 #${sh.ord + 1}`); await wb.reload();
        } catch (e: any) {
            if (e.code === "needs_confirmation") modal.confirm({ title: "该镜头已有 Hero Frame / Approved Take", content: "修改会影响已批准的内容，确认继续？", onOk: () => use(true) });
            else message.error(e.message);
        }
    };

    return (
        <div className="space-y-2 border-t border-black/10 pt-2 text-xs dark:border-white/10">
            <div className="font-medium">360° 勘景</div>
            {!panos.length ? (
                <div className="space-y-1">
                    <div className="opacity-60">还没有全景参考。选一张等距柱状（2:1）全景图作为 PANORAMA 绑定到此场景：</div>
                    <Select size="small" className="w-full" placeholder="选择图片参考" options={wb.refs.filter((r) => r.kind === "image").map((r) => ({ value: r.id, label: r.name }))} onChange={bind} />
                </div>
            ) : (
                <>
                    {panos.length > 1 && <Select size="small" className="w-full" value={refId} onChange={setRefId} options={panos.map((b: any) => ({ value: b.referenceId, label: wb.refs.find((r) => r.id === b.referenceId)?.name ?? b.referenceId }))} />}
                    {ref?.media ? <PanoViewer src={mediaSrc(ref.media.url)} view={view} onChange={setView} /> : <div className="opacity-60">参考没有可预览的图片</div>}
                    <div className="opacity-70">yaw {view.yaw}° · pitch {view.pitch}° · fov {view.fov}°（拖拽环视，滚轮缩放）</div>
                    <div className="flex gap-1">
                        <Select size="small" className="flex-1" placeholder={shots.length ? "写入哪个镜头" : "没有使用此场景的镜头"} value={shotId} onChange={setShotId} options={shots.map((s) => ({ value: s.id, label: `#${s.ord + 1} ${s.title || s.narrativeFunction}` }))} />
                        <Button size="small" type="primary" disabled={!shotId} onClick={() => use(false)}>用此视角</Button>
                    </div>
                </>
            )}
        </div>
    );
}
