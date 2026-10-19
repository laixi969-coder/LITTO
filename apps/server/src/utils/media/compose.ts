import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, rm, writeAtomic } from "@toonflow/file";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkspaceFfmpeg, getStatus } from "@/utils/ffmpeg";
import { inspectFilm } from "@/utils/media/qc";
import { resolveWorkspacePath } from "@/utils/workspace/files";

export interface ComposeFilm {
  /** 高光溢出强度，0-0.25；只作用于高光，不柔化全画面 */
  bloom?: number;
  /** 边缘色差像素，0-3；只在画面边缘可见 */
  aberration?: number;
  /** 颗粒强度，0-12；超过 8 开始发脏 */
  grain?: number;
}

export interface ComposeGrade {
  contrast?: number;
  saturation?: number;
  brightness?: number;
  grain?: number;
}

export interface ComposeRequest {
  directory: string;
  clips: string[];
  output: string;
  grade?: ComposeGrade;
  /** 胶片响应：用高光选择性溢出的方式增加真实感，避免全画面柔化导致发糊 */
  film?: ComposeFilm;
  targetLufs?: number;
  /** 片头片尾的黑场豁免区间，只影响合成后的自检判定 */
  headTail?: { start: number; end: number }[];
  /** 合成后是否自动跑一遍整片自检，默认开启 */
  verify?: boolean;
}

/** 边缘能量：sobel 后的平均亮度，用来判断处理有没有把画面糊掉。 */
async function edgeEnergy(ffmpeg: Awaited<ReturnType<typeof createWorkspaceFfmpeg>>, path: string) {
  const probe = await new Promise<{ format?: { duration?: number | string } }>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(data)));
  const duration = Number(probe.format?.duration ?? 0);
  const { tools } = await getStatus();
  if (!tools.ffmpeg.path) return 0;
  const { stdout } = await promisify(execFile)(tools.ffmpeg.path, [
    "-v", "error", "-ss", String(duration / 2), "-i", path, "-frames:v", "1",
    "-vf", "sobel,signalstats,metadata=print:file=-", "-f", "null", "-",
  ], { maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: "" })) as { stdout: string };
  return Number(/YAVG=([\d.]+)/.exec(stdout)?.[1] ?? 0);
}

/**
 * 把已生成的镜头按顺序合成为一支片子：先 concat 拼轨（不重编码），再统一做一次调色与响度归一。
 * 只编码一次，避免逐段重编码带来的段间黑闪与音量跳变。
 */
export async function composeFilm(cwd: string, request: Pick<ComposeRequest, "clips" | "output" | "grade" | "film" | "targetLufs" | "headTail" | "verify">, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sources = await Promise.all(request.clips.map(clip => resolveWorkspacePath(cwd, clip)));
  const target = await resolveWorkspacePath(cwd, request.output, true);
  await mkdir(dirname(target.path), { recursive: true });
  const workspace = await resolveWorkspacePath(cwd, "assets/.compose", true);
  await mkdir(workspace.path, { recursive: true });
  const token = randomUUID();
  const listPath = join(workspace.path, `${token}.txt`);
  const joinedPath = join(workspace.path, `${token}.mp4`);
  await writeAtomic(listPath, request.clips.map((_, index) => `file '${sources[index]!.path.replace(/'/g, "'\\''")}'`).join("\n"));
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const run = (command: ReturnType<typeof ffmpeg>) => new Promise<void>((resolve, reject) => {
    const cancel = () => command.kill("SIGKILL");
    signal?.addEventListener("abort", cancel, { once: true });
    command.on("error", reject).on("end", () => { signal?.removeEventListener("abort", cancel); resolve(); }).run();
  });
  try {
    await run(ffmpeg().input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).outputOptions(["-c", "copy"]).output(joinedPath));
    const filters: string[] = [];
    if (request.grade) {
      const eq = [
        request.grade.contrast ? `contrast=${request.grade.contrast}` : "",
        request.grade.saturation ? `saturation=${request.grade.saturation}` : "",
        request.grade.brightness ? `brightness=${request.grade.brightness}` : "",
      ].filter(Boolean);
      if (eq.length) filters.push(`eq=${eq.join(":")}`);
      // 颗粒放在调色之后，避免被对比度拉伸放大成全屏噪点。
      if (request.grade.grain) filters.push(`noise=alls=${request.grade.grain}:allf=t`);
    }
    const command = ffmpeg(joinedPath);
    const film = request.film;
    if (film && (film.bloom || film.aberration || film.grain)) {
      // 关键：bloom 只吃高光。曲线先把 0.5 以下压掉，模糊只发生在亮部，暗部细节一点不动。
      const bloom = Math.min(Math.max(film.bloom ?? 0.1, 0), 0.25);
      const aberration = Math.min(Math.max(film.aberration ?? 1, 0), 3);
      const grain = Math.min(Math.max(film.grain ?? 3, 0), 12);
      const chain = [
        `[0:v]${filters.length ? `${filters.join(",")},` : ""}format=yuv420p,split=2[base][hi]`,
        `[hi]curves=all='0/0 0.5/0.45 1/1',gblur=sigma=18[glow]`,
        `[base][glow]blend=all_mode=screen:all_opacity=${bloom.toFixed(2)}[halated]`,
        `[halated]chromashift=cbh=${aberration}:crh=-${aberration},noise=alls=${grain}:allf=t[v]`,
        `[0:a]loudnorm=I=${request.targetLufs ?? -16}:TP=-1.5:LRA=11[a]`,
      ].join(";");
      command.complexFilter(chain);
      // 走 filter_complex 时音频必须显式过一遍 loudnorm，否则会绕过响度归一，成片音量掉到听不见。
      await run(command.outputOptions(["-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]).output(target.path));
    } else {
      if (filters.length) command.videoFilters(filters);
      command.audioFilters([`loudnorm=I=${request.targetLufs ?? -16}:TP=-1.5:LRA=11`]);
      await run(command.outputOptions(["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]).output(target.path));
    }
    const probe = await new Promise<{ format?: { duration?: number | string } }>((resolve, reject) => ffmpeg.ffprobe(target.path, (probeError, data) => probeError ? reject(probeError) : resolve(data)));
    const duration = Number(probe.format?.duration ?? 0);
    // 合成后立即自检：带着缺陷的成片不静默返回成功，报告随结果一起给，避免"以为好了"。
    const qc = request.verify === false ? undefined : await inspectFilm(cwd, request.output, { headTail: request.headTail }, signal).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    // 清晰度守卫：胶片响应做完必须证明没把细节糊掉，边缘能量掉超过 12% 直接标出来。
    const sharpness = request.film
      ? await (async () => {
        const before = await edgeEnergy(ffmpeg, joinedPath).catch(() => 0);
        const after = await edgeEnergy(ffmpeg, target.path).catch(() => 0);
        const drop = before ? Math.round(((before - after) / before) * 100) : 0;
        return { before: Number(before.toFixed(2)), after: Number(after.toFixed(2)), drop, blurred: drop > 12 };
      })()
      : undefined;
    return { path: request.output, duration, clips: request.clips.length, qc, sharpness };
  } finally {
    await rm(listPath, { force: true }).catch(() => undefined);
    await rm(joinedPath, { force: true }).catch(() => undefined);
  }
}
