import conf from "@/utils/conf";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";

/** 一次计划中的生成：算钱只需要时长、分辨率与执行器。 */
export interface SpendShot {
  providerId: string;
  modelId: string;
  duration: number;
  resolution?: string;
}

export interface SpendEstimate {
  clips: number;
  seconds: number;
  /** 按执行器拆开，便于看出钱主要花在哪个模型上 */
  byModel: { key: string; clips: number; seconds: number }[];
  /** 参考积分；只有配置了单价才给，否则为 null */
  credits: number | null;
  /** 参考金额；只有配置了积分→金额汇率才给 */
  money: number | null;
  /** 单价来源说明，避免把反推值当成官方报价 */
  basis: string;
}

const DEFAULT_CREDITS_PER_SECOND: Record<string, number> = {
  // 由 2026-10-19 的实际消耗反推（10000 积分 / 1123 秒），只作参考，随时可被设置覆盖
  "meta/MiniMax-H3": 8.9,
};

function pricingTable(): { perSecond: Record<string, number>; creditsPerYuan: number | null } {
  const settings = conf.get("settings", {}) as { mediaPricing?: { perSecond?: Record<string, number>; creditsPerYuan?: number } };
  const custom = settings.mediaPricing?.perSecond ?? {};
  return {
    perSecond: { ...DEFAULT_CREDITS_PER_SECOND, ...custom },
    creditsPerYuan: typeof settings.mediaPricing?.creditsPerYuan === "number" ? settings.mediaPricing.creditsPerYuan : null,
  };
}

/** 分辨率系数：2K 的像素量是 768P 的约 2.5 倍，模型侧通常按档位计价，这里只做保守折算。 */
function resolutionFactor(resolution?: string) {
  const value = String(resolution ?? "").toUpperCase();
  if (value.includes("4K")) return 3;
  if (value.startsWith("2K") || value.includes("1440")) return 2;
  if (value.includes("1080")) return 1.5;
  if (value.includes("768")) return 1;
  if (value.includes("720")) return 1;
  if (value.includes("480") || value.includes("540")) return 0.6;
  return 1;
}

export function estimateSpend(shots: SpendShot[]): SpendEstimate {
  const { perSecond, creditsPerYuan } = pricingTable();
  const grouped = new Map<string, { clips: number; seconds: number }>();
  let seconds = 0;
  for (const shot of shots) {
    const duration = Number(shot.duration);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    seconds += duration;
    const key = `${shot.providerId}/${shot.modelId}`;
    const entry = grouped.get(key) ?? { clips: 0, seconds: 0 };
    entry.clips += 1;
    entry.seconds += duration;
    grouped.set(key, entry);
  }
  const byModel = [...grouped.entries()].map(([key, value]) => ({ key, ...value }));
  let credits: number | null = null;
  let basis = "未配置单价，只给秒数";
  if (perSecond && Object.keys(perSecond).length) {
    let total = 0;
    let priced = 0;
    for (const shot of shots) {
      const rate = perSecond[`${shot.providerId}/${shot.modelId}`];
      if (!rate) continue;
      total += Number(shot.duration) * rate * resolutionFactor(shot.resolution);
      priced += 1;
    }
    credits = priced ? Math.round(total) : null;
    basis = priced === shots.length
      ? `按 ${Object.entries(perSecond).map(([key, value]) => `${key} ${value} 积分/秒`).join("、")} 估算，2K×2 / 1080P×1.5 / 720P×1`
      : `只有 ${priced}/${shots.length} 条命中单价，其余按 0 计，实际会更高`;
  }
  const money = credits !== null && creditsPerYuan ? Number((credits / creditsPerYuan).toFixed(2)) : null;
  return { clips: shots.length, seconds: Math.round(seconds), byModel, credits, money, basis };
}

/** 今日已消耗：按工作区汇总成功任务的视频秒数，用来回答「这个项目今天已经烧了多少」。 */
export async function dailySpend(directory?: string) {
  const tenant = currentTenant();
  const api = cloud();
  if (!tenant || !api) return null;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = directory
    ? api.dbAll(
      "SELECT status, parameters FROM generation_jobs WHERE workspace_id=? AND kind='video' AND created_at>=? AND json_extract(parameters,'$.directory')=?",
      tenant.workspaceId, since, directory,
    )
    : api.dbAll(
      "SELECT status, parameters FROM generation_jobs WHERE workspace_id=? AND kind='video' AND created_at>=?",
      tenant.workspaceId, since,
    );
  const { perSecond } = pricingTable();
  let seconds = 0;
  let credits = 0;
  let calls = 0;
  let failed = 0;
  for (const row of rows as { status: string; parameters?: string }[]) {
    calls += 1;
    if (row.status !== "SUCCEEDED") { failed += 1; continue; }
    let request: { duration?: number; resolution?: string; providerId?: string; modelId?: string } = {};
    try {
      request = (JSON.parse(row.parameters ?? "{}").request ?? {}) as typeof request;
    } catch { continue; }
    const duration = Number(request.duration ?? 0);
    seconds += duration;
    const rate = perSecond[`${request.providerId}/${request.modelId}`];
    if (rate) credits += duration * rate * resolutionFactor(request.resolution);
  }
  return { calls, failed, seconds: Math.round(seconds), credits: Math.round(credits), windowHours: 24 };
}
