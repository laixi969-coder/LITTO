import { create } from "zustand";

import { api } from "@/services/api/filmflow";

export type Presence = { userId: string; email: string; color: string; shotId: string | null; assetId: string | null; at: number };
export type Sel = { kind: "world" | "look" | "asset" | "shot" | "reference"; id: string } | null;

type WB = {
    pid: string;
    project: any;
    world: any;
    look: any;
    assets: any[];
    refs: any[];
    sequences: any[];
    shots: any[];
    strip: any[];
    jobs: any[];
    canvas: { nodes: any[]; edges: any[]; viewport: { x: number; y: number; k: number } };
    sel: Sel;
    view: "canvas" | "grid" | "assembly";
    setView: (v: "canvas" | "grid" | "assembly") => void;
    looks: any[];
    presence: Presence[]; // other collaborators (self excluded), pushed by the server
    setPresence: (p: Presence[]) => void;
    multi: string[]; // multi-selected shot ids (marquee batch)
    activeSeq: string | null;
    open: (pid: string) => Promise<void>;
    reload: () => Promise<void>;
    select: (s: Sel) => void;
    setMulti: (ids: string[]) => void;
    setActiveSeq: (id: string | null) => void;
    saveCanvas: (c: WB["canvas"]) => void;
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useWorkbench = create<WB>((set, get) => ({
    pid: "", project: null, world: null, look: null, assets: [], refs: [], sequences: [], shots: [], strip: [], jobs: [],
    canvas: { nodes: [], edges: [], viewport: { x: 40, y: 40, k: 1 } }, sel: null, view: "canvas", looks: [], presence: [], setPresence: (presence) => set({ presence }), setView: (view) => set({ view }), multi: [], activeSeq: null,
    async open(pid) {
        set({ pid, sel: null, multi: [], activeSeq: null });
        await get().reload();
    },
    async reload() {
        const pid = get().pid;
        if (!pid) return;
        const [project, world, looks, assets, refs, sequences, shots, strip, jobs, canvas] = await Promise.all([
            api.get(`/projects/${pid}`), api.get(`/projects/${pid}/world`), api.get(`/projects/${pid}/looks`), api.get(`/projects/${pid}/assets`),
            api.get(`/projects/${pid}/references`), api.get(`/projects/${pid}/sequences`), api.get(`/projects/${pid}/shots`), api.get(`/projects/${pid}/shot-strip`),
            api.get(`/generations?projectId=${pid}`), api.get(`/projects/${pid}/canvas`),
        ]);
        set((s) => ({ looks, project, world, look: looks.find((l: any) => l.scope === "project"), assets, refs, sequences, shots, strip, jobs, canvas: { ...canvas, viewport: s.canvas.viewport.k !== 1 || s.canvas.nodes.length ? s.canvas.viewport : canvas.viewport }, activeSeq: s.activeSeq ?? sequences[0]?.id ?? null }));
    },
    select: (sel) => set({ sel }),
    setMulti: (multi) => set({ multi }),
    setActiveSeq: (activeSeq) => set({ activeSeq }),
    saveCanvas(canvas) {
        set({ canvas });
        clearTimeout(saveTimer);
        const pid = get().pid;
        saveTimer = setTimeout(() => void api.put(`/projects/${pid}/canvas`, { schemaVersion: 1, ...canvas }).catch(() => {}), 600);
    },
}));
