import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";

const RULES = [
  { key: "PHOTOGRAPHICBASELINE", label: "写实基底", why: "缺它就回到磨皮与塑料质感" },
  { key: "SHOTSPEC", label: "镜头规格", why: "缺它模型自己猜景别与运镜" },
  { key: "CAST:", label: "角色档案", why: "缺它人物镜每镜重新选角" },
  { key: "LOOK: 影调参照", label: "项目影调", why: "缺它各镜各写各的色，全片会散" },
  { key: "STYLEONLY", label: "影调参考", why: "缺它参考图会连人物和场景一起搬进来" },
];

/**
 * 规则覆盖率：不看文档写得多好，看实际生成里有多少次真的执行了。
 * 直接读 generation_jobs 的 compiled_prompt 标记反推，不额外埋点，也不依赖调用方自报。
 */
export function ruleUsage(limit = 100) {
  const api = cloud();
  const tenant = currentTenant();
  if (!api || !tenant) return { window: 0, rules: [], gaps: [], note: "当前没有云端会话，无法统计" };
  const all = api.scoped(tenant.workspaceId).list("generation_jobs", {}, "created_at DESC") as {
    id: string;
    kind: string;
    status: string;
    compiled_prompt?: string;
    parameters?: { request?: Record<string, unknown> };
  }[];
  // 部分视图会裁掉长文本字段，compiled_prompt 缺失时退回用 parameters 的原始 JSON 判断标记。
  const jobs = all.filter(job => job.kind === "video").slice(0, limit);
  const total = jobs.length;
  if (!total) return { window: 0, rules: [], gaps: [], note: "还没有视频生成记录" };

  const rules = RULES.map(rule => {
    const hits = jobs.filter(job => {
      const text = job.compiled_prompt ?? JSON.stringify(job.parameters ?? {});
      return String(text).includes(rule.key);
    }).length;
    return { key: rule.key, label: rule.label, why: rule.why, hits, total, rate: Math.round((hits / total) * 100) };
  });

  // 参考图与时长不是文本标记，按请求字段统计。
  const withReference = jobs.filter(job => {
    const request = job.parameters?.request ?? {};
    return Boolean((Array.isArray(request.images) && request.images.length) || request.firstFrame || request.lastFrame);
  }).length;
  const withDuration = jobs.filter(job => typeof job.parameters?.request?.duration === "number").length;
  rules.push({ key: "reference", label: "身份参考图", why: "缺它跨镜必然换脸", hits: withReference, total, rate: Math.round((withReference / total) * 100) });
  rules.push({ key: "duration", label: "显式时长", why: "缺它落到供应商默认的最短档", hits: withDuration, total, rate: Math.round((withDuration / total) * 100) });

  const gaps = rules.filter(rule => rule.rate < 60).map(rule => `${rule.label} ${rule.rate}%：${rule.why}`);
  return {
    window: total,
    rules,
    gaps,
    note: gaps.length ? "规则没有真正被执行，不是文档没写" : "各条规则覆盖率正常",
  };
}
