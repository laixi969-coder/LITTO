import { useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { NeedLogin } from "./api";

export const CHANGED = "filmflow:changed";
export type Ctx = CanvasNodeContext;
export const meta = (ctx: Ctx) => (ctx.node.metadata ?? {}) as { ffProjectId?: string; ffKind?: string; ffId?: string };
export const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export const KIND_COLOR: Record<string, string> = { world: "#0ea5e9", look: "#a855f7", Character: "#f97316", Wardrobe: "#ec4899", Environment: "#22c55e", Prop: "#eab308", Product: "#eab308", Vehicle: "#eab308", Creature: "#f97316", Custom: "#64748b", shot: "#6366f1", project: "#111827" };

/** Load a domain entity; refetch when any FilmFlow node mutates something (shared canvas event) and while `poll` is true. */
export function useLive<T>(ctx: Ctx, load: () => Promise<T>, deps: unknown[], poll?: (v: T) => boolean) {
    const [data, setData] = useState<T | null>(null);
    const [err, setErr] = useState<Error | null>(null);
    const loadRef = useRef(load);
    loadRef.current = load;
    const reload = useCallback(async () => {
        try { const v = await loadRef.current(); setData(v); setErr(null); return v; } catch (e) { setErr(e as Error); return null; }
    }, []);
    useEffect(() => { void reload(); }, [...deps, reload]);
    useEffect(() => ctx.on(CHANGED, () => void reload()), [reload]);
    useEffect(() => {
        if (!data || !poll?.(data)) return;
        const t = setInterval(() => void reload(), 1500);
        return () => clearInterval(t);
    }, [data, reload]);
    return { data, err, reload, changed: () => ctx.emit(CHANGED) };
}

export function Card({ ctx, color, title, sub, right, children, badge }: { ctx: Ctx; color: string; title: string; sub?: string; right?: any; children?: any; badge?: any }) {
    const t = ctx.theme;
    return (
        <div style={{ position: "relative", height: "100%", width: "100%", boxSizing: "border-box", overflow: "hidden", display: "flex", color: t.node.text }}>
            <div style={{ width: 5, background: color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, fontWeight: 600 }}><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>{badge}</div>
                {sub && <div style={{ fontSize: 11, opacity: 0.65, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{sub}</div>}
                {children}
            </div>
            {right}
        </div>
    );
}

export function Problem({ ctx, err }: { ctx: Ctx; err: Error }) {
    const login = err instanceof NeedLogin;
    return (
        <div data-canvas-no-zoom onMouseDown={stop} style={{ padding: 10, fontSize: 12, color: ctx.theme.node.text }}>
            {login ? <>请先登录 FilmFlow：<a href="/studio/login" target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>打开登录页</a></> : (err as any).status === 404 ? "该领域对象已被删除（画布节点仍在，可手动删除）" : `加载失败：${err.message}`}
        </div>
    );
}

export const btn = (ctx: Ctx, primary = false) => ({ padding: "3px 10px", borderRadius: 7, border: `1px solid ${ctx.theme.node.stroke}`, background: primary ? "#6366f1" : ctx.theme.toolbar.panel, color: primary ? "#fff" : ctx.theme.node.text, cursor: "pointer", fontSize: 12 }) as const;
export const input = (ctx: Ctx) => ({ width: "100%", boxSizing: "border-box", padding: "4px 6px", borderRadius: 6, border: `1px solid ${ctx.theme.node.stroke}`, background: "transparent", color: ctx.theme.node.text, fontSize: 12, outline: "none" }) as const;
export const panelBox = (ctx: Ctx) => ({ width: 420, maxHeight: 560, overflow: "auto", boxSizing: "border-box", padding: 12, borderRadius: 12, border: `1px solid ${ctx.theme.node.stroke}`, background: ctx.theme.toolbar.panel, color: ctx.theme.node.text, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }) as const;
