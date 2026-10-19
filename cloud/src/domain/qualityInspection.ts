import { mkdtemp, writeFile, rm } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "../db.ts";
import { storage } from "../storage.ts";
import { probeFile, runCmd } from "../media-tools.ts";
import { notFound, sha256 } from "../util.ts";
import { qualityReviewPlan } from "@toonflow/tool-media-generation/runtime";

const pending = new Map<string, Promise<any>>();
const slots = [Promise.resolve(), Promise.resolve()];
let nextSlot = 0;

/** ACT: 两路独立本地检测，不占供应商队列、不调用模型。结果落盘；进程退出后按同一素材恢复，不自动重试失败检测。 */
export function inspectProductionQuality(s: Scope, projectId: string, type: "keyframe" | "take", id: string) {
  const table = type === "take" ? "takes" : "keyframes";
  const item = s.get(table, id);
  const shot = item && s.get("shots", item.shotId);
  const media = item && s.get("media", item.mediaId);
  if (!item || !shot || !media || [item, shot, media].some(row => row.projectId !== projectId)) throw notFound("project output");
  const key = sha256(JSON.stringify(["basicQuality1", media.id, media.hash]));
  const cached = item.meta?.basicQuality;
  if (cached?.key === key) return Promise.resolve({ ...cached, reused: true, plan: qualityReviewPlan(shot, type) });
  const pendingKey = `${s.workspaceId}:${type}:${id}:${key}`;
  if (pending.has(pendingKey)) return pending.get(pendingKey)!;
  const slot = nextSlot++ % slots.length;
  const task = slots[slot]!.then(async () => {
    const directory = await mkdtemp(join(tmpdir(), "milimiliQuality"));
    let result: Record<string, any>;
    try {
      const bytes = await storage.get(media.storageKey);
      if (sha256(bytes) !== media.hash) throw new Error("素材内容与存储记录不一致，停止检查");
      const source = join(directory, "source");
      await writeFile(source, bytes);
      const probe = await probeFile(source);
      if (!probe?.hasVideo || !probe.width || !probe.height || type === "take" && (!probe.duration || probe.duration <= 0)) throw new Error("无法读取有效画面、尺寸或时长");
      const decoded = await runCmd("ffmpeg", ["-v", "info", "-xerror", "-threads", "2", "-i", source,
        ...(type === "take" ? ["-vf", "scale=320:-2,blackdetect=d=0.5:pix_th=0.02"] : ["-frames:v", "1"]), "-an", "-f", "null", "-"], AbortSignal.timeout(120000));
      if (decoded.code !== 0) throw new Error("解码检测失败或超时，保留原片，需查看文件");
      const blackSegments = [...decoded.err.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)]
        .map(match => ({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) }));
      result = { key, mediaId: media.id, hash: media.hash, status: "checked", checkedAt: new Date().toISOString(), ...probe, blackSegments };
    } catch (error) {
      result = { key, mediaId: media.id, hash: media.hash, status: "error", checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    } finally { await rm(directory, { recursive: true, force: true }); }
    const current = s.get(table, id);
    if (!current || current.mediaId !== media.id) throw new Error("检查期间素材已变更，未写入旧结果");
    s.update(table, id, { meta: { ...current.meta, basicQuality: result } });
    return { ...result, reused: false, plan: qualityReviewPlan(s.get("shots", item.shotId)!, type) };
  });
  slots[slot] = task.then(() => {}, () => {});
  pending.set(pendingKey, task);
  void task.finally(() => pending.delete(pendingKey)).catch(() => {});
  return task;
}

export function productionQualityView(s: Scope, projectId: string) {
  return (["keyframe", "take"] as const).flatMap(type => s.list(type === "take" ? "takes" : "keyframes", { projectId }).map(item => {
    const shot = s.get("shots", item.shotId)!;
    const basic = item.meta?.basicQuality;
    const media = s.get("media", item.mediaId);
    const current = basic?.key === sha256(JSON.stringify(["basicQuality1", media?.id, media?.hash]));
    const warnings: string[] = [];
    if (current && basic.status === "checked") {
      if (basic.blackSegments?.length) warnings.push("检测到持续黑场，请确认是否为有意设计");
      if (type === "take" && basic.duration + 0.15 < shot.duration) warnings.push("素材短于计划使用时长");
      const resolution = item.meta?.parameters?.request?.resolution ?? item.meta?.parameters?.resolution;
      const side = Number(/^(\d+)p$/i.exec(resolution ?? "")?.[1]);
      if (side && Math.min(basic.width, basic.height) < side) warnings.push("源片实际尺寸低于请求分辨率");
    }
    return { targetType: type, targetId: item.id, shotId: shot.id, shotOrder: shot.ord, plan: qualityReviewPlan(shot, type),
      basic: current ? basic : null, warnings, automaticApproval: false };
  }));
}
