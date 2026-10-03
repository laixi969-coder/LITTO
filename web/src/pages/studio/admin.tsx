import { Result, Tabs } from "antd";

import { useFilmflowStore } from "@/stores/use-filmflow-store";
import Billing from "./admin/billing";
import Audit from "./admin/audit";
import Dashboard from "./admin/dashboard";
import Jobs from "./admin/jobs";
import Ledger from "./admin/ledger";
import Models from "./admin/models";
import Providers from "./admin/providers";
import Storage from "./admin/storage";
import System from "./admin/system";
import Users from "./admin/users";

export default function AdminPage() {
    const user = useFilmflowStore((s) => s.user);
    if (!user?.isAdmin) return <Result status="403" title="403" subTitle="仅超级管理员可访问" />;
    const items = [["dashboard", "总览", Dashboard], ["users", "用户", Users], ["providers", "Provider", Providers], ["models", "模型", Models], ["jobs", "任务", Jobs], ["ledger", "积分流水", Ledger], ["billing", "订阅与支付", Billing], ["storage", "存储", Storage], ["system", "系统", System], ["audit", "审计", Audit]] as const;
    return (
        <div className="h-full overflow-auto p-6">
            <Tabs destroyOnHidden items={items.map(([key, label, C]) => ({ key, label, children: <C /> }))} />
        </div>
    );
}
