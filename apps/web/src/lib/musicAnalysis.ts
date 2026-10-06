export type LyricCue = { start: number; end?: number; text: string };
export type MusicAnalysis = {
  duration: number;
  bpm: number | null;
  beats: number[];
  energy: number[];
  melody: [number, number, number][];
  warnings: string[];
};

export function parseLyrics(text: string): LyricCue[] {
  const cues: LyricCue[] = [];
  const clock = (hours: string, minutes: string, seconds: string, fraction: string) => {
    if (Number(minutes) >= 60 || Number(seconds) >= 60) throw new Error("歌词包含无效时间码，请先修正");
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`);
  };
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const offset = Number(normalized.match(/\[offset:\s*(-?\d+)\]/i)?.[1] ?? 0) / 1000;
  for (const block of normalized.split(/\n\s*\n/)) {
    const match = block.match(/(?:^|\n)(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})[^\n]*\n([\s\S]*)/);
    if (match) cues.push({ start: clock(match[1]!, match[2]!, match[3]!, match[4]!), end: clock(match[5]!, match[6]!, match[7]!, match[8]!), text: match[9]!.trim() });
  }
  if (!cues.length) {
    for (const line of normalized.split("\n")) {
      const times = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      const content = line.replace(/\[[^\]]*\]/g, "").trim();
      if (!content) continue;
      for (const time of times) {
        if (Number(time[2]) >= 60) throw new Error("歌词包含无效时间码，请先修正");
        cues.push({ start: Number(time[1]) * 60 + Number(time[2]) + Number(`0.${time[3] ?? 0}`) + offset, text: content });
      }
    }
  }
  cues.sort((a, b) => a.start - b.start);
  if (cues.some(cue => !Number.isFinite(cue.start) || cue.start < 0 || (cue.end !== undefined && cue.end <= cue.start))) throw new Error("歌词包含无效时间码，请先修正");
  return cues;
}

export function musicCuts(beats: number[], duration: number, fps: number, offsetMs: number, every: number) {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(offsetMs) || !Number.isInteger(every) || every < 1) throw new Error("卡点参数无效");
  return [...new Set(beats.filter((_, index) => index % every === 0).map(time => Math.round((time + offsetMs / 1000) * fps)))]
    .filter(frame => frame > 0 && frame / fps < duration).sort((a, b) => a - b)
    .map(frame => ({ frame, seconds: frame / fps }));
}

export async function decodeMusic(file: File) {
  if (!file.size || file.size > 100 * 1024 * 1024) throw new Error("歌曲须为非空且不超过 100 MB 的文件");
  // 先读取容器时长，再分配整曲 PCM，避免低码率超长文件在解码时耗尽内存。
  const url = URL.createObjectURL(file);
  const media = document.createElement("audio");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("读取歌曲时长超时，请检查音频文件")), 30000);
      media.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      media.onerror = () => { clearTimeout(timer); reject(new Error("无法读取 MP3，请检查文件格式")); };
      media.preload = "metadata"; media.src = url;
    });
    if (!Number.isFinite(media.duration) || media.duration < 1 || media.duration > 600) throw new Error("音乐分析支持 1 秒至 10 分钟的歌曲，请先裁剪超长音频");
  } finally { media.removeAttribute("src"); media.load(); URL.revokeObjectURL(url); }
  const context = new AudioContext({ sampleRate: 44100 });
  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    if (!Number.isFinite(audio.duration) || audio.duration < 1 || audio.duration > 600) throw new Error("音乐分析支持 1 秒至 10 分钟的歌曲，请先裁剪超长音频");
    return audio;
  } finally { await context.close(); }
}

export async function monoMusic(audio: AudioBuffer, sampleRate: number) {
  const context = new OfflineAudioContext(1, Math.ceil(audio.duration * sampleRate), sampleRate);
  const source = context.createBufferSource();
  source.buffer = audio;
  source.connect(context.destination);
  source.start();
  return (await context.startRendering()).getChannelData(0);
}

export function musicWav(samples: Float32Array) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (start: number, value: string) => [...value].forEach((char, index) => view.setUint8(start + index, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767), true));
  return new Blob([buffer], { type: "application/octet-stream" });
}
