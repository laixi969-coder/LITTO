import { useEffect, useState } from "react";
import { App, Button, Input } from "antd";
import { Clapperboard } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { OVIA_BASE, api } from "@/services/api/ovia";
import { useOviaStore } from "@/stores/use-ovia-store";

export default function LoginPage() {
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const { message } = App.useApp();
    const nav = useNavigate();
    const from = (useLocation().state as any)?.from ?? "/studio";
    const refresh = useOviaStore((s) => s.refresh);
    const [oauth, setOauth] = useState<string[]>([]);
    useEffect(() => void api.get("/auth/oauth/providers").then(setOauth).catch(() => {}), []);
    // Enterprise SSO: if the email's domain belongs to an OIDC connection, offer single sign-on (and hide OTP when enforced).
    const [sso, setSso] = useState<{ id: string; name: string; enforce: boolean } | null>(null);
    useEffect(() => {
        setSso(null);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
        const t = setTimeout(() => void api.get(`/auth/sso/lookup?email=${encodeURIComponent(email)}`).then(setSso).catch(() => setSso(null)), 300);
        return () => clearTimeout(t);
    }, [email]);

    const send = async () => {
        setBusy(true);
        try {
            const r = await api.post("/auth/request-code", { email });
            setSent(true);
            // Outside production the server echoes the code (no SMTP configured) — prefill it so local use is frictionless.
            if (r.devCode) { setCode(r.devCode); message.info(`开发模式验证码：${r.devCode}`); } else message.success("验证码已发送");
        } catch (e: any) { message.error(e.message); }
        setBusy(false);
    };
    const verify = async () => {
        setBusy(true);
        try { await api.post("/auth/verify", { email, code, client: "web" }); await refresh(); nav(from, { replace: true }); }
        catch (e: any) { message.error(e.message); }
        setBusy(false);
    };
    return (
        <div className="flex h-dvh items-center justify-center bg-background">
            <div className="w-[360px] space-y-4">
                <div className="flex items-center gap-2 text-2xl font-semibold"><Clapperboard /> OVIA <span className="text-base font-normal opacity-60">有戏</span></div>
                <p className="text-sm opacity-60">让几十个 AI 镜头真正属于同一部影片。邮箱验证码登录，自动创建你的个人工作区。</p>
                <Input size="large" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} onPressEnter={send} disabled={sent} />
                {sso && <Button type="primary" size="large" block href={`${OVIA_BASE}/auth/sso/${sso.id}/start`}>使用 {sso.name} 单点登录</Button>}
                {sso?.enforce && <div className="text-xs opacity-60">该邮箱域名已启用强制单点登录，不能使用验证码或第三方登录。</div>}
                {sent && !sso?.enforce && <Input size="large" placeholder="6 位验证码" value={code} onChange={(e) => setCode(e.target.value)} onPressEnter={verify} autoFocus maxLength={6} />}
                {sso?.enforce ? null : sent ? <div className="flex gap-2"><Button type="primary" size="large" block loading={busy} onClick={verify}>登录</Button><Button size="large" onClick={() => setSent(false)}>换邮箱</Button></div>
                    : <Button type="primary" size="large" block loading={busy} onClick={send} disabled={!email.includes("@")}>获取验证码</Button>}
                {oauth.length > 0 && !sso?.enforce && <div className="space-y-2 pt-2"><div className="text-center text-xs opacity-50">或使用</div>{oauth.map((p) => <Button key={p} block size="large" href={`${OVIA_BASE}/auth/oauth/${p}/start`}>{({ github: "GitHub", google: "Google", apple: "Apple" } as Record<string, string>)[p] ?? p} 登录</Button>)}</div>}
            </div>
        </div>
    );
}
