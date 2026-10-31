import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "@toonflow/file";
import { resolveDirectorPalette } from "@/utils/media/directorMatch";
import { getStatus } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";

const run = promisify(execFile);

export interface ClipIssue {
  kind: "blackFlash" | "clipping" | "silence" | "durationMismatch" | "brightnessJump" | "colorJump" | "resolutionMismatch" | "blownHighlight" | "crushedShadow" | "oversaturated" | "underexposed" | "desaturated";
  at?: number;
  note: string;
}

export interface ClipReport {
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  luma: number;
  u: number;
  v: number;
  peakDb: number | null;
  meanDb: number | null;
  sat: number;
  hue: number;
  ymax: number;
  ymin: number;
  satmax: number;
  issues: ClipIssue[];
}

interface Options {
  /** 计划时长，用于核对实际生成是否明显短于或长于预期 */
  expectedDuration?: number;
  /** 目标导演色卡文件名（不带 .json），用于对照全片色相与饱和度偏离 */
  palette?: string;
  /** 允许偏暗或低饱和的镜头（夜景、刻意低调、回忆段落），默认不允许 */
  allowDark?: boolean;
  /** 例外：片头片尾的黑场不算缺陷 */
  allowBlackAt?: { start: number; end: number }[];
}

const BLACK = /black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g;

async function binaries() {
  const { tools } = await getStatus();
  if (!tools.ffmpeg.path || !tools.ffprobe.path) throw Object.assign(new Error("质检需要 FFmpeg，请先安装"), { code: "FFMPEG_REQUIRED", status: 424 });
  return { ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path };
}

async function probe(ffprobe: string, path: string) {
  const { stdout } = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { maxBuffer: 8 * 1024 * 1024 });
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }[] };
  const video = data.streams?.find(stream => stream.codec_type === "video");
  const [num, den] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: Number(data.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: den ? num / den : 0,
  };
}

async function blackFlashing(ffmpeg: string, path: string) {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", path, "-vf", "blackdetect=d=0.04:pic_th=0.95", "-an", "-f", "null", "-"], { maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stderr: String(error.stderr ?? "") })) as { stderr: string };
  const found: { start: number; end: number; duration: number }[] = [];
  for (const match of stderr.matchAll(BLACK)) found.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) });
  return found;
}

async function sampling(ffmpeg: string, path: string, duration: number) {
  const samples = [0.3, duration / 2, Math.max(0.3, duration - 0.4)];
  const values: { luma: number; u: number; v: number; sat: number; hue: number; ymax: number; ymin: number; satmax: number }[] = [];
  for (const at of samples) {
    const { stdout } = await run(ffmpeg, ["-hide_banner", "-ss", String(at), "-i", path, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-an", "-f", "null", "-"], { maxBuffer: 4 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? "") })) as { stdout: string };
    const read = (key: string) => Number(new RegExp(`${key}=([\\d.]+)`).exec(stdout)?.[1] ?? 0);
    values.push({
      luma: read("YAVG"), u: read("UAVG"), v: read("VAVG"), sat: read("SATAVG"), hue: read("HUEAVG"),
      ymax: read("YMAX"), ymin: read("YMIN"), satmax: read("SATMAX"),
    });
  }
  const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / (list.length || 1);
  return {
    luma: mean(values.map(item => item.luma)),
    u: mean(values.map(item => item.u)),
    v: mean(values.map(item => item.v)),
    sat: mean(values.map(item => item.sat)),
    hue: mean(values.map(item => item.hue)),
    ymax: Math.max(...values.map(item => item.ymax)),
    ymin: Math.min(...values.map(item => item.ymin)),
    satmax: Math.max(...values.map(item => item.satmax)),
  };
}

async function loudness(ffmpeg: string, path: string) {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 }).catch(error => ({ stderr: String(error.stderr ?? "") })) as { stderr: string };
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1];
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1];
  return { peakDb: peak === undefined ? null : Number(peak), meanDb: mean === undefined ? null : Number(mean) };
}

/** HEX → HSL，只取色相与饱和度做对照，亮度受曝光影响不参与。 */
function hexToHsl(hex: string) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const light = (max + min) / 2;
  const sat = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0;
  return { hue, sat: sat * 100 };
}

/**
 * 读取导演色卡的主色列表。色板通常是「冷主色＋暖点缀」的对立结构，
 * 取平均色相会把这种结构抹平，所以保留每个主色，判定时看画面最接近哪一个。
 */
async function paletteTarget(file: string) {
  let record: { name?: string; palette?: { primary?: { hex: string; name?: string; ratio?: number | null }[] } };
  try {
    record = JSON.parse(await readFile(await resolveDirectorPalette(file), "utf8"));
  } catch {
    throw Object.assign(new Error(`找不到导演色卡 ${file}，请确认文件名与 data/skills/directorPalettes/palettes 下的一致`), { status: 400 });
  }
  const primary = record.palette?.primary ?? [];
  if (!primary.length) throw Object.assign(new Error(`色卡 ${file} 没有主色板`), { status: 400 });
  return {
    name: record.name ?? file,
    colors: primary.map(color => {
      const { hue, sat } = hexToHsl(color.hex);
      return { hex: color.hex, name: color.name ?? "", hue, sat, ratio: color.ratio ?? 0 };
    }),
  };
}

/**
 * 逐镜量化体检：只做可量化的技术缺陷，不判断表演与创作。
 * 全部本地计算、不花钱、不调用视觉模型，用于在合成前挡住黑闪、削波、冷暖跳变这类低成本可查的问题。
 */
export async function inspectClips(cwd: string, clips: string[], options: Options = {}, signal?: AbortSignal) {
  const target = options.palette ? await paletteTarget(options.palette) : undefined;
  const { ffmpeg, ffprobe } = await binaries();
  const reports: ClipReport[] = [];
  for (const clip of clips) {
    signal?.throwIfAborted();
    const file = await resolveWorkspacePath(cwd, clip);
    const meta = await probe(ffprobe, file.path);
    const [blacks, tone, audio] = await Promise.all([
      blackFlashing(ffmpeg, file.path),
      sampling(ffmpeg, file.path, meta.duration),
      loudness(ffmpeg, file.path),
    ]);
    const issues: ClipIssue[] = [];
    const allow = options.allowBlackAt ?? [];
    for (const black of blacks) {
      const exempt = allow.some(range => black.start >= range.start - 0.02 && black.end <= range.end + 0.02);
      if (!exempt) issues.push({ kind: "blackFlash", at: black.start, note: `第 ${black.start.toFixed(2)} 秒出现 ${black.duration.toFixed(2)} 秒黑场` });
    }
    if (audio.peakDb !== null && audio.peakDb > -0.5) issues.push({ kind: "clipping", note: `音频峰值 ${audio.peakDb} dB，已贴近上限，播放时会破音` });
    if (audio.meanDb !== null && audio.meanDb < -50) issues.push({ kind: "silence", note: `平均音量 ${audio.meanDb} dB，几乎无声` });
    // 真实感破功的三个硬信号：高光死白、暗部压死、饱和过高。真人实拍极少同时出现这三项以外的一致性缺陷。
    if (tone.ymax >= 252) issues.push({ kind: "blownHighlight", note: `高光峰值 ${tone.ymax}，接近纯白，实拍镜头的高光应保留滚降细节` });
    if (tone.ymin <= 2) issues.push({ kind: "crushedShadow", note: `暗部最低 ${tone.ymin}，已压死，真实镜头暗部仍有微弱信息` });
    if (tone.sat > 55) issues.push({ kind: "oversaturated", note: `平均饱和度 ${tone.sat.toFixed(0)}，超过实拍常见区间，容易显得像渲染图` });
    // 做脏做旧在数据上就是这两项：整体压暗 + 饱和度被拉低。真人写实不该出现。
    if (tone.luma < 55 && !options.allowDark) issues.push({ kind: "underexposed", note: `平均亮度 ${tone.luma.toFixed(0)}，画面偏暗发闷；除非夜景或刻意低调，否则应按正常曝光` });
    if (tone.sat < 8 && !options.allowDark) issues.push({ kind: "desaturated", note: `平均饱和度 ${tone.sat.toFixed(0)}，已被抽干成灰调；写实不等于低饱和` });
    if (options.expectedDuration && Math.abs(meta.duration - options.expectedDuration) > Math.max(0.6, options.expectedDuration * 0.25)) {
      issues.push({ kind: "durationMismatch", note: `实际 ${meta.duration.toFixed(2)} 秒，计划 ${options.expectedDuration} 秒` });
    }
    reports.push({ path: clip, ...meta, ...tone, ...audio, issues });
  }
  const base = reports[0];
  for (const report of reports) {
    if (base && (report.width !== base.width || report.height !== base.height || Math.abs(report.fps - base.fps) > 0.01)) {
      report.issues.push({ kind: "resolutionMismatch", note: `画幅 ${report.width}×${report.height}@${report.fps.toFixed(2)} 与首镜不一致` });
    }
  }
  // 相邻镜头的亮度与冷暖跳变：只看方差最大的差异，避免把正常的光线变化当成缺陷。
  for (let index = 1; index < reports.length; index += 1) {
    const previous = reports[index - 1]!;
    const current = reports[index]!;
    if (Math.abs(current.luma - previous.luma) > 42) current.issues.push({ kind: "brightnessJump", note: `亮度 ${previous.luma.toFixed(0)} → ${current.luma.toFixed(0)}，与上一镜差 ${Math.abs(current.luma - previous.luma).toFixed(0)}` });
    const shift = Math.max(Math.abs(current.u - previous.u), Math.abs(current.v - previous.v));
    if (shift > 12) current.issues.push({ kind: "colorJump", note: `色度偏移 ${shift.toFixed(1)}，与上一镜冷暖不一致` });
  }
  // 风格一致性：同一部片里饱和度与色相不该各自为政，偏离全片均值过多的镜头单独列出。
  const meanOf = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / (list.length || 1);
  const satMean = meanOf(reports.map(report => report.sat));
  const hueMean = meanOf(reports.map(report => report.hue));
  const style = reports
    .map(report => {
      const notes: string[] = [];
      if (Math.abs(report.sat - satMean) > 18) notes.push(`饱和度 ${report.sat.toFixed(0)}，全片均值 ${satMean.toFixed(0)}`);
      if (Math.abs(report.hue - hueMean) > 26) notes.push(`色相 ${report.hue.toFixed(0)}°，全片均值 ${hueMean.toFixed(0)}°`);
      return notes.length ? { path: report.path, note: notes.join("；") } : null;
    })
    .filter((item): item is { path: string; note: string } => item !== null);
  const total = reports.reduce((sum, report) => sum + report.issues.length, 0);
  return {
    clips: reports.map(report => ({ ...report, luma: Math.round(report.luma), u: Math.round(report.u), v: Math.round(report.v) })),
    summary: {
      clips: reports.length,
      duration: Number(reports.reduce((sum, report) => sum + report.duration, 0).toFixed(2)),
      issues: total,
      blocked: reports.filter(report => report.issues.some(issue => issue.kind === "blackFlash" || issue.kind === "clipping" || issue.kind === "resolutionMismatch")).map(report => report.path),
      style: { saturationMean: Number(satMean.toFixed(1)), hueMean: Number(hueMean.toFixed(1)), outliers: style },
      palette: target
        ? (() => {
          // 判定标准：画面色相要靠近色板里的某一个主色，而不是靠近它们的平均值。
          const drift = reports.map(report => {
            let best = { hex: "", name: "", hueDrift: 360, satDrift: 0 };
            for (const color of target.colors) {
              const raw = Math.abs(report.hue - color.hue);
              const hueDrift = Math.min(raw, 360 - raw);
              if (hueDrift < best.hueDrift) best = { hex: color.hex, name: color.name, hueDrift, satDrift: Math.abs(report.sat - color.sat) };
            }
            return { path: report.path, nearest: best };
          });
          return {
            target: { name: target.name, colors: target.colors.map(c => ({ hex: c.hex, name: c.name, hue: Math.round(c.hue), ratio: c.ratio })) },
            within: drift.filter(item => item.nearest.hueDrift <= 30 && item.nearest.satDrift <= 18).length,
            offTarget: drift
              .filter(item => item.nearest.hueDrift > 30 || item.nearest.satDrift > 18)
              .sort((a, b) => b.nearest.hueDrift - a.nearest.hueDrift)
              .slice(0, 8)
              .map(item => ({ path: item.path, accent: item.nearest.hex, hueDrift: Math.round(item.nearest.hueDrift), satDrift: Math.round(item.nearest.satDrift) })),
          };
        })()
        : undefined,
    },
  };
}

/**
 * 整片体检：合成后跑，专门抓段间黑闪、响度和时长。
 * 片头片尾的黑场是设计的一部分，用 headTail 声明豁免区间。
 */
export async function inspectFilm(cwd: string, file: string, options: { headTail?: { start: number; end: number }[] } = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { ffmpeg, ffprobe } = await binaries();
  const resolved = await resolveWorkspacePath(cwd, file);
  const meta = await probe(ffprobe, resolved.path);
  const [blacks, audio] = await Promise.all([
    blackFlashing(ffmpeg, resolved.path),
    loudness(ffmpeg, resolved.path),
  ]);
  const issues: ClipIssue[] = [];
  const exempt = options.headTail ?? [];
  for (const black of blacks) {
    const allowed = exempt.some(range => black.start <= range.start + 0.5 && black.end >= range.end - 0.5);
    if (!allowed) issues.push({ kind: "blackFlash", at: black.start, note: `第 ${black.start.toFixed(2)} 秒出现 ${black.duration.toFixed(2)} 秒黑场，若非有意转场即为拼接缺陷` });
  }
  if (audio.peakDb !== null && audio.peakDb > -0.5) issues.push({ kind: "clipping", note: `音频峰值 ${audio.peakDb} dB，已贴近上限` });
  if (audio.meanDb !== null && audio.meanDb < -50) issues.push({ kind: "silence", note: `平均音量 ${audio.meanDb} dB，几乎无声` });
  return { file, ...meta, ...audio, issues, summary: { duration: Number(meta.duration.toFixed(2)), issues: issues.length } };
}
