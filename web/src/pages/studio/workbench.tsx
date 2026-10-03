import { useEffect } from "react";
import { App, Result, Spin } from "antd";
import { useParams } from "react-router-dom";

import { DirectorBar } from "./workbench/director-bar";
import { DomainCanvas } from "./workbench/domain-canvas";
import { Inspector } from "./workbench/inspector";
import { LeftPanel } from "./workbench/left-panel";
import { ShotStrip } from "./workbench/shot-strip";
import { useWorkbench } from "./workbench/use-workbench";

/** Production workbench: left Project/Assets/Sequences/References · center domain canvas · right Inspector · bottom Shot Strip · top Director Command. */
export default function Workbench() {
    const { pid = "" } = useParams();
    const { message } = App.useApp();
    const wb = useWorkbench();
    useEffect(() => void wb.open(pid).catch((e) => message.error(e.message)), [pid]);
    // keep job state fresh while anything is generating (survives refresh: state lives on the server)
    useEffect(() => {
        if (!wb.jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING")) return;
        const t = setInterval(() => void wb.reload(), 2000);
        return () => clearInterval(t);
    }, [wb.jobs]);
    if (wb.pid !== pid || !wb.project) return <div className="flex h-full items-center justify-center"><Spin /></div>;
    if (wb.project.deletedAt) return <Result status="warning" title="项目在回收站" />;
    return (
        <div className="flex h-full flex-col">
            <DirectorBar />
            <div className="flex min-h-0 flex-1">
                <aside className="w-[260px] shrink-0 overflow-auto border-r border-black/10 dark:border-white/10"><LeftPanel /></aside>
                <section className="min-w-0 flex-1"><DomainCanvas /></section>
                <aside className="w-[400px] shrink-0 overflow-auto border-l border-black/10 dark:border-white/10"><Inspector /></aside>
            </div>
            <ShotStrip />
        </div>
    );
}
