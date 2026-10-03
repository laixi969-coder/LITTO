import { useEffect } from "react";
import { App, Button, Select, Spin } from "antd";
import { Clapperboard, LogOut, Settings, Shield } from "lucide-react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useFilmflowStore } from "@/stores/use-filmflow-store";

/** FilmFlow shell: session guard + slim header. The upstream canvas stays reachable at /canvas. */
export default function StudioLayout() {
    const { ready, user, refresh, logout, workspaces, workspaceId, switchWorkspace, epoch } = useFilmflowStore();
    const loc = useLocation();
    const nav = useNavigate();
    const { message } = App.useApp();
    useEffect(() => void refresh(), [refresh]);
    if (!ready) return <div className="flex h-dvh items-center justify-center"><Spin /></div>;
    if (!user) return <Navigate to="/studio/login" state={{ from: loc.pathname }} replace />;
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <header className="flex h-11 shrink-0 items-center gap-4 border-b border-black/10 px-4 text-sm dark:border-white/10">
                <Link to="/studio" className="flex items-center gap-2 font-semibold"><Clapperboard size={16} /> FilmFlow</Link>
                <Link to="/studio" className="opacity-70 hover:opacity-100">项目</Link>
                <Link to="/canvas" className="opacity-70 hover:opacity-100">上游画布</Link>
                <div className="flex-1" />
                {workspaces.length > 0 && <Select size="small" variant="borderless" className="!w-44" value={workspaceId ?? undefined} onChange={(v) => { switchWorkspace(v); nav("/studio"); }} options={workspaces.map((w) => ({ value: w.id, label: `${w.kind === "team" ? "👥 " : ""}${w.name} · ${w.role}` }))} />}
                <span className="opacity-60">{user.email}</span>
                <Link to="/studio/settings" title="设置 / API Key / 积分"><Settings size={15} /></Link>
                {user.isAdmin && <Link to="/studio/admin" title="管理后台"><Shield size={15} /></Link>}
                <Button size="small" type="text" icon={<LogOut size={14} />} onClick={async () => { await logout(); message.success("已退出"); }} />
            </header>
            <main className="min-h-0 flex-1 overflow-hidden"><Outlet key={`${workspaceId}:${epoch}`} /></main>
        </div>
    );
}
