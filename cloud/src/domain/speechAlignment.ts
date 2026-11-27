import { decodeWindow, locateAudioWindow, sampleRate } from "./musicAlignment.ts";

export type SpeechAlignment = {
  status: "aligned" | "early" | "late" | "truncated" | "uncertain";
  offsetMs: number | null;
  reason?: string;
  missingStart?: boolean;
  missingEnd?: boolean;
};

type Interval = { start: number; end: number };
const block = sampleRate / 50; // 20 ms
const search = 2 * sampleRate;
const uncertain = (reason: string): SpeechAlignment => ({ status: "uncertain", offsetMs: null, reason });

// 短成片一次解码。超长成片按附近两分钟复用；源台词按素材及区间复用，各保留最近几个窗口。
function pcmReader(label: string, lookAhead: number, limit: number, duration?: number) {
  const cache = new Map<string, { first: number; end: number; data: Promise<Int16Array> }>();
  return async (file: string, first: number, end: number) => {
    let hit = cache.get(file);
    if (!hit || hit.first > first || hit.end < end) {
      const whole = duration !== undefined && Number.isFinite(duration) && duration > 0 && duration <= 3600;
      const from = whole ? 0 : first;
      const until = whole ? Math.ceil((duration + 0.05) * sampleRate) : Math.max(end, first + lookAhead * sampleRate);
      hit = { first: from, end: whole ? Infinity : until, data: decodeWindow(file, from / sampleRate, until - from, label) };
    }
    cache.delete(file);
    cache.set(file, hit);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
    try { return (await hit.data).subarray(first - hit.first, end - hit.first); }
    catch (error) { if (cache.get(file) === hit) cache.delete(file); throw error; }
  };
}

function rms(samples: Int16Array) {
  let sum = 0, squares = 0;
  for (const value of samples) { sum += value; squares += value * value; }
  return samples.length ? Math.sqrt(Math.max(0, squares / samples.length - (sum / samples.length) ** 2)) : 0;
}

function activeBlocks(source: Int16Array) {
  const levels: number[] = [];
  for (let at = 0; at + block <= source.length; at += block) levels.push(rms(source.subarray(at, at + block)));
  const sorted = levels.toSorted((a, b) => a - b);
  const floor = Math.max(64, (sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 0.06);
  return levels.flatMap((level, i) => level >= floor && (levels[i - 1] >= floor || levels[i + 1] >= floor) ? [i * block] : []);
}

function relation(source: Int16Array, output: Int16Array) {
  let a = 0, b = 0, aa = 0, bb = 0, ab = 0;
  for (let i = 0; i < source.length; i++) {
    const x = source[i], y = output[i];
    a += x; b += y; aa += x * x; bb += y * y; ab += x * y;
  }
  const n = source.length, xEnergy = aa - a * a / n, yEnergy = bb - b * b / n, dot = ab - a * b / n;
  return { gain: xEnergy > 0 ? Math.abs(dot / xEnergy) : 0,
    score: xEnergy > 0 && yEnergy > 0 ? Math.abs(dot) / Math.sqrt(xEnergy * yEnergy) : 0 };
}

function compareLine(source: Int16Array, output: Int16Array, start: number, outputOrigin: number,
  ranges: readonly Interval[] | null | undefined, toleranceMs: number): SpeechAlignment {
  const active = activeBlocks(source);
  if (active.length < 4) return uncertain("源台词的可辨发声不足80毫秒");
  const first = active[0], last = active.at(-1)! + block;
  const length = Math.min(Math.round(sampleRate * 0.18), last - first);
  const middle = Math.max(first, Math.min(last - length, active[Math.floor(active.length / 2)] - Math.round(length / 2)));
  const anchors = [first, middle, last - length].filter((at, i, all) => i === 0 || at - all[i - 1] >= length / 3);
  const matches: { shift: number; gain: number; score: number }[] = [];
  for (const at of anchors) {
    const expected = start + at, from = Math.max(0, expected - search), until = Math.min(output.length, expected + length + search);
    if (until - from < length) continue;
    const needle = source.subarray(at, at + length);
    const peak = locateAudioWindow(needle, output.subarray(from, until), expected - search < 0, expected + length + search > output.length);
    if (peak.index === null) continue;
    const found = from + peak.index;
    const { gain, score } = relation(needle, output.subarray(found, found + length));
    matches.push({ shift: found - expected, gain, score });
  }
  if (!matches.length) return uncertain("前后两秒内未找到唯一的同源发声，无法区分整句移位、混音掩蔽或缺失");
  const shifts = matches.map(match => match.shift).sort((a, b) => a - b);
  if (shifts.at(-1)! - shifts[0] > sampleRate * 0.012) return uncertain("同一句的多个发声位置给出不同偏移，可能有重复或句内剪接");
  if (matches.length === 1 && matches[0].score < 0.9) return uncertain("只有一处发声匹配，相关度不足以确定整句位置");
  const shift = shifts[Math.floor(shifts.length / 2)];
  const gains = matches.map(match => match.gain).sort((a, b) => a - b);
  const gain = gains[Math.floor(gains.length / 2)];
  const offsetMs = shift * 1000 / sampleRate;

  let rangeIndex = 0;
  function blockEvidence(at: number) {
    const pos = start + at + shift, absolute = (outputOrigin + pos) / sampleRate;
    while (ranges && rangeIndex < ranges.length && ranges[rangeIndex].end <= absolute) rangeIndex++;
    const noFrames = ranges && (!ranges[rangeIndex] || ranges[rangeIndex].start >= absolute + block / sampleRate);
    if (pos + block <= 0 || pos >= output.length || noFrames) return "missing";
    if (pos < 0 || pos + block > output.length) return "unknown";
    const needle = source.subarray(at, at + block), target = output.subarray(pos, pos + block);
    const expectedRms = rms(needle) * gain;
    let faintMatch = false;
    // 短帧在重采样后可能差一两个采样点；只在已由整句确认的位置附近检查。
    for (const adjustment of [0, -1, 1, -2, 2]) {
      const from = pos + adjustment;
      if (from < 0 || from + block > output.length) continue;
      const local = relation(needle, output.subarray(from, from + block));
      if (local.score >= 0.65) {
        if (local.gain >= gain * 0.14) return "matched";
        faintMatch = true;
      }
    }
    // 低音量仍可保留同源波形。不能把衰减、淡出当作剪掉了本句。
    if (!faintMatch && expectedRms >= 96 && rms(target) < Math.min(80, expectedRms * 0.10)) return "missing";
    return "unknown";
  }
  const evidence = active.map(blockEvidence);
  function edgeStatus(evidence: ReturnType<typeof blockEvidence>[]) {
    if (evidence.length >= 3 && evidence.slice(0, 3).every(value => value === "missing")) return "missing";
    if (evidence[0] === "matched" && !evidence.includes("missing") && evidence.filter(value => value === "matched").length >= evidence.length * 0.65) return "matched";
    return "unknown";
  }
  const opening = edgeStatus(evidence.slice(0, 6));
  const closing = edgeStatus(evidence.slice(-6).reverse());
  if (opening === "missing" || closing === "missing") {
    return { status: "truncated", offsetMs, missingStart: opening === "missing", missingEnd: closing === "missing",
      reason: "已定位保留的同源发声，按实测偏移对齐后，边缘连续多个应发声窗口无音轨或接近静音" };
  }
  // 短于可靠截断门槛的已知缺音也不能据此确认整句完整。
  let missingRun = 0, unmatchedRun = 0, unresolved = evidence.includes("missing");
  const firstMatch = evidence.indexOf("matched"), lastMatch = evidence.lastIndexOf("matched");
  for (let i = 0; i < evidence.length; i++) {
    if (active[i] - active[i - 1] > block) { missingRun = 0; unmatchedRun = 0; }
    missingRun = evidence[i] === "missing" ? missingRun + 1 : 0;
    unmatchedRun = evidence[i] === "matched" ? 0 : unmatchedRun + 1;
    if (missingRun >= 3 && firstMatch >= 0 && firstMatch < i - 2 && lastMatch > i) {
      return { status: "truncated", offsetMs, reason: "句中连续应发声区间无音轨或接近静音，其前后均已匹配同一句参考发声" };
    }
    if (unmatchedRun >= 3) unresolved = true;
  }
  if (opening !== "matched" || closing !== "matched" || matches.length < anchors.length || unresolved) {
    return { status: "uncertain", offsetMs: matches.length >= 2 ? offsetMs : null, reason: "仅匹配到部分发声，整句是否完整仍需复听" };
  }
  return { status: Math.abs(offsetMs) <= toleranceMs ? "aligned" : offsetMs < 0 ? "early" : "late", offsetMs };
}

export function createSpeechInspector(outputFile: string, outputDuration?: number, audioRanges?: readonly Interval[] | null) {
  const readOutput = pcmReader("成片", outputDuration === undefined ? 0 : 120, 1, outputDuration);
  const readSource = pcmReader("台词参考", 10, 4);
  return async function inspectLine(sourceFile: string, time: number, sourceTime: number, duration: number, toleranceMs = 40): Promise<SpeechAlignment> {
    if (![time, sourceTime, duration, toleranceMs].every(Number.isFinite) || time < 0 || sourceTime < 0 || duration <= 0 || toleranceMs < 0) {
      return uncertain("台词时间或源音频区间无效");
    }
    // 单句只取必要时间窗。异常的超长绑定留给复听，避免按外部时长分配任意大的 PCM 缓冲。
    if (duration > 300) return uncertain("单句超过五分钟，需拆分发声区间后核对");
    const start = Math.round(time * sampleRate), first = Math.round(sourceTime * sampleRate), count = Math.round(duration * sampleRate);
    const origin = Math.max(0, start - search);
    const [source, output] = await Promise.allSettled([readSource(sourceFile, first, first + count), readOutput(outputFile, origin, start + count + search)]);
    if (source.status === "rejected") throw source.reason;
    if (output.status === "rejected") throw output.reason;
    if (source.value.length + 0.04 * sampleRate < count) return uncertain("源音频未覆盖整句计划范围，无法核对句尾");
    return compareLine(source.value, output.value, start - origin, origin, audioRanges, toleranceMs);
  };
}
