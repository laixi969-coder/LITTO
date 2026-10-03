import { useEffect } from "react";

import { api, OVIA_BASE } from "@/services/api/ovia";
import { useOviaStore } from "@/stores/use-ovia-store";
import { useWorkbench } from "./use-workbench";

/** Real-time collaboration: SSE change feed (debounced reload) + presence heartbeat. Everything else stays server-authoritative. */
export function useCollab(pid: string) {
    const me = useOviaStore((s) => s.user?.id);
    const sel = useWorkbench((s) => s.sel);
    const selKey = sel?.kind === "shot" ? `shot:${sel.id}` : sel?.kind === "asset" ? `asset:${sel.id}` : "";

    useEffect(() => {
        if (!pid) return;
        const { reload, setPresence } = useWorkbench.getState();
        const others = (list: any[]) => setPresence((list ?? []).filter((p) => p.userId !== me));
        let t: ReturnType<typeof setTimeout> | undefined;
        const es = new EventSource(`${OVIA_BASE}/projects/${pid}/events`, { withCredentials: true });
        es.addEventListener("hello", (e) => others(JSON.parse((e as MessageEvent).data).presence));
        es.addEventListener("presence", (e) => others(JSON.parse((e as MessageEvent).data)));
        es.addEventListener("change", () => { clearTimeout(t); t = setTimeout(() => void useWorkbench.getState().reload().catch(() => {}), 300); });
        void reload;
        return () => { clearTimeout(t); es.close(); setPresence([]); };
    }, [pid, me]);

    // heartbeat (entries expire server-side after 45s) + immediately when the selection changes
    useEffect(() => {
        if (!pid) return;
        const [kind, id] = selKey.split(":");
        const beat = () => void api.post(`/projects/${pid}/presence`, { shotId: kind === "shot" ? id : null, assetId: kind === "asset" ? id : null }).catch(() => {});
        beat();
        const t = setInterval(beat, 20_000);
        return () => clearInterval(t);
    }, [pid, selKey]);
}

/** Collaborators currently focused on this shot/asset (for rings + labels). */
export const watchersOf = (presence: { shotId: string | null; assetId: string | null; email: string; color: string; userId: string }[], kind: "shot" | "asset", id: string) =>
    presence.filter((p) => (kind === "shot" ? p.shotId : p.assetId) === id);
