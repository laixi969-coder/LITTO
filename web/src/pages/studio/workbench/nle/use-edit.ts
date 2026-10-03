import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";

import { FFError, api } from "@/services/api/filmflow";

export type Track = { id: string; kind: "video" | "audio"; name: string; role?: string; muted: boolean; locked: boolean; gainDb: number };
export type Clip = { id: string; trackId: string; type: "shot" | "media"; shotId?: string; mediaId?: string; start: number; duration: number; in: number; out: number; speed: number; transition: { type: "cut" | "dissolve" | "fade_black"; duration: number }; gainDb: number; fadeIn: number; fadeOut: number; label: string; subtitle: string; shotOrder: number | null; source: { kind: string; mediaId: string | null; mime: string | null; srcDuration: number | null } };
export type Edit = { version: number; fps: number; tracks: Track[]; clips: Clip[]; markers: { id: string; t: number; label: string }[]; grade: any; duck: { underRole: string; amountDb: number } | null; historyDepth: number; futureDepth: number; duration: number };

/** Server-side editable timeline. Every change is an ordered op list sent with expectedVersion; a stale version (409) refetches. */
export function useEdit(seqId: string | null) {
    const { message } = App.useApp();
    const [edit, setEdit] = useState<Edit | null>(null);
    const [busy, setBusy] = useState(false);
    const ver = useRef(0);
    const load = useCallback(async () => {
        if (!seqId) return null;
        try { const e = await api.get<Edit>(`/sequences/${seqId}/edit`); ver.current = e.version; setEdit(e); return e; } catch (e: any) { message.error(e.message); return null; }
    }, [seqId, message]);
    useEffect(() => { setEdit(null); void load(); }, [load]);

    const call = useCallback(async (fn: () => Promise<Edit>) => {
        setBusy(true);
        try { const e = await fn(); ver.current = e.version; setEdit(e); return e; }
        catch (e: any) {
            if (e instanceof FFError && e.code === "stale") message.warning("时间线已被他人修改，已刷新"); else message.error(e.message);
            await load();
            return null;
        } finally { setBusy(false); }
    }, [load, message]);

    const run = useCallback((ops: any[]) => call(() => api.post<Edit>(`/sequences/${seqId}/edit/ops`, { ops, expectedVersion: ver.current })), [call, seqId]);
    const undo = useCallback(() => call(() => api.post<Edit>(`/sequences/${seqId}/edit/undo`)), [call, seqId]);
    const redo = useCallback(() => call(() => api.post<Edit>(`/sequences/${seqId}/edit/redo`)), [call, seqId]);
    const conform = useCallback((reset: boolean) => call(() => api.post<Edit>(`/sequences/${seqId}/timeline/conform`, { reset })), [call, seqId]);
    return { edit, busy, load, run, undo, redo, conform };
}
