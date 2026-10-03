import { create } from "zustand";

type Mode = "simple" | "pro";
const KEY = "ovia:ui-mode";
const read = (): Mode => { try { return localStorage.getItem(KEY) === "pro" ? "pro" : "simple"; } catch { return "simple"; } };

/** Simple is the default: professional parameters stay collapsed. A tiny per-viewer preference, so localStorage is fine. */
export const useUiMode = create<{ mode: Mode; pro: boolean; setMode: (m: Mode) => void }>((set) => ({
    mode: read(), pro: read() === "pro",
    setMode: (mode) => { try { localStorage.setItem(KEY, mode); } catch { /* ignore */ } set({ mode, pro: mode === "pro" }); },
}));
