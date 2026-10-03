import { create } from "zustand";

import { api, setWorkspace } from "@/services/api/filmflow";

export type FFUser = { id: string; email: string; isAdmin: boolean };
type FFStore = {
    ready: boolean;
    user: FFUser | null;
    workspaceId: string | null;
    role: string | null;
    refresh: () => Promise<void>;
    logout: () => Promise<void>;
};

export const useFilmflowStore = create<FFStore>((set) => ({
    ready: false,
    user: null,
    workspaceId: null,
    role: null,
    async refresh() {
        try {
            const me = await api.get("/auth/me");
            setWorkspace(me.workspaceId);
            set({ ready: true, user: me.user, workspaceId: me.workspaceId, role: me.role });
        } catch {
            set({ ready: true, user: null, workspaceId: null, role: null });
        }
    },
    async logout() {
        await api.post("/auth/logout").catch(() => {});
        setWorkspace(null);
        set({ user: null, workspaceId: null, role: null });
    },
}));
