// 仅收录已核实在 2026 年及以后首次发布的模型；目录创建时间不等于模型发布日期。
// 新模型须核实发布日期后扩展此列表，否则保持隐藏。
const verifiedModels = [
  /^nanoBanana2(?:Economy|Lite|LiteEconomy)?$/,
  /^seedance20$/,
  /^(?:Qwen\/)?Qwen3[-_]TTS(?:[-_].*)?$/i,
  /^(?:minimax[\/-])?speech[-_]2[.-]8(?:[-_].*)?$/i,
  /^music_v2_5$/,
  /^(?:[^/]+\/)?(?:doubao[-/])?seedance[-_.]2[.-](?:0|5)(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?(?:doubao[-/])?seedream[-_.]5[.-]0(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?(?:gpt[-_]?image[-_.]?2|gptImage2)(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?(?:nano[-_]?banana[-_]?2|nanoBanana2)(?:[-./_].*)?$/i,
  /^gemini[-_.]3\.1[-_.]flash[-_.]image[-_.]preview$/i,
  /^midjourney(?:Niji7|V81|V82)$/i,
  /^midjourney\/v8\.[12]\/(?:text-to-image|image-to-image|image-to-video)$/i,
  /^viduQ3(?:Turbo|Pro)(?:Text|Image|StartEnd)$|^viduQ3Reference(?:Base|Mix|Ad|Drama)$/,
  /^(?:vidu[-_](?:video[-_])?q[34](?:[-_.].*)?|viduq4-preview)$/i,
  /^(?:[^/]+\/)?kling[-_](?:video[-_])?(?:v?3(?:[.-]0)?|v?4)(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?(?:minimax[-/])?(?:video[-_])?h3(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?(?:wan[-_]?3[.-]0|wan3\.0)(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?wan[-_]?2[.-]7(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?qwen[-_]?image[-_.]?(?:2[.-]0|3[.-]0)(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?(?:gpt[-_]6(?:[.-]\d+)?|gpt[-_]5[.-]4)(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?deepseek[-_/]?(?:v4|flash)(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?qwen3[.-]8(?:[-./_].*)?$/i,
  /^(?:[^/]+\/)?glm[-_]?5[.-]3(?:[-./_].*)?$/i,
];

export function isModelFrom2026(modelId: string) {
  return verifiedModels.some(pattern => pattern.test(modelId));
}
