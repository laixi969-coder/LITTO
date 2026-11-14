import { mkdir, rm, stat } from "@toonflow/file";
import type { FfmpegCommand, FfprobeData } from "@toonflow/ffmpeg";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createWorkspaceFfmpeg, getStatus } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";

type SampleOptions = { path: string; count?: number; timestamps?: number[] };
const formats = "mov,matroska,webm,avi,mpegts,mpegvideo,ogg,flv,gif";
const inputOptions = ["-protocol_whitelist file,pipe", `-format_whitelist ${formats}`, "-probesize 5000000", "-analyzeduration 5000000", "-threads 2"];

async function probeVideo(source: string, signal: AbortSignal): Promise<FfprobeData> {
  const probePath = (await getStatus()).tools.ffprobe.path!;
  const controller = new AbortController();
  const probeSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(15000)]);
  probeSignal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // fluent 的 ffprobe 查询不暴露子进程；复用已配置程序，以固定参数和 SIGKILL 真正停止探测。
    const child = spawn(probePath, ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats,
      "-probesize", "5000000", "-analyzeduration", "5000000", "-threads", "2", "-show_entries",
      "format=duration,start_time:stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,start_time,duration:stream_disposition=attached_pic", "-of", "json", source],
    { signal: probeSignal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", failure: Error | undefined;
    child.stdout.on("data", data => { stdout += data.toString(); if (stdout.length > 1024 * 1024) controller.abort(new Error("视频元信息超过限制")); });
    child.stderr.resume();
    child.once("error", cause => { failure = cause; });
    child.once("close", code => {
      if (probeSignal.aborted) return reject(probeSignal.reason);
      if (failure || code !== 0) return reject(Object.assign(new Error("无法读取视频信息"), { status: 400 }));
      try { resolve(JSON.parse(stdout)); } catch { reject(Object.assign(new Error("视频元信息无效"), { status: 400 })); }
    });
  });
}

export async function sampleFrames(directory: string, options: SampleOptions, signal?: AbortSignal) {
  const activeSignal = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
  activeSignal.throwIfAborted();
  const source = (await resolveWorkspacePath(directory, options.path)).path;
  if (!(await stat(source)).isFile()) throw Object.assign(new Error("请选择工作区内的视频文件"), { status: 400 });
  const ffmpeg = await createWorkspaceFfmpeg(directory, activeSignal);
  const metadata = await probeVideo(source, activeSignal);
  activeSignal.throwIfAborted();
  const stream = metadata.streams?.find(item => item.codec_type === "video" && !item.disposition?.attached_pic);
  const duration = Number(stream?.duration ?? metadata.format?.duration), width = Number(stream?.width), height = Number(stream?.height);
  const rates = [stream?.avg_frame_rate, stream?.r_frame_rate].map(value => String(value ?? "").split("/").map(Number));
  const frameRate = rates.map(rate => rate.length === 2 ? rate[0]! / rate[1]! : rate[0]!).find(rate => Number.isFinite(rate) && rate > 0) ?? 0;
  const startTime = Number(stream?.start_time ?? metadata.format?.start_time ?? 0);
  if (!stream || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw Object.assign(new Error("文件没有可解码的视频、时长或帧率"), { status: 400 });
  }
  const times = options.timestamps ?? Array.from({ length: options.count ?? 6 }, (_, index) => duration * (index + 0.5) / (options.count ?? 6));
  if (times.some(time => time >= duration)) throw Object.assign(new Error("采样时间必须小于视频时长"), { status: 400 });
  for (const folder of ["assets", "assets/videoFrames"]) {
    const target = (await resolveWorkspacePath(directory, folder, true)).path;
    await mkdir(target).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "EEXIST") throw cause; });
  }
  const output = `assets/videoFrames/${crypto.randomUUID()}`;
  const target = (await resolveWorkspacePath(directory, output)).path;
  await mkdir(target);
  try {
    const frames = [];
    // ACT: 最多 24 点依次定位，每张最多 960×960；固定解码参数不开放原始 FFmpeg 权限。
    for (const [index, time] of times.entries()) {
      activeSignal.throwIfAborted();
      const path = `${output}/frame${index}.jpg`;
      let actualTime: number | undefined;
      async function decode(tail = false) {
        actualTime = undefined;
        await new Promise<void>((resolve, reject) => {
          let command: FfmpegCommand;
          const abort = () => { command.kill("SIGKILL"); };
          command = ffmpeg({ timeout: 20 }).input(source).inputOptions([...inputOptions, tail ? `-sseof -${Math.min(1, duration)}` : `-ss ${time}`])
            .outputOptions([`-map 0:${stream!.index}`, "-copyts", "-frames:v 1", "-threads 1", "-an", "-sn", "-dn", "-q:v 3"])
            .videoFilters(`showinfo,${tail ? "reverse," : ""}scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`)
            .on("stderr", line => {
              const pts = /\bpts_time:([-+\d.e]+)\b/i.exec(line);
              if (pts && (tail || actualTime === undefined)) actualTime = Number(pts[1]) - startTime;
            })
            .on("start", () => { if (activeSignal.aborted) command.kill("SIGKILL"); })
            .on("end", () => { activeSignal.removeEventListener("abort", abort); resolve(); })
            .on("error", cause => { activeSignal.removeEventListener("abort", abort); reject(cause); });
          activeSignal.addEventListener("abort", abort, { once: true });
          if (activeSignal.aborted) { activeSignal.removeEventListener("abort", abort); reject(activeSignal.reason); return; }
          command.save(join(directory, path));
        });
        const info = await stat(join(directory, path));
        if (!info.isFile() || !info.size || info.size > 10 * 1024 * 1024) throw new Error("采样图片为空或超过 10 MB");
      }
      try { await decode(); }
      catch (cause) {
        activeSignal.throwIfAborted();
        const info = await stat(join(directory, path)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
        if (actualTime !== undefined || info?.size || time < duration - Math.max(1 / frameRate, 0.1)) throw cause;
        // 只有结束前定位已无后续帧时才补真实末帧，不把任意采样列表的最后一点替换成片尾。
        await decode(true);
      }
      activeSignal.throwIfAborted();
      if (actualTime === undefined || !Number.isFinite(actualTime) || actualTime < 0 || actualTime >= duration) throw new Error("无法核实采样帧的真实时间");
      frames.push({ time: actualTime, path, mimeType: "image/jpeg" as const });
    }
    return { duration, frameRate, width, height, frames };
  } catch (cause) {
    await rm(target, { recursive: true, force: true });
    throw cause;
  }
}
