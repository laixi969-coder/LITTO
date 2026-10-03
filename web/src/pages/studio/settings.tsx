import { Tabs } from "antd";

import Billing from "./settings/billing";
import Credentials from "./settings/credentials";
import Credits from "./settings/credits";
import Generations from "./settings/generations";
import Policy from "./settings/policy";
import Team from "./settings/team";
import Workspace from "./settings/workspace";

export default function SettingsPage() {
    const items = [["workspace", "工作区", Workspace], ["policy", "模型策略", Policy], ["keys", "API Key", Credentials], ["credits", "积分", Credits], ["billing", "订阅与充值", Billing], ["team", "团队", Team], ["jobs", "生成记录", Generations]] as const;
    return (
        <div className="h-full overflow-auto p-6">
            <Tabs destroyOnHidden items={items.map(([key, label, C]) => ({ key, label, children: <C /> }))} />
        </div>
    );
}
