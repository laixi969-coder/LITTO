export const mediaRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21", "20:11"];

export function matchesAspect(width: number, height: number, ratio: string, alignment = 0) {
  const parts = /^([1-9]\d*):([1-9]\d*)$/.exec(ratio);
  if (!parts || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const expected = Number(parts[1]) / Number(parts[2]);
  // ACT: 容许 2% 的供应商尺寸档位取整（如 4K 的 3040×5504）；视频另计像素对齐，误差不超过 5%。
  return Math.abs(width - height * expected) <= Math.max(width * 0.02, Math.min(width * 0.05, alignment * (1 + expected)));
}
