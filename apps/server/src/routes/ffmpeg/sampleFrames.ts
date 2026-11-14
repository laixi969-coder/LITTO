import { Router } from "express";
import { z } from "zod";
import { rm } from "@toonflow/file";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { authEnabled, currentTenant } from "@/utils/tenant";
import u from "@/utils";

const inputSchema = z.strictObject({
  directory: z.string().min(1).max(4096), requestId: z.uuid().optional(), cancel: z.boolean().optional(),
  path: z.string().min(1).max(4096).optional(), count: z.number().int().min(1).max(24).optional(),
  timestamps: z.array(z.number().finite().nonnegative()).min(1).max(24).optional(),
}).superRefine((input, ctx) => {
  if (input.cancel ? !input.requestId || input.path !== undefined || input.count !== undefined || input.timestamps !== undefined : !input.path || input.count !== undefined && input.timestamps !== undefined) {
    ctx.addIssue({ code: "custom", message: "取消须提供 requestId；采样须提供 path，count 与 timestamps 不能同时指定" });
  }
});
const requests = new Map<string, AbortController>();
const cancellations = new Map<string, number>();
type CompletedBatch = { directory: string; folder: string };
const completed = new Map<string, CompletedBatch>();

async function removeBatch(requestKey: string, batch: CompletedBatch) {
  const target = (await u.workspaceFile.resolveWorkspacePath(batch.directory, batch.folder)).path;
  await rm(target, { recursive: true, force: true });
  if (completed.get(requestKey) === batch) completed.delete(requestKey);
}

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(error("采样参数无效", parsed.error.issues));
  const input = parsed.data;
  const tenant = currentTenant();
  if (authEnabled() && (!tenant || tenant.role === "VIEWER")) throw Object.assign(new Error("无权处理工作区视频"), { status: 403 });
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  const requestKey = `${tenant?.workspaceId ?? "local"}\0${tenant?.userId ?? "local"}\0${directory}\0${input.requestId ?? crypto.randomUUID()}`;
  if (input.cancel) {
    const active = requests.get(requestKey);
    if (active) active.abort();
    const batch = completed.get(requestKey);
    if (batch) await removeBatch(requestKey, batch);
    if (!active) {
      // ACT: 保留最多 256 个十秒取消标记，覆盖取消先于原请求到达的网络时序。
      const expires = Date.now() + 10000;
      cancellations.set(requestKey, expires);
      if (cancellations.size > 256) cancellations.delete(cancellations.keys().next().value!);
      setTimeout(() => { if (cancellations.get(requestKey) === expires) cancellations.delete(requestKey); }, 10000).unref();
    }
    return res.json(success());
  }
  if (completed.has(requestKey)) return res.status(409).json(error("采样请求已完成，请使用新的 requestId", null, 409));
  const cancelledUntil = cancellations.get(requestKey);
  if (cancelledUntil) {
    cancellations.delete(requestKey);
    if (cancelledUntil > Date.now()) return res.status(409).json(error("采样请求已取消", null, 409));
  }
  if (requests.has(requestKey)) return res.status(409).json(error("采样请求已在执行", null, 409));
  const controller = new AbortController();
  requests.set(requestKey, controller);
  const close = () => controller.abort();
  res.once("close", close); req.once("aborted", close); req.socket.once("close", close);
  let batch: CompletedBatch | undefined;
  try {
    const result = await u.ffmpeg.sampleFrames(directory, { path: input.path!, count: input.count, timestamps: input.timestamps }, controller.signal);
    const folder = /^assets\/videoFrames\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\//i.exec(result.frames[0]?.path ?? "")?.[0].slice(0, -1);
    if (!folder || result.frames.some(frame => !frame.path.startsWith(`${folder}/`) || !/^frame\d+\.jpg$/.test(frame.path.slice(folder.length + 1)))) throw new Error("采样输出目录无效");
    batch = { directory, folder };
    if (input.requestId) {
      // ACT: 最多记录 256 个成功批次的归属 125 秒；仅用于接收响应末端的取消，过期不删除已选用素材。
      completed.set(requestKey, batch);
      if (completed.size > 256) completed.delete(completed.keys().next().value!);
      const saved = batch;
      setTimeout(() => { if (completed.get(requestKey) === saved) completed.delete(requestKey); }, 125000).unref();
    }
    controller.signal.throwIfAborted();
    res.json(success(result));
  } catch (cause) {
    if (controller.signal.aborted && batch) await removeBatch(requestKey, batch);
    if (controller.signal.aborted && !res.destroyed) return res.status(409).json(error("视频采样已取消", null, 409));
    throw cause;
  } finally {
    if (requests.get(requestKey) === controller) requests.delete(requestKey);
    res.off("close", close); req.off("aborted", close); req.socket.off("close", close);
  }
});
