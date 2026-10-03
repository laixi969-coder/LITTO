import { useCallback, useEffect, useRef, useState } from "react";
import { App, Tag } from "antd";

export const bytes = (n = 0) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
export const time = (s?: string | null) => (s ? new Date(s).toLocaleString() : "-");
export const CAPS = ["text2image", "imageEdit", "identityReference", "multiReference", "compositionReference", "text2video", "image2video", "startEndFrame", "motionReference", "cameraControl", "nativeAudio"];
export const STATUS_COLOR: Record<string, string> = { QUEUED: "default", RUNNING: "processing", SUCCEEDED: "success", FAILED: "error", TIMEOUT: "warning", CANCELLED: "default" };
export const StatusTag = ({ s }: { s: string }) => <Tag color={STATUS_COLOR[s]}>{s}</Tag>;

/** Load data with error toast; optional polling while `poll(data)` is true. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], poll?: (d: T) => boolean) {
    const { message } = App.useApp();
    const [data, setData] = useState<T>();
    const [loading, setLoading] = useState(false);
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const reload = useCallback(async () => {
        setLoading(true);
        try { setData(await fnRef.current()); } catch (e: any) { message.error(e.message); }
        setLoading(false);
    }, [message]);
    useEffect(() => void reload(), [reload, ...deps]);
    useEffect(() => {
        if (!poll || !data || !poll(data)) return;
        const t = setInterval(() => void reload(), 3000);
        return () => clearInterval(t);
    }, [data, poll, reload]);
    return { data, loading, reload };
}

export function useAct(reload: () => unknown) {
    const { message } = App.useApp();
    return (fn: () => Promise<any>, ok?: string) => async () => {
        try { await fn(); ok && message.success(ok); await reload(); } catch (e: any) { message.error(e.message); }
    };
}
