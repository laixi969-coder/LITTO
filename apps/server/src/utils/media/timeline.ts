import { mkdir, writeAtomic } from "@toonflow/file";
import { dirname, join } from "node:path";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";

export interface TimelineClip {
  /** 干净短名，进 EDL 用；缺省按序号生成 S01 这种 */
  name?: string;
  /** 工作区内相对路径 */
  path: string;
  /** 只用某一段时给入出点（秒）；缺省用整条 */
  in?: number;
  out?: number;
}

export interface TimelineEntry {
  index: number;
  name: string;
  path: string;
  sourceIn: number;
  sourceOut: number;
  recordIn: number;
  recordOut: number;
  frames: number;
  /** 绝对路径，只写进 EDL 的注释行，方便剪辑器自动链接素材 */
  absolute: string;
}

export interface TimelineResult {
  fps: number;
  duration: number;
  entries: TimelineEntry[];
  otio: { path: string; clips: number };
  edl: { path: string; clips: number };
}

const pad = (value: number, size = 2) => String(Math.floor(value)).padStart(size, "0");

/** 24fps 非丢帧时间码。整数帧换算，避免浮点累积把切点推歪。 */
export function timecode(seconds: number, fps: number) {
  const totalFrames = Math.round(seconds * fps);
  const frames = totalFrames % fps;
  const secs = Math.floor(totalFrames / fps) % 60;
  const mins = Math.floor(totalFrames / (fps * 60)) % 60;
  const hours = Math.floor(totalFrames / (fps * 3600));
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
}

function rational(value: number, fps: number) {
  return { OTIO_SCHEMA: "RationalTime.1", rate: fps, value: Math.round(value * fps) };
}

/**
 * OpenTimelineIO：filmcraft / 达芬奇 / Premiere 都能读的时间线互换格式。
 * 手写 JSON 而不是引 SDK —— 结构稳定，少一个依赖。
 */
function buildOtio(name: string, fps: number, entries: TimelineEntry[], absolute: string[]) {
  const children = entries.map((entry, index) => ({
    OTIO_SCHEMA: "Clip.2",
    name: entry.name,
    metadata: { milimili: { sourceIn: entry.sourceIn, sourceOut: entry.sourceOut, recordIn: entry.recordIn } },
    source_range: {
      OTIO_SCHEMA: "TimeRange.1",
      start_time: rational(entry.sourceIn, fps),
      duration: rational(entry.sourceOut - entry.sourceIn, fps),
    },
    // Clip.2 用 media_references 字典 + active_media_reference_key；单数 media_reference 是旧 schema，0.18 直接报 KeyError。
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: entry.name,
        // URL 里带中文或空格时不编码，部分剪辑器会当成不存在的路径。
        target_url: `file://${encodeURI(absolute[index])}`,
        available_range: {
          OTIO_SCHEMA: "TimeRange.1",
          start_time: rational(0, fps),
          duration: rational(entry.sourceOut - entry.sourceIn, fps),
        },
        metadata: {},
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
    effects: [],
    markers: [],
    enabled: true,
  }));
  return {
    OTIO_SCHEMA: "Timeline.1",
    name,
    metadata: { milimili: { fps, clips: entries.length, generated: new Date().toISOString() } },
    global_start_time: rational(0, fps),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: [
        { OTIO_SCHEMA: "Track.1", name: "V1", kind: "Video", metadata: {}, children, effects: [], markers: [], enabled: true },
        { OTIO_SCHEMA: "Track.1", name: "A1", kind: "Audio", metadata: {}, children: [], effects: [], markers: [], enabled: true },
      ],
      effects: [], markers: [], source_range: null,
    },
  };
}

/** CMX3600 EDL：最老的格式也是最通用的，达芬奇、Premiere、FCP 都认。 */
function buildEdl(name: string, fps: number, entries: TimelineEntry[]) {
  const lines = [`TITLE: ${name}`, `FCM: NON-DROP FRAME`, ""];
  entries.forEach((entry, index) => {
    const number = pad(index + 1, 3);
    const label = entry.name.slice(0, 8).padEnd(8);
    const sourceIn = timecode(entry.sourceIn, fps);
    const sourceOut = timecode(entry.sourceOut, fps);
    const recordIn = timecode(entry.recordIn, fps);
    const recordOut = timecode(entry.recordOut, fps);
    lines.push(`${number}  ${label} V     C        ${sourceIn} ${sourceOut} ${recordIn} ${recordOut}`);
    lines.push(`* FROM CLIP NAME: ${entry.name}`);
    // 只给 reel 名，导入时要人工一张张对文件；给绝对路径，达芬奇/Premiere 能自动链接。
    lines.push(`* SOURCE FILE: ${entry.absolute}`);
  });
  lines.push("");
  return lines.join("\n");
}

async function probeDuration(cwd: string, path: string) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd);
  const data = await new Promise<{ format?: { duration?: string | number } }>((resolve, reject) =>
    ffmpeg.ffprobe(path, (error, result) => error ? reject(error) : resolve(result)));
  const duration = Number(data.format?.duration ?? 0);
  if (!duration) throw new Error(`读不到时长：${path}`);
  return duration;
}

/**
 * 把已生成的镜头导成时间线：一条视频轨按顺序排，音轨留空。
 * 生成完的素材直接进剪辑器精剪——转场、J/L cut、调色、混音这些本就不该在生成链路里硬做。
 */
export async function exportTimeline(cwd: string, request: {
  clips: TimelineClip[];
  name?: string;
  fps?: number;
  outputDirectory?: string;
  verifyDuration?: boolean;
}): Promise<TimelineResult> {
  const fps = request.fps && request.fps >= 1 && request.fps <= 120 ? Math.round(request.fps) : 24;
  const name = (request.name ?? "milimili-timeline").replace(/[\\/:*?"<>|\n\r]/g, "").slice(0, 60) || "milimili-timeline";
  const entries: TimelineEntry[] = [];
  const absolute: string[] = [];
  let cursor = 0;
  for (const [index, clip] of request.clips.entries()) {
    const resolved = await resolveWorkspacePath(cwd, clip.path);
    const available = await probeDuration(cwd, resolved.path);
    const sourceIn = Math.max(0, Number(clip.in ?? 0));
    const sourceOut = clip.out === undefined ? available : Math.min(available, Number(clip.out));
    if (sourceOut <= sourceIn + 0.04) throw new Error(`第 ${index + 1} 条的入出点不成立：in=${sourceIn} out=${sourceOut}（素材长 ${available.toFixed(2)} 秒）`);
    const duration = sourceOut - sourceIn;
    entries.push({
      index: index + 1,
      name: clip.name?.trim() || `S${pad(index + 1, 2)}`,
      path: clip.path,
      sourceIn,
      sourceOut,
      recordIn: cursor,
      recordOut: cursor + duration,
      frames: Math.round(duration * fps),
      absolute: resolved.path,
    });
    absolute.push(resolved.path);
    cursor += duration;
  }
  const outputDirectory = request.outputDirectory ?? "assets/timeline";
  const otioResolved = await resolveWorkspacePath(cwd, join(outputDirectory, `${name}.otio`), true);
  const edlResolved = await resolveWorkspacePath(cwd, join(outputDirectory, `${name}.edl`), true);
  await mkdir(dirname(otioResolved.path), { recursive: true });
  await writeAtomic(otioResolved.path, JSON.stringify(buildOtio(name, fps, entries, absolute), null, 2));
  await writeAtomic(edlResolved.path, buildEdl(name, fps, entries));
  return {
    fps,
    duration: Number(cursor.toFixed(3)),
    entries,
    otio: { path: join(outputDirectory, `${name}.otio`), clips: entries.length },
    edl: { path: join(outputDirectory, `${name}.edl`), clips: entries.length },
  };
}
