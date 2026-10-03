import { Tabs } from "antd";

import Credentials from "./settings/credentials";
import Credits from "./settings/credits";
import Generations from "./settings/generations";
import Policy from "./settings/policy";
import Workspace from "./settings/workspace";

export default function SettingsPage() {
    const items = [["workspace", "工作区", Workspace], ["policy", "模型策略", Policy], ["keys", "API Key", Credentials], ["credits", "积分", Credits], ["jobs", "生成记录", Generations]] as const;
    return (
        <div className="h-full overflow-auto p-6">
            <Tabs destroyOnHidden items={items.map(([key, label, C]) => ({ key, label, children: <C /> }))} />
        </div>
    );
}
