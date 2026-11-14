import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, lstat, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";
import { cloud } from "@/lib/cloud";
import { authEnabled, currentTenant, privateDataDirectory } from "@/utils/tenant";
import { guardedFetch, assertPublicHttpUrl } from "@/utils/ssrf";
import { readReference, detectMimeType } from "@/utils/media/generation";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { describeRunningHub, submitRunningHub, pollRunningHub, cancelRunningHub, validateRunningHub } from "./runningHub";
import { describeFal, submitFal, pollFal, cancelFal, validateFalInput, falEndpoint } from "./fal";
import type { CreativeContext, CreativeHandle, CreativeInput, CreativePoll } from "./types";

const referenceSchema = z.strictObject({ path: z.string().min(1).max(4096), mimeType: z.string().regex(/^(image|video|audio)\/[\w.+-]+$/) });
export const inputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("runningHub"), mode: z.enum(["app", "workflow"]), workflowId: z.string().regex(/^\d{1,32}$/), fields: z.array(z.strictObject({ nodeId: z.string().min(1).max(100), fieldName: z.string().min(1).max(200), value: z.union([z.string().max(50000), z.number().finite(), z.boolean(), referenceSchema]) })).max(500) }),
  z.strictObject({ operation: z.enum(["mesh", "upscale", "texture"]), image: referenceSchema, options: z.record(z.string(), z.json()) }),
]);
export const providerSchema = z.enum(["runningHub", "falCreative"]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function assertCreativeAccess() {
  if (!authEnabled()) return;
  const tenant = currentTenant();
  if (!tenant || tenant.role === "VIEWER") throw Object.assign(new Error("无权生成或处理工作区素材"), { status: 403 });
  cloud()?.requireModelAccess(tenant.userId);
}

function providerConfig(providerId: string) {
  providerSchema.parse(providerId);
  const configs = conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  const config = configs?.[providerId] ?? {};
  if (typeof config.apiKey !== "string" || !config.apiKey.trim()) throw Object.assign(new Error("请先配置此创作工具的 API Key"), { status: 400 });
  return config;
}

export function creativeProviders() {
  const configs = conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  return [
    { id: "runningHub", label: "RunningHub 动态工作流", operations: ["runningHub"], configured: !!configs?.runningHub?.apiKey },
    { id: "falCreative", label: "Fal 专用创作工具", operations: ["mesh", "upscale", "texture", "world"], configured: !!configs?.falCreative?.apiKey },
  ];
}

export async function saveCreativeConfig(providerId: "runningHub" | "falCreative", apiKey: string, baseUrl?: string) {
  const address = baseUrl?.trim();
  if (providerId === "falCreative" && address && address.replace(/\/$/, "") !== "https://queue.fal.run") throw Object.assign(new Error("Fal 专用工具只使用官方队列地址"), { status: 400 });
  if (/[\r\n]/.test(apiKey)) throw Object.assign(new Error("API Key 不能包含换行"), { status: 400 });
  if (address) {
    const url = await assertPublicHttpUrl(address, { strictDns: false });
    if (url.search || url.hash || url.pathname !== "/") throw Object.assign(new Error("API 地址只填写服务根地址"), { status: 400 });
  }
  // 沿用平台模型权限与加密配置入口；凭证不进入节点数据和画布文件。
  const previous = conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  conf.set("settings.mediaProviderConfigs", { ...previous, [providerId]: { ...previous?.[providerId], apiKey: apiKey.trim(), ...(address ? { baseUrl: address.replace(/\/$/, "") } : {}) } });
  return creativeProviders().find(provider => provider.id === providerId)!;
}

export function creativeContext(directory: string, providerId: string): CreativeContext {
  const config = structuredClone(providerConfig(providerId));
  return {
    config,
    fetch: (input, init) => guardedFetch(input, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(120000) }),
    readMedia: reference => readReference(directory, reference, reference.mimeType.split("/")[0]!),
  };
}

export async function describeCreative(directory: string, providerId: string, input: { operation: CreativeInput["operation"]; mode?: "app" | "workflow"; workflowId?: string }) {
  assertProviderOperation(providerId, input.operation);
  const context = creativeContext(directory, providerId);
  if (input.operation !== "runningHub") return describeFal().find(description => description.operation === input.operation)!;
  return describeRunningHub(context, { operation: "runningHub", mode: input.mode!, workflowId: input.workflowId!, fields: [] });
}

function assertProviderOperation(providerId: string, operation: string) {
  if ((operation === "runningHub" ? "runningHub" : "falCreative") !== providerId) throw Object.assign(new Error("所选连接不支持此工具"), { status: 400 });
}

type CreativeTask = {
  requestId: string;
  status: "submitting" | "pending" | "completed" | "failed" | "cancelled" | "uncertain";
  directory: string;
  owner: string;
  providerId: string;
  configHash: string;
  input: CreativeInput;
  inputHash: string;
  folder: string;
  handle?: CreativeHandle;
  files?: { path: string; mimeType: string; name?: string }[];
  error?: string;
  createdAt: string;
};

function ownerKey() { return `${currentTenant()?.workspaceId ?? "local"}:${currentTenant()?.userId ?? "local"}`; }
function taskPath(directory: string, requestId: string, owner = ownerKey()) {
  z.uuid().parse(requestId);
  return join(privateDataDirectory(), "creativeTasks", digest([owner, directory, requestId]) + ".json");
}
function publicTask(task: CreativeTask) {
  return { requestId: task.requestId, status: task.status, files: task.files, error: task.error, handle: task.handle && { id: task.handle.id, provider: task.handle.provider }, createdAt: task.createdAt };
}
async function saveTask(path: string, task: CreativeTask, exclusive = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, JSON.stringify(task, null, 2), { exclusive });
}
async function readTask(path: string, directory: string, owner = ownerKey()): Promise<CreativeTask> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("创作任务不存在，请核对原账户、项目与请求号"), { code: "ENOENT", status: 404 });
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new Error("创作任务记录无效");
  const task: CreativeTask = JSON.parse(await readFile(path, "utf8"));
  if (task.owner !== owner || task.directory !== directory) throw Object.assign(new Error("创作任务不属于当前工作区或账户"), { status: 403 });
  return task;
}
function safeError(error: unknown, config: Record<string, unknown>) {
  let message = error instanceof Error ? error.message : "创作任务失败";
  for (const [key, value] of Object.entries(config)) if (/key|secret|token|password/i.test(key) && typeof value === "string" && value) message = message.replaceAll(value, "••••••");
  return message.replace(/([?&][^=\s&]+)=[^\s&]+/g, "$1=••••••").slice(0, 2000);
}

export async function startCreative(directory: string, providerId: string, requestId: string, input: CreativeInput) {
  assertProviderOperation(providerId, input.operation);
  const context = creativeContext(directory, providerId);
  if (input.operation !== "runningHub") validateFalInput(input);
  const path = taskPath(directory, requestId);
  const release = lockWorkspaceFiles([path]);
  try {
    const existing = await readTask(path, directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (existing) {
      if (existing.inputHash !== digest([providerId, input])) throw Object.assign(new Error("此请求号已用于其他参数，请新建请求"), { status: 409 });
      return publicTask(existing);
    }
    if (input.operation === "runningHub") await validateRunningHub(context, input);
    else await context.readMedia(input.image);
    // ACT: 远端提交前先落盘。进程中断或提交回执丢失时不重发收费请求，可手动绑定原远端任务号恢复。
    const task: CreativeTask = { requestId, status: "submitting", directory, owner: ownerKey(), providerId, configHash: digest(context.config), input, inputHash: digest([providerId, input]), folder: `assets/creativeTasks/${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
    await saveTask(path, task, true);
    try {
      task.handle = input.operation === "runningHub" ? await submitRunningHub(context, input) : await submitFal(context, input);
      task.status = "pending";
      await saveTask(path, task);
    } catch (error) {
      task.status = task.handle ? "pending" : "uncertain";
      if (!task.handle && ((error as { status?: number }).status === 400 || (error as { definitive?: boolean }).definitive)) task.status = "failed";
      task.error = safeError(error, context.config);
      await saveTask(path, task);
    }
    return publicTask(task);
  } finally { release(); }
}

async function downloadCreativeAssets(directory: string, folder: string, assets: NonNullable<CreativePoll["assets"]>) {
  if (!assets.length || assets.length > 32) throw new Error("创作任务返回的文件数须为 1 到 32");
  const files: NonNullable<CreativeTask["files"]> = [];
  let batchSize = 0;
  for (const [index, asset] of assets.entries()) {
    const response = await guardedFetch(asset.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`下载创作结果失败（HTTP ${response.status}）`);
    // ACT: 单个3D文件至多256MB、整个批次至多512MB，流式读取时再次计数，不能信任Content-Length。
    const maxSize = 256 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maxSize) { await response.body.cancel(); throw new Error("创作结果超过256MB"); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        batchSize += next.value.byteLength;
        if (size > maxSize || batchSize > 512 * 1024 * 1024) throw new Error("创作结果超过单文件256MB或批次512MB限制");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    const glb = bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "glTF";
    const detected = detectMimeType(bytes, "");
    const mimeType = glb ? "model/gltf-binary" : detected ? detectMimeType(bytes, asset.mimeType ?? "") : "application/octet-stream";
    const expectedType = asset.mimeType?.split("/")[0];
    if (expectedType && ["image", "video", "audio"].includes(expectedType) && !mimeType.startsWith(`${expectedType}/`)
      || asset.mimeType === "model/gltf-binary" && !glb) throw new Error("创作结果实际类型与供应商回执不符，未作为成功素材保存");
    const extension = ({ "model/gltf-binary": "glb", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg", "audio/aac": "aac", "audio/mp4": "m4a", "audio/webm": "webm", "audio/opus": "opus", "application/octet-stream": "bin" } as Record<string, string>)[mimeType];
    if (!bytes.length || !extension) throw new Error("创作结果为空或类型无效");
    if (glb && (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length)) throw new Error("GLB文件头或长度无效");
    const relativePath = `${folder}/result${index + 1}.${extension}`;
    const target = await resolveWorkspacePath(directory, relativePath, true);
    const release = lockWorkspaceFiles([target.path]);
    try {
      await mkdir(dirname(target.path), { recursive: true });
      try { await writeWorkspaceFile(target.path, bytes, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(target.path);
        if (!info.isFile() || info.size !== bytes.length) throw Object.assign(new Error("原任务输出已被修改，已保留本地素材"), { status: 409 });
        const saved = await readFile(target.path);
        if (!saved.equals(bytes)) throw Object.assign(new Error("原任务此位置已有不同文件，已保留原素材；请核对供应商结果和本地修改"), { status: 409 });
      }
    } finally { release(); }
    files.push({ path: relativePath, mimeType, ...(asset.name ? { name: asset.name.slice(0, 200) } : {}) });
  }
  return files;
}

export async function inspectCreative(directory: string, requestId: string, cancel = false) {
  const path = taskPath(directory, requestId);
  const release = lockWorkspaceFiles([path]);
  try {
    const task = await readTask(path, directory);
    if (["completed", "failed", "cancelled"].includes(task.status)) return publicTask(task);
    if (!task.handle) {
      task.status = "uncertain";
      task.error ||= "提交结果未知；请从供应商控制台取得原任务号后恢复，勿重复提交";
      await saveTask(path, task);
      return publicTask(task);
    }
    const context = creativeContext(directory, task.providerId);
    if (digest(context.config) !== task.configHash) throw Object.assign(new Error("连接凭证或地址已变更，请恢复原配置后查询原任务"), { status: 409 });
    if (cancel) {
      if (task.handle.provider === "fal") await cancelFal(context, task.handle); else await cancelRunningHub(context, task.handle);
      task.status = "cancelled";
      delete task.error;
    } else {
      try {
        const result = task.handle.provider === "fal" ? await pollFal(context, task.handle) : await pollRunningHub(context, task.handle);
        task.status = result.status;
        if (result.status === "failed") task.error = safeError(new Error(result.error || "远端任务失败"), context.config);
        else if (result.status === "completed") { task.files = await downloadCreativeAssets(directory, task.folder, result.assets ?? []); delete task.error; }
      } catch (error) {
        task.status = "pending";
        task.error = safeError(error, context.config);
      }
    }
    await saveTask(path, task);
    return publicTask(task);
  } finally { release(); }
}

export async function recoverCreative(directory: string, requestId: string, remoteId: string, ownerId?: string) {
  // 共享平台Key下，本地请求归属不能证明手填远端ID的归属；沿用凭证管理权限。
  const tenant = currentTenant();
  if (authEnabled() && (!tenant || !cloud()?.modelPermissions(tenant.userId).canManage)) throw Object.assign(new Error("请由供应商凭证管理员核对原任务号后恢复"), { status: 403 });
  const owner = authEnabled() && ownerId ? `${tenant!.workspaceId}:${ownerId}` : ownerKey();
  const path = taskPath(directory, requestId, owner);
  const release = lockWorkspaceFiles([path]);
  try {
    const task = await readTask(path, directory, owner);
    if (task.handle || !["submitting", "uncertain"].includes(task.status)) throw Object.assign(new Error("仅提交回执不明的任务可绑定原任务号"), { status: 409 });
    const context = creativeContext(directory, task.providerId);
    if (digest(context.config) !== task.configHash) throw Object.assign(new Error("请先恢复此任务原连接配置"), { status: 409 });
    const runningHub = task.input.operation === "runningHub";
    if (runningHub ? !/^\d{1,64}$/.test(remoteId) : !z.uuid().safeParse(remoteId).success) throw Object.assign(new Error("远端任务号格式无效"), { status: 400 });
    task.handle = {
      id: remoteId,
      provider: runningHub ? "runningHub" : "fal",
      endpoint: runningHub ? new URL(String(context.config.baseUrl || "https://www.runninghub.ai")).origin : falEndpoint(task.input as Exclude<CreativeInput, { operation: "runningHub" }>),
      metadata: task.input.operation === "runningHub" ? { mode: task.input.mode, workflowId: task.input.workflowId } : { operation: task.input.operation },
    };
    task.status = "pending";
    delete task.error;
    await saveTask(path, task);
    return publicTask(task);
  } finally { release(); }
}
