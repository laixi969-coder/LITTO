import { App, Input } from "antd";

/** Promise-based text prompt on top of antd modal (avoids blocking window.prompt). */
export function useAsk() {
    const { modal } = App.useApp();
    return (title: string, placeholder = "") =>
        new Promise<string | null>((resolve) => {
            let value = "";
            modal.confirm({ title, content: <Input autoFocus placeholder={placeholder} onChange={(e) => (value = e.target.value)} />, onOk: () => resolve(value.trim() || null), onCancel: () => resolve(null) });
        });
}
