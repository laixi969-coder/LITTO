import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import { privateDataDirectory, currentTenant } from "@/utils/tenant";
import { lockWorkspaceFiles } from "@/utils/workspace/files";
import { creativeContext } from "./index";
import { assertPublicHttpUrl } from "@/utils/ssrf";
import type { CreativeReference } from "./types";

const worldId = "alibaba/abot-world-0";
export async function uploadWorldImage(directory: string, image: CreativeReference) {
  const context = creativeContext(directory, "falCreative");
  const media = await context.readMedia(image);
  if (!media.mimeType.startsWith("image/")) throw Object.assign(new Error("世界起点必须是图片"), { status: 400 });
  const bytes = Buffer.from(media.data, "base64");
  if (bytes.length > 30 * 1024 * 1024) throw Object.assign(new Error("世界起点图片不能超过30MB"), { status: 400 });
  const response = await context.fetch("https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
    method: "POST", headers: { Authorization: `Key ${context.config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: media.mimeType, file_name: `world${crypto.randomUUID()}.${media.mimeType.split("/")[1]}` }),
  });
  if (!response.ok) throw new Error(`世界起点上传初始化失败（HTTP ${response.status}）`);
  const data = z.object({ upload_url: z.url().max(8192), file_url: z.url().max(4096) }).parse(await response.json());
  await assertPublicHttpUrl(data.file_url);
  const uploaded = await context.fetch(data.upload_url, { method: "PUT", headers: { "Content-Type": media.mimeType }, body: bytes });
  if (!uploaded.ok) throw new Error(`世界起点上传失败（HTTP ${uploaded.status}）`);
  await uploaded.body?.cancel();
  return data.file_url;
}
const offerSchema = z.strictObject({ app_id: z.literal(worldId), sdp: z.string().min(1).max(100000), type: z.literal("offer") });
type WorldRecord = { status: "opening" | "live" | "uncertain"; directory: string; sessionId?: string; configHash: string; createdAt: string };
function recordPath(directory: string, requestId: string) {
  const tenant = currentTenant();
  return join(privateDataDirectory(), "creativeWorlds", createHash("sha256").update(JSON.stringify([tenant?.workspaceId, tenant?.userId, directory, requestId])).digest("hex") + ".json");
}

/** 窄代理只允许本世界的ICE、一次SDP协商及本账户会话心跳，不开放任意Fal端点或长期Key。 */
export async function proxyWorld(directory: string, requestId: string, target: string, input: unknown, signal?: AbortSignal) {
  z.uuid().parse(requestId);
  let url: URL;
  try { url = new URL(target); } catch { throw Object.assign(new Error("世界协议地址无效"), { status: 400 }); }
  if (url.username || url.password) throw Object.assign(new Error("世界协议地址不能包含凭证"), { status: 400 });
  const iceFallback = url.href === `https://fal.run/${worldId}/ice`;
  if (!iceFallback && (url.origin !== "https://wma.fal.run" || url.search || url.hash || !["/ice", "/session", "/session/heartbeat"].includes(url.pathname))) throw Object.assign(new Error("此代理只允许Abot World实时协议"), { status: 403 });
  const context = creativeContext(directory, "falCreative");
  const apiKey = String(context.config.apiKey).trim().replace(/^Key\s+/i, "");
  const configHash = createHash("sha256").update(apiKey).digest("hex");
  const path = recordPath(directory, requestId);
  const release = lockWorkspaceFiles([path]);
  try {
    let record = await readFile(path, "utf8").then(text => JSON.parse(text) as WorldRecord).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (record && (record.configHash !== configHash || record.directory !== directory)) throw Object.assign(new Error("世界会话凭证已变更"), { status: 409 });
    if (url.pathname === "/session") {
      offerSchema.parse(input);
      if (record) throw Object.assign(new Error("此世界会话已提交；关闭后手动开启新会话，不能自动重放"), { status: 409 });
      record = { status: "opening", directory, configHash, createdAt: new Date().toISOString() };
      await mkdir(dirname(path), { recursive: true });
      await writeAtomic(path, JSON.stringify(record), { exclusive: true });
    } else if (url.pathname === "/session/heartbeat") {
      const body = z.strictObject({ session_id: z.string().min(1).max(300) }).parse(input);
      if (!record?.sessionId || record.sessionId !== body.session_id) throw Object.assign(new Error("世界会话不属于当前请求"), { status: 403 });
    } else if (!iceFallback) z.strictObject({ app_id: z.literal(worldId) }).parse(input);
    else z.strictObject({}).parse(input);
    try {
      const response = await context.fetch(url, { method: "POST", headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]) });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`世界服务请求失败（HTTP ${response.status}）`), { status: 502 }); }
      const text = await response.text();
      if (text.length > 200000) throw new Error("世界服务回执过大");
      const data = JSON.parse(text);
      if (url.pathname === "/session") {
        const answer = z.object({ session_id: z.string().min(1).max(300), sdp: z.string().min(1).max(100000), type: z.literal("answer") }).parse(data);
        record!.sessionId = answer.session_id;
        record!.status = "live";
        await writeAtomic(path, JSON.stringify(record));
        return answer;
      }
      if (url.pathname === "/session/heartbeat") return z.object({ alive: z.boolean() }).passthrough().parse(data);
      // ICE凭证是供应商签发的短期TURN信息，按SDK协议回传，不包含长期Fal Key。
      return z.object({ ice_servers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() })).max(20).optional(), status: z.string().optional(), credential_age_seconds: z.number().optional() }).parse(data);
    } catch (error) {
      if (url.pathname === "/session" && record) { record.status = "uncertain"; await writeAtomic(path, JSON.stringify(record)); }
      throw error;
    }
  } finally { release(); }
}
