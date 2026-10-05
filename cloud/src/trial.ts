import { all, get, setting } from "./db.ts";
import { available, chargeUsage } from "./credits.ts";
import { credentialFor, secretOf } from "./providers/registry.ts";
import { HttpError } from "./util.ts";

/**
 * 平台试用（实验 1）：没有自带 Key 的新用户直接用平台文本模型写故事，按 token 从注册赠送的积分里扣。
 * 只开放管理员配置了平台凭据的 openai-compatible 文本模型；Key 只在服务端使用，不下发给前端。
 */
export const trialProviderId = "littoPlatform";

type TrialSetting = { enabled?: boolean; creditsPer1kTokens?: number };
const trialSetting = () => setting<TrialSetting>("platformTrial", { enabled: false });

function trialModelRows() {
    if (!trialSetting().enabled) return [];
    return all(`SELECT m.*, p.base_url FROM models m JOIN providers p ON p.id=m.provider_id
        WHERE m.type='text' AND m.status='active' AND p.status='active' AND p.adapter='openai-compatible' AND p.base_url IS NOT NULL
        ORDER BY m.priority`).filter((m) => credentialFor(m.provider_id, null, null, true));
}

/** 当前工作区可用的试用模型和剩余积分；未开启或没有可用模型时 models 为空。 */
export function trialStatus(workspaceId: string) {
    const models = trialModelRows().map((m) => {
        const limits = JSON.parse(m.limits ?? "{}");
        return { id: m.external_model_id as string, label: m.name as string, contextWindow: limits.contextWindow as number | undefined, maxOutputTokens: limits.maxOutputTokens as number | undefined };
    });
    return { credits: models.length ? available(workspaceId) : 0, models };
}

/** 发起调用前取连接信息；积分用完直接拒绝，提示接入自己的模型。 */
export function trialModelAccess(workspaceId: string, modelId: string) {
    // 助手运行时把模型 id 原样当作上游模型名发送，所以对外用 external_model_id。
    // ACT: 多个平台供应商配置了同名模型时取优先级最高的一个。
    const m = trialModelRows().find((row) => row.external_model_id === modelId);
    if (!m) throw new HttpError(400, "平台试用模型已下线，请重新选择模型", "trial_unavailable");
    if (available(workspaceId) <= 0) throw new HttpError(402, "试用额度已用完，请在设置中接入自己的模型继续创作", "trial_exhausted");
    const credential = credentialFor(m.provider_id, null, null, true)!;
    const limits = JSON.parse(m.limits ?? "{}");
    return { baseUrl: m.base_url as string, apiKey: secretOf(credential), label: m.name as string,
        contextWindow: limits.contextWindow as number | undefined, maxOutputTokens: limits.maxOutputTokens as number | undefined };
}

/** 回复结束后才知道用量，无法预扣；按实际 token 扣费，最后一次允许略微透支，下一次调用前会被拦下。 */
export function chargeTrialTokens(workspaceId: string, modelId: string, tokens: number) {
    if (tokens <= 0) return;
    const credits = Math.ceil(tokens / 1000 * (trialSetting().creditsPer1kTokens ?? 1));
    chargeUsage(workspaceId, credits, `platform trial ${modelId} ${tokens} tokens`);
}

/**
 * 实验读数：时间段内注册的用户，从注册到首次成功拿到文本回复用了多久，按首次回复走的是平台试用还是自带 Key 分组。
 * ACT: 以"首次成功的文本回复"近似"拿到第一个故事"；要精确到故事技能，需要在会话里记录所用技能。
 */
export function trialReport(since: string, until: string) {
    // 管理员账号不计入，避免运营自测污染实验数据。
    const users = all("SELECT id, created_at FROM users WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND is_admin=0", since, until);
    const minutes: number[] = [];
    let within10 = 0;
    let within24h = 0;
    const firstVia = { trial: 0, ownKey: 0 };
    for (const user of users) {
        const first = get("SELECT provider_id, created_at FROM usage_events WHERE user_id=? AND kind='text' AND status='ok' ORDER BY created_at LIMIT 1", user.id);
        if (!first) continue;
        const elapsed = (Date.parse(first.created_at) - Date.parse(user.created_at)) / 60_000;
        minutes.push(elapsed);
        if (elapsed <= 10) within10++;
        if (elapsed <= 1440) within24h++;
        firstVia[first.provider_id === trialProviderId ? "trial" : "ownKey"]++;
    }
    minutes.sort((a, b) => a - b);
    const rate = (n: number) => (users.length ? Math.round(n / users.length * 1000) / 10 : null);
    return {
        since, until, trialEnabled: !!trialSetting().enabled, signups: users.length,
        firstReplyWithin10Min: within10, rateWithin10Min: rate(within10),
        firstReplyWithin24h: within24h, rateWithin24h: rate(within24h),
        medianMinutesToFirstReply: minutes.length ? Math.round(minutes[Math.floor(minutes.length / 2)] * 10) / 10 : null,
        firstReplyVia: firstVia,
    };
}
