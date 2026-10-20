import { extname, join } from "node:path";
import { lstatSync, readFileSync } from "@toonflow/file";
import { cloud } from "@/lib/cloud";
import { currentTenant } from "@/utils/tenant";
import { needsLipSync } from "@toonflow/tool-media-generation/runtime";
import { workspaceProject } from "@/utils/media/jobs";
import { voiceProjectSchema } from "@toonflow/tool-media-generation/voiceProject";

const safeFormats = new Set(["wav", "mp3", "flac", "opus", "aac", "adts", "s16le", "s24le", "f32le", "null", "hash", "framehash", "framemd5", "image2", "image2pipe"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"]);
const flagOptions = new Set(["-y", "-n", "-an", "-vn", "-sn", "-dn", "-nostdin", "-hide_banner", "-stats", "-nostats", "-shortest", "-bitexact", "-copyts", "-start_at_zero", "-re"]);

/** 对白项目的自由 FFmpeg 仅供探测、声音准备和静帧；视频交付必须经过领域时间线。 */
export function assertRawSpeechExport(directory: string, args: string[], outputs: string[]) {
  const api = cloud(), tenant = currentTenant();
  const projectId = api && tenant ? workspaceProject(directory, false) : undefined;
  let hasSpeech = !!(api && tenant && projectId && api.scoped(tenant.workspaceId).list("shots", { projectId }).some(shot => shot.creativeBrief?.dialogue?.lines?.length || needsLipSync(shot)));
  if (!hasSpeech) {
    const path = join(directory, "voiceProject.json");
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) throw new Error("配音方案须为工作区内不超过10MB的普通文件");
      hasSpeech = voiceProjectSchema.parse(JSON.parse(readFileSync(path, "utf8"))).lines.length > 0;
    }
  }
  if (!hasSpeech) return;
  const blocked = () => { throw Object.assign(new Error("对白项目的视频输出必须通过已校验的剪辑时间线 render；自由 FFmpeg 仅允许探测、音频准备与静帧，不能绕过对白/口型校验。尚未验收可使用 render options.draft:true。"), { status: 409, code: "speech_export_blocked" }); };
  let format: string | undefined;
  let count = 0;
  // ACT: 保守识别原生单值选项；未知零值选项拒绝而不猜测。原始参数中的额外输出同样拒绝。
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-i") { index++; format = undefined; continue; }
    if (arg === "-f") { format = args[++index]; continue; }
    if (arg.startsWith("-") && arg !== "-") {
      if (!flagOptions.has(arg)) index++;
      continue;
    }
    if (!outputs.includes(arg)) blocked();
    const extension = extname(arg).toLowerCase();
    const actualFormat = format ?? (imageExtensions.has(extension) ? "image2" : extension.slice(1));
    if (!safeFormats.has(actualFormat)) blocked();
    count++;
    format = undefined;
  }
  if (count !== outputs.length) blocked();
}
