import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "@toonflow/file";
import { get } from "../db.ts";
import type { Scope } from "../db.ts";
import { storage, sniff, usage } from "../storage.ts";
import { bad, conflict, sha256, ulid } from "../util.ts";
import { referenceCropSchema } from "./schema.ts";
import { ffmpegSync, panoramaRef } from "./panorama.ts";

export function ensureReferenceCrop(s: Scope, projectId: string, referenceId: string, input: unknown) {
  const crop = referenceCropSchema.parse(input);
  const { ref, media } = panoramaRef(s, referenceId);
  if (ref.projectId !== projectId || media.projectId !== projectId) throw bad("裁切参考不属于当前项目");
  const source = `referenceCrop:${sha256(JSON.stringify([media.hash, crop]))}`;
  const cached = get("SELECT id FROM media WHERE workspace_id=? AND project_id=? AND source=? AND deleted_at IS NULL", s.workspaceId, projectId, source);
  if (cached) return cached.id as string;
  if (!storage.getSync || !storage.putSync || !ffmpegSync()) throw bad("当前存储或 FFmpeg 不支持参考裁切");
  // ACT: 沿用同步编译器，裁图缓存复用；单次处理限 30 秒，异步编译后可迁移至媒体队列。
  const directory = mkdtempSync(join(tmpdir(), "littoCrop"));
  try {
    const path = join(directory, "source");
    writeFileSync(path, storage.getSync(media.storageKey));
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path], { timeout: 10000 });
    if (probe.status !== 0) throw bad("无法读取裁切参考尺寸");
    const size = JSON.parse(String(probe.stdout)).streams?.[0];
    if (!size?.width || !size?.height) throw bad("裁切参考缺少尺寸");
    const x = Math.floor(crop.x * (crop.unit === "normalized" ? size.width : 1));
    const y = Math.floor(crop.y * (crop.unit === "normalized" ? size.height : 1));
    const width = Math.floor(crop.width * (crop.unit === "normalized" ? size.width : 1));
    const height = Math.floor(crop.height * (crop.unit === "normalized" ? size.height : 1));
    if (width < 1 || height < 1 || x + width > size.width || y + height > size.height) throw bad("裁切区域超出图片或不足一个像素");
    const output = join(directory, "crop.png");
    const result = spawnSync("ffmpeg", ["-y", "-v", "error", "-noautorotate", "-i", path, "-vf", `crop=${width}:${height}:${x}:${y}:exact=1`, "-frames:v", "1", output], { timeout: 30000 });
    if (result.status !== 0) throw bad("参考裁切失败，未发送原始图片作为替代");
    const png = readFileSync(output);
    const dimensions = sniff(png);
    if (!dimensions || dimensions.width !== width || dimensions.height !== height) throw bad("参考裁切尺寸校验失败");
    const workspace = get("SELECT quota_bytes FROM workspaces WHERE id=?", s.workspaceId);
    if (!workspace || usage(s.workspaceId).bytes + png.length > workspace.quota_bytes) throw conflict("storage quota exceeded", "quota_exceeded");
    const id = ulid();
    const key = `${s.workspaceId}/${projectId}/${id}`;
    storage.putSync(key, png);
    s.insert("media", { id, project_id: projectId, mime: "image/png", size: png.length, hash: sha256(png), width, height, source, storage_key: key });
    return id;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
