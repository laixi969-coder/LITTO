import { all, get, run, setting, tx } from "./db.ts";
import { available, charge, hold, release } from "./credits.ts";
import { credentialFor, secretOf } from "./providers/registry.ts";
import { HttpError, now, ulid } from "./util.ts";

/**
 * 平台试用（实验 1）：没有自带 Key 的新用户直接用平台文本模型写故事，按 token 从注册赠送的积分里扣。
 * 只开放管理员配置了平台凭据的 openai-compatible 文本模型；Key 只在服务端使用，不下发给前端。
 */
export const trialProviderId = "littoPlatform";

type TrialSetting = { enabled?: boolean; creditsPer1kTokens?: number };
const trialSetting = () => setting<TrialSetting>("platformTrial", { enabled: false });
const trialRunId = ulid();
// 回执写入失败时本进程也要停止继续调用；重启后由 run_id 不一致识别这类遗留预占。
const unconfirmedReservations = new Map<string, string>();

function trialModelRows() {
    if (!trialSetting().enabled) return [];
    return all(`SELECT m.*, p.base_url FROM models m JOIN providers p ON p.id=m.provider_id
        WHERE m.type='text' AND m.status='active' AND p.status='active' AND p.adapter='openai-compatible' AND p.base_url IS NOT NULL
        ORDER BY m.priority`).filter((m) => credentialFor(m.provider_id, null, null, true));
}

/** 当前工作区可用的试用模型和剩余积分；未开启或没有可用模型时 models 为空。 */
export function trialStatus(workspaceId: string) {
    recoverTrialCharges(workspaceId);
    const models = trialModelRows().map((m) => {
        const limits = JSON.parse(m.limits ?? "{}");
        return { id: m.external_model_id as string, label: m.name as string, contextWindow: limits.contextWindow as number | undefined, maxOutputTokens: limits.maxOutputTokens as number | undefined };
    });
    return { credits: models.length ? available(workspaceId) : 0, models };
}

/** 发起调用前取连接信息；积分用完直接拒绝，提示接入自己的模型。 */
export function trialModelAccess(workspaceId: string, modelId: string) {
    recoverTrialCharges(workspaceId);
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

/** 用量回执先持久化，再与积分账本原子结算；失败时保留预占，下次调用前重做，不能重复扣费。 */
function recoverTrialCharges(workspaceId: string) {
  try {
    tx(() => {
      for (const reservation of all("SELECT * FROM trial_reservations WHERE workspace_id=? AND status='pending'", workspaceId)) {
        const credits = Math.ceil(reservation.tokens / 1000 * reservation.rate);
        if (credits > reservation.held) throw new HttpError(409, "平台用量超过预占上限，请联系管理员核对", "trial_usage_unconfirmed");
        if (credits) charge(workspaceId, reservation.id, reservation.held, credits, null);
        else release(workspaceId, reservation.id, reservation.held, "platform trial request not sent or rejected");
        run("UPDATE trial_reservations SET status='settled', updated_at=? WHERE id=?", now(), reservation.id);
      }
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw Object.assign(new HttpError(503, "平台用量已记录，但积分结算暂未完成；预占额度已保留，请稍后重试", "trial_settlement_pending"), { cause: error });
  }
}

/** 每个实际模型请求独立预占；文本按输入上界加输出上限，媒体输入按整个上下文窗口预占。 */
export function reserveTrialTokens(workspaceId: string, modelId: string, inputTokens: number, outputTokens: number, contextWindow: number, hasMedia = false) {
  for (const value of [inputTokens, outputTokens, contextWindow]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, "平台模型的 token 预算无效", "trial_invalid_budget");
  }
  return tx(() => {
    trialModelAccess(workspaceId, modelId);
    for (const [id, owner] of unconfirmedReservations) {
      if (owner === workspaceId && get("SELECT status FROM trial_reservations WHERE id=?", id)?.status === "settled") unconfirmedReservations.delete(id);
    }
    if ([...unconfirmedReservations.values()].includes(workspaceId) || get("SELECT id FROM trial_reservations WHERE workspace_id=? AND (status='unknown' OR (status='reserved' AND run_id!=?)) LIMIT 1", workspaceId, trialRunId)) {
      throw new HttpError(409, "平台模型有尚未确认的用量，预占额度已保留，请联系管理员核对后继续", "trial_usage_unconfirmed");
    }
    const rate = trialSetting().creditsPer1kTokens ?? 1;
    if (!Number.isFinite(rate) || rate <= 0) throw new HttpError(400, "平台积分费率无效，请联系管理员", "trial_invalid_rate");
    const credits = Math.floor(available(workspaceId));
    const affordableTokens = Math.floor(credits / rate * 1000);
    const maxOutputTokens = Math.min(outputTokens, contextWindow - (hasMedia ? 1 : inputTokens), hasMedia ? outputTokens : affordableTokens - inputTokens);
    const maxTokens = hasMedia ? contextWindow : inputTokens + maxOutputTokens;
    const held = Math.ceil(maxTokens / 1000 * rate);
    if (maxOutputTokens < 1 || !Number.isSafeInteger(held) || held > credits) {
      throw new HttpError(402, "可用积分不足以覆盖本次输入和输出上限，请缩短上下文、等待其他调用结束或接入自己的模型", "trial_exhausted");
    }
    const id = ulid();
    hold(workspaceId, id, held);
    run("INSERT INTO trial_reservations VALUES(?,?,?,?,?,?,?,'reserved',NULL,?,?)", id, workspaceId, modelId, trialRunId, maxTokens, rate, held, now(), now());
    return { id, maxOutputTokens, maxTokens, held };
  });
}

/** null 表示断流、取消或缺失用量：不能证明未计费，保留预占等待可信回执，不自动退款或重发。 */
export function settleTrialTokens(workspaceId: string, id: string, tokens: number | null) {
  let outcome: string;
  try {
    outcome = tx(() => {
      const reservation = get("SELECT * FROM trial_reservations WHERE id=? AND workspace_id=?", id, workspaceId);
      if (!reservation) throw new HttpError(404, "平台用量预占记录不存在", "trial_reservation_missing");
      if (reservation.status === "settled" || reservation.status === "pending") return reservation.status;
      const valid = tokens !== null && Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= reservation.max_tokens;
      const status = valid ? "pending" : "unknown";
      run("UPDATE trial_reservations SET tokens=?, status=?, updated_at=? WHERE id=?", Number.isSafeInteger(tokens) ? tokens : null, status, now(), id);
      return status;
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    unconfirmedReservations.set(id, workspaceId);
    throw Object.assign(new HttpError(503, "平台用量回执暂未保存，预占额度已保留，请联系管理员核对后继续", "trial_usage_unconfirmed"), { cause: error });
  }
  unconfirmedReservations.delete(id);
  if (outcome === "unknown") throw new HttpError(409, "本次平台用量尚未确认，预占额度已保留，请联系管理员核对；未自动重发请求", "trial_usage_unconfirmed");
  if (outcome === "pending") recoverTrialCharges(workspaceId);
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
