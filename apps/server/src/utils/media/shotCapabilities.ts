import type { MediaModel, MultiShotCapability } from "@toonflow/tools-scaffold/runtime";

type ReviewedCapability = {
  providerId: string;
  modelId: string;
  providerVersion: string;
  implementationRevision: string;
  endpoints?: string[];
  modes: (string | string[])[];
  state: "supported" | "unsupported";
  sources: MultiShotCapability["sources"];
  reason: string;
};

// ACT: 能力只由代码审阅后的精确记录放行，不从模型标签、同系列名称或助手提交的说明推断。
// 新版本、不同中转、实现变更须重新核对；不把这些记录自动继承给兼容接口。
const reviewedCapabilities: ReviewedCapability[] = [
  {
    providerId: "vidu", modelId: "viduq4-preview", providerVersion: "1.1.6",
    implementationRevision: "4b20b366783c6656a66848b39d7db3b170330c7a02f342ef18977dabc36dda0f",
    endpoints: ["https://api.vidu.cn"], modes: ["singleImage"], state: "supported",
    sources: [{ url: "https://platform.vidu.cn/docs/api-reference/video-models/vidu-q4-preview/image-to-video", summary: "该版本图生视频接口明确支持自动切镜，输入单张首帧，提示词通过 prompt 传入。" }],
    reason: "官方图生视频接口支持自动切镜；不保证精确切点或逐镜成功率。",
  },
  {
    providerId: "volcengine", modelId: "doubao-seedance-2-5-260628", providerVersion: "1.3.0",
    implementationRevision: "35a1d3ec1b3477901ebf7d3d4d40e4af0d04570ca73f00b782633e4b8ad3f72e",
    endpoints: ["https://ark.cn-beijing.volces.com/api/v3"],
    modes: ["text", "singleImage", "endFrameOptional", ["imageReference:30"], ["imageReference:30", "audioReference:10"], ["audioReference:10"]],
    state: "supported",
    sources: [{ url: "https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh", summary: "教程列出此精确模型ID、文本/首帧/首尾帧/全模态参考任务，提示词规则明确包括运镜与切镜。当前适配器保留文本及图片/音频参考；不涵盖视频编辑与延长。" }],
    reason: "当前适配模式可用提示词描述内部切镜；不是逐镜时间戳的硬控制或成功率承诺。",
  },
  {
    providerId: "gen3c", modelId: "gen3c", providerVersion: "1.0.0",
    implementationRevision: "7501a88c2bfa30e88bf8a0ad2e77de25dda97399c0746c5074e44eb777a936b1",
    modes: ["singleImage"], state: "unsupported",
    sources: [{ url: "repository:packages/providers/src/media/gen3c.ts", summary: "已核对当前适配器只提交首帧及连续数值相机轨迹，不执行逐请求文本切镜指令。" }],
    reason: "当前适配器为单镜头相机轨迹生成，未接入内部切镜。",
  },
];

const researchUrls: Record<string, string[]> = {
  vidu: ["https://platform.vidu.cn/docs/api-reference/video-models/vidu-q4-preview/reference-to-video"],
  volcengine: ["https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh", "https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh"],
};

export function readMultiShotCapabilities(provider: { id: string; version?: string; implementationRevision?: string }, model: { id: string; mode?: unknown }, baseUrl: unknown): MultiShotCapability[] {
  const modes = Array.isArray(model.mode) ? model.mode : [];
  return modes.filter((mode): mode is string | string[] => typeof mode === "string" || Array.isArray(mode) && mode.every(value => typeof value === "string")).map(mode => {
    const entry = reviewedCapabilities.find(item => item.providerId === provider.id && item.modelId === model.id && item.modes.some(value => JSON.stringify(value) === JSON.stringify(mode)));
    const endpoint = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
    // Vidu 的适配器对空地址回退官方地址；方舟则要求显式配置地址。
    const actualEndpoint = endpoint || (provider.id === "vidu" ? "https://api.vidu.cn" : "");
    const verified = entry && entry.providerVersion === provider.version && entry.implementationRevision === provider.implementationRevision
      && (!entry.endpoints || entry.endpoints.includes(actualEndpoint));
    const identity = { providerId: provider.id, modelId: model.id, mode, providerVersion: provider.version, implementationRevision: provider.implementationRevision };
    if (verified) return { ...identity, state: entry.state, control: entry.state === "supported" ? "prompt" : "none", reviewedAt: "2026-10-30", sources: entry.sources, reason: entry.reason };
    return { ...identity, state: "unknown", control: "unknown", sources: [],
      reason: entry ? "供应商实现、版本或实际API地址与已核验记录不一致，不能继承原能力" : "此供应商、精确模型版本及模式没有已核验的内部切镜记录",
      research: { query: `${provider.id} ${model.id} ${JSON.stringify(mode)} official API multi-shot camera cuts`,
        urls: [...new Set([...(entry?.sources.filter(source => source.url.startsWith("https://")).map(source => source.url) ?? []), ...(researchUrls[provider.id] ?? [])])],
        instruction: "先用 webFetch/webSearch 阅读实际供应商官方接口资料，核对精确模型版本、模式和当前适配器是否传递所需参数；证据经代码审阅写入能力表后重规划。查不到或无法访问时保持未知与原合段方案，不拆短、不试生成、不以助手说明或搜索摘要放行。" } };
  });
}

export function selectedMultiShotCapability(model: MediaModel, mode: unknown) {
  return model.multiShotCapabilities?.find(item => item.providerId === model.providerId && item.modelId === model.modelId && JSON.stringify(item.mode) === JSON.stringify(mode));
}

export function assertMultiShotCapability(model: MediaModel, mode: unknown, timeline: { transition?: string }[] | undefined) {
  if (!timeline?.some((beat, index) => index > 0 && beat.transition === "cut")) return;
  const capability = selectedMultiShotCapability(model, mode);
  if (capability?.state === "supported") return;
  throw Object.assign(new Error(capability?.state === "unsupported"
    ? "当前供应商、模型版本和模式明确不支持内部切镜，请重新规划必要的生成段"
    : "内部切镜能力待核实：先查询实际供应商官方资料并更新受审阅能力记录；保留合段方案，不自动拆短或提交生成"),
  { status: 400, code: capability?.state === "unsupported" ? "multiShotUnsupported" : "multiShotResearchRequired", research: capability?.research });
}
