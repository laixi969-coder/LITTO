import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const sampleRate = 4000;
const minRms = 32; // 16 位 PCM，约 -60 dBFS。接近静音时相关峰容易由编码噪声决定。

export async function decodeWindow(file: string, start: number, count: number, label: string) {
  const first = Math.round(start * sampleRate);
  // 以播放时间补齐首部及轨内空档。默认 100ms 的硬补偿门槛会把短缺帧之后的整条声音提前。
  const filter = `aresample=${sampleRate}:async=1:first_pts=0:min_hard_comp=0.001,atrim=start_sample=${first}:end_sample=${first + count}`;
  try {
    const args = ["-nostdin", "-v", "error", "-i", file, "-map", "0:a:0", "-vn", "-af", filter,
      "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"];
    const { stdout } = await execute("ffmpeg", args, {
      encoding: "buffer", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: Math.max(64 * 1024, count * 2 + 4096),
    });
    const samples = new Int16Array(Math.floor(stdout.length / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = stdout.readInt16LE(i * 2);
    return samples;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure.code === "ENOENT") throw new Error(`${label}位置检测需要 FFmpeg`);
    throw new Error(failure.killed ? `${label}音频窗口解码超时` : `${label}音频窗口解码失败，请检查音轨和媒体文件`);
  }
}

type WindowMeasurement = { offsetMs: number | null; correlation: number | null; reason?: string };

/** 比较对应区间，正偏移表示成片声音更晚。搜索与比较都限制在调用方指定的同源区间内。 */
export async function measureMusicWindow(outputFile: string, sourceFile: string, outputTime: number, sourceTime: number,
  windowSeconds: number, searchMarginSeconds = 0.25): Promise<WindowMeasurement> {
  // ACT: 用短窗直接求归一化相关，避免跨剪点和引入 FFT 依赖；长片由调用方分窗，不在主线程扫描整首歌。
  if (![outputTime, sourceTime, windowSeconds, searchMarginSeconds].every(Number.isFinite)
    || outputTime < 0 || sourceTime < 0 || windowSeconds <= 0 || windowSeconds > 4 || searchMarginSeconds <= 0 || searchMarginSeconds > 0.5) {
    throw new Error("原曲位置检测需非负入点、至多4秒的比较窗及至多0.5秒的正搜索余量");
  }
  const count = Math.round(windowSeconds * sampleRate);
  const margin = Math.round(searchMarginSeconds * sampleRate);
  const required = 2 * margin + 0.25 * sampleRate;
  if (!margin || count < required) return { offsetMs: null, correlation: null, reason: "比较窗太短，无法在该片段内区分前后偏移" };
  const [decodedOutput, decodedSource] = await Promise.allSettled([
    decodeWindow(outputFile, outputTime, count, "成片"), decodeWindow(sourceFile, sourceTime, count, "原曲"),
  ]);
  if (decodedOutput.status === "rejected") throw decodedOutput.reason;
  if (decodedSource.status === "rejected") throw decodedSource.reason;
  const output = decodedOutput.value, source = decodedSource.value;
  const available = Math.min(output.length, source.length);
  if (count - available > 0.04 * sampleRate || available < required) {
    return { offsetMs: null, correlation: null, reason: "有效采样不足，无法在该片段内比较前后偏移" };
  }
  const result = locateAudioWindow(output.subarray(margin, available - margin), source.subarray(0, available));
  return { offsetMs: result.index === null ? null : (margin - result.index) * 1000 / sampleRate,
    correlation: result.correlation, ...(result.reason && { reason: result.reason }) };
}

/** 在搜索区内匹配同一段 PCM。真文件的首尾可有合法边界峰，普通搜索边界仍表示范围不足。 */
export function locateAudioWindow(template: Int16Array, source: Int16Array, allowFirst = false, allowLast = false):
  { index: number | null; correlation: number | null; reason?: string } {
  const length = template.length;
  if (!length || source.length < length) return { index: null, correlation: null, reason: "有效采样不足" };
  let sum = 0, squares = 0, sourceSum = 0, sourceSquares = 0;
  for (let i = 0; i < length; i++) {
    sum += template[i];
    squares += template[i] * template[i];
    sourceSum += source[i];
    sourceSquares += source[i] * source[i];
  }
  const energy = squares - sum * sum / length;
  const floor = minRms * minRms * length;
  if (energy < floor) return { index: null, correlation: null, reason: "成片采样窗接近静音" };

  const scores = new Float64Array(source.length - length + 1);
  let peak = 0, peakIndex = 0, hasSourceSignal = false;
  for (let start = 0; start < scores.length; start++) {
    if (start) {
      const added = source[start + length - 1], removed = source[start - 1];
      sourceSum += added - removed;
      sourceSquares += added * added - removed * removed;
    }
    const sourceEnergy = sourceSquares - sourceSum * sourceSum / length;
    if (sourceEnergy < floor) continue;
    hasSourceSignal = true;
    let dot = 0;
    for (let i = 0; i < length; i++) dot += template[i] * source[start + i];
    const score = Math.min(1, Math.abs(dot - sum * sourceSum / length) / Math.sqrt(energy * sourceEnergy));
    scores[start] = score;
    if (score > peak) { peak = score; peakIndex = start; }
  }
  if (!hasSourceSignal) return { index: null, correlation: null, reason: "原曲采样窗接近静音" };
  if (peak < 0.65) return { index: null, correlation: peak, reason: "同源波形相关度不足" };
  if ((!allowFirst && peakIndex === 0) || (!allowLast && peakIndex === scores.length - 1)) {
    return { index: null, correlation: peak, reason: "相关峰位于搜索边界，实际偏移可能更大" };
  }
  // 忽略峰顶相邻的采样点；周期性伴奏出现相距 10 ms 以上的近等强峰时，不能确定是哪一拍。
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(i - peakIndex) >= sampleRate * 0.01 && scores[i] >= peak - 0.05) {
      return { index: null, correlation: peak, reason: "存在多个近等强相关峰，无法唯一定位原曲" };
    }
  }
  return { index: peakIndex, correlation: peak };
}
