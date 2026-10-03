import { create } from "zustand";

import { api, setWorkspace, WS_KEY } from "@/services/api/ovia";

export type FFUser = { id: string; email: string; isAdmin: boolean };
type FFStore = {
    ready: boolean;
    user: FFUser | null;
    workspaceId: string | null;
    role: string | null;
    workspaces: { id: string; name: string; kind: string; role: string }[];
    epoch: number; // bumps on workspace switch so pages can reload
    switchWorkspace: (id: string) => void;
    refresh: () => Promise<void>;
    logout: () => Promise<void>;
};

export const useOviaStore = create<FFStore>((set) => ({
    ready: false,
    user: null,
    workspaceId: null,
    role: null,
    workspaces: [],
    epoch: 0,
    switchWorkspace(id) {
        const w = useOviaStore.getState().workspaces.find((x) => x.id === id);
        if (!w) return;
        setWorkspace(id);
        try { sessionStorage.setItem(WS_KEY, id); } catch { /* private mode */ }
        set((s) => ({ workspaceId: id, role: w.role, epoch: s.epoch + 1 }));
    },
    async refresh() {
        try {
            let saved: string | null = null;
            try { saved = sessionStorage.getItem(WS_KEY); } catch { /* ignore */ }
            if (saved) setWorkspace(saved);
            let me;
            try { me = await api.get("/auth/me"); } catch (e: any) { if (!saved || e.status === 401) throw e; setWorkspace(null); sessionStorage.removeItem(WS_KEY); me = await api.get("/auth/me"); }
            // /auth/me reports the *requested* workspace; fall back to personal if the saved one vanished.
            setWorkspace(me.workspaceId);
            set({ ready: true, user: me.user, workspaceId: me.workspaceId, role: me.role, workspaces: me.workspaces });
        } catch {
            set({ ready: true, user: null, workspaceId: null, role: null, workspaces: [] });
        }
    },
    async logout() {
        await api.post("/auth/logout").catch(() => {});
        setWorkspace(null);
        try { sessionStorage.removeItem(WS_KEY); } catch { /* ignore */ }
        set({ user: null, workspaceId: null, role: null, workspaces: [] });
    },
}));
