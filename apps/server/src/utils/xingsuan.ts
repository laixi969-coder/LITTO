import { createHash } from "node:crypto";
import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { join } from "node:path";
import conf from "@/utils/conf";
import { guardedFetch } from "@/utils/ssrf";
import { privateDataDirectory } from "@/utils/tenant";
import { lockWorkspaceFiles } from "@/utils/workspace/files";

type Group = { account: string; id: string; name: string; assets: { id: string; name: string; type: "Image" | "Video" }[] };

function filePath() { return join(privateDataDirectory(), "xingsuanAssets.json"); }

async function readGroups() {
  const source = await readFile(filePath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value)) throw new Error("星算云素材库记录格式错误");
  return value as Group[];
}

function account() {
  const config = conf.get("settings.mediaProviderConfigs.xingsuan") as { apiKey?: string; baseUrl?: string } | undefined;
  const key = config?.apiKey?.trim().replace(/^Bearer\s+/i, "");
  if (!key) throw Object.assign(new Error("请先连接星算云并填写 API Key"), { status: 400 });
  return createHash("sha256").update(`${(config?.baseUrl?.trim() || "https://xingsuan.cloud/api/v3").replace(/\/+$/, "")}\n${key}`).digest("hex");
}

export async function list() {
  const current = account();
  return (await readGroups()).filter(group => group.account === current).map(({ account: _account, ...group }) => group);
}

async function request(path: string, body?: unknown) {
  const config = conf.get("settings.mediaProviderConfigs.xingsuan") as { apiKey?: string; baseUrl?: string } | undefined;
  const key = config?.apiKey?.trim().replace(/^Bearer\s+/i, "");
  if (!key) throw Object.assign(new Error("请先连接星算云并填写 API Key"), { status: 400 });
  const base = (config?.baseUrl?.trim() || "https://xingsuan.cloud/api/v3").replace(/\/+$/, "");
  const response = await guardedFetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json() as { Result?: { Id?: string; Status?: string; URL?: string }; error?: { message?: string }; ResponseMetadata?: { Error?: { Message?: string } } };
  if (!response.ok || result.error || result.ResponseMetadata?.Error) throw Object.assign(new Error(result.error?.message || result.ResponseMetadata?.Error?.Message || `星算云请求失败（HTTP ${response.status}）`), { status: 502 });
  if (!result.Result || typeof result.Result !== "object") throw new Error("星算云返回的素材信息无效");
  return result.Result;
}

export async function createGroup(name: string, description: string, supplier?: "default" | "byteplus") {
  const path = filePath();
  await mkdir(privateDataDirectory(), { recursive: true });
  const release = lockWorkspaceFiles([path]);
  try {
    const current = account();
    const groups = await readGroups();
    const result = await request(supplier === "byteplus" ? "/byteplus/asset-groups" : "/asset-groups", { Name: name, Description: description });
    if (!result.Id) throw new Error("星算云未返回素材组 ID");
    groups.push({ account: current, id: result.Id, name, assets: [] });
    try { await writeAtomic(path, JSON.stringify(groups, null, 2)); }
    catch (error) { throw new Error(`素材组已在星算云创建，ID 为 ${result.Id}，但本地记录保存失败：${String(error)}`); }
    return list();
  } finally { release(); }
}

export async function createAsset(groupId: string, name: string, url: string, type: "Image" | "Video") {
  const path = filePath();
  const release = lockWorkspaceFiles([path]);
  try {
    const groups = await readGroups();
    const current = account();
    const group = groups.find(item => item.account === current && item.id === groupId);
    if (!group) throw Object.assign(new Error("找不到素材组"), { status: 404 });
    const result = await request("/assets", { GroupId: groupId, Name: name, URL: url, AssetType: type });
    if (!result.Id) throw new Error("星算云未返回素材 ID");
    group.assets.push({ id: result.Id, name, type });
    try { await writeAtomic(path, JSON.stringify(groups, null, 2)); }
    catch (error) { throw new Error(`素材已在星算云创建，ID 为 ${result.Id}，但本地记录保存失败：${String(error)}`); }
    return result;
  } finally { release(); }
}

export async function getAsset(id: string) {
  const groups = await list();
  if (!groups.some(group => group.assets.some(asset => asset.id === id))) throw Object.assign(new Error("找不到素材"), { status: 404 });
  return request(`/assets/${encodeURIComponent(id)}`);
}
