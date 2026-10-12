import { readFile } from "@toonflow/file";
import { join } from "node:path";
import { runCmd } from "../media-tools.ts";

/** ACT: 一分钟内共用解码；长片每批最多四路定位，避免为稀疏采样解码整部长片。最多 64 点，末帧仅倒序最后一秒。 */
export async function sampleVideoFrames(source: string, directory: string, timestamps: number[], duration: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Number.isFinite(duration) || duration <= 0 || !timestamps.length || timestamps.length > 64
    || timestamps.some(time => !Number.isFinite(time) || time < 0 || time > duration + 0.001)) throw new Error("视频采样时间无效");
  const paths = timestamps.map((_, index) => join(directory, `frame${index}.jpg`));
  const sharedDecode = duration <= 60;
  const batchSize = sharedDecode ? timestamps.length : 4;
  for (let offset = 0; offset < timestamps.length; offset += batchSize) {
    signal?.throwIfAborted();
    const batch = timestamps.slice(offset, offset + batchSize);
    const labels = batch.map((_, index) => `[sample${index}]`);
    const inputs: string[] = sharedDecode ? ["-threads", "2", "-i", source] : [];
    const filters = sharedDecode ? [`[0:v:0]split=${batch.length}${labels.join("")}`] : [];
    const outputs: string[] = [];
    batch.forEach((time, localIndex) => {
      const index = offset + localIndex;
      const tail = index === timestamps.length - 1;
      if (!sharedDecode) inputs.push("-threads", "2", ...(tail ? ["-sseof", String(-Math.min(1, duration))] : ["-ss", String(time)]), "-i", source);
      const selection = sharedDecode ? `${labels[localIndex]}trim=start=${tail ? Math.max(0, duration - 1) : time},${tail ? "" : "select=eq(n\\,0),"}` : `[${localIndex}:v:0]${tail ? "" : "trim=end_frame=1,"}`;
      filters.push(`${selection}scale=w='min(960,iw)':h=-2${tail ? ",reverse" : ""}[frame${index}]`);
      outputs.push("-map", `[frame${index}]`, "-frames:v", "1", "-threads", "1", paths[index]!);
    });
    const result = await runCmd("ffmpeg", ["-v", "error", ...inputs, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), ...outputs], signal);
    signal?.throwIfAborted();
    if (result.code !== 0) throw new Error("视频批量抽帧失败，未生成观察结论");
  }
  return Promise.all(paths.map(async path => ({ data: await readFile(path), mime: "image/jpeg" })));
}
