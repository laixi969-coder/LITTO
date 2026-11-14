import type { CreativeContext, CreativeDescription, CreativeField, CreativeHandle, CreativePoll, CreativeReference, RunningHubInput } from "@/utils/creative/types";

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400, definitive: true });
}

function connection(context: CreativeContext) {
  const apiKey = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!apiKey) invalid("请先配置 RunningHub API Key");
  let url: URL;
  try { url = new URL(String(context.config.baseUrl || "https://www.runninghub.ai")); }
  catch { return invalid("RunningHub API 地址无效"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") invalid("RunningHub API 地址须为不含路径、凭据和查询参数的 HTTP 地址");
  return { apiKey, endpoint: url.origin };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function failure(context: CreativeContext, result: Record<string, unknown>) {
  const key = connection(context).apiKey;
  return String(result.msg || result.message || `RunningHub 返回错误 ${result.code ?? "unknown"}`)
    .replaceAll(key, "••••••").replaceAll(encodeURIComponent(key), "••••••").slice(0, 2000);
}

async function request(context: CreativeContext, path: string, body?: Record<string, unknown>, query?: Record<string, string>) {
  const { endpoint, apiKey } = connection(context);
  const url = new URL(path, endpoint);
  if (query) for (const [key, value] of Object.entries({ ...query, apiKey })) url.searchParams.set(key, value);
  const response = await context.fetch(url, {
    method: query ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${apiKey}`, ...(query ? {} : { "Content-Type": "application/json" }) },
    ...(query ? {} : { body: JSON.stringify({ ...body, apiKey }) }),
  }).catch(() => { throw Object.assign(new Error("RunningHub 请求未取得响应，请检查连接；提交结果未知时不要重新提交"), { status: 502 }); });
  if (!response.ok) throw Object.assign(new Error(`RunningHub 请求失败（HTTP ${response.status}）`), { status: 502 });
  const result = await response.json().catch(() => { throw Object.assign(new Error("RunningHub 响应不是有效 JSON"), { status: 502 }); });
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof Reflect.get(result, "code") !== "number") throw Object.assign(new Error("RunningHub 响应格式无效"), { status: 502 });
  return result as Record<string, unknown>;
}

function successful(context: CreativeContext, result: Record<string, unknown>) {
  if (result.code !== 0) throw Object.assign(new Error(failure(context, result)), { status: 400, definitive: true });
  return result.data;
}

function parsed(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { invalid("RunningHub 返回的字段定义不是有效 JSON"); }
}

function credentialField(name: string) {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return /(?:^|[_.-])(?:api_?key|access_?key|secret(?:_?key)?|password|authorization|(?:access|refresh|auth)?_?token|credentials?)(?:$|[_.-])/i.test(normalized);
}

function appField(raw: Record<string, unknown>): CreativeField {
  const nodeId = String(raw.nodeId ?? ""), fieldName = String(raw.fieldName ?? "");
  if (!nodeId || !fieldName) invalid("RunningHub 应用字段缺少节点 ID 或参数名");
  const remoteType = String(raw.fieldType ?? "").toUpperCase();
  const types: Record<string, CreativeField["type"]> = { STRING: "string", INT: "number", FLOAT: "number", NUMBER: "number", BOOLEAN: "boolean", BOOL: "boolean", IMAGE: "image", VIDEO: "video", AUDIO: "audio", LIST: "string" };
  const type = types[remoteType];
  if (!type) invalid(`RunningHub 参数 ${nodeId}.${fieldName} 使用尚未支持的字段类型`);
  let value = raw.fieldValue;
  if (type === "number" && typeof value === "string" && value.trim()) value = Number(value);
  if (type === "boolean" && (value === "true" || value === "false")) value = value === "true";
  const field: CreativeField = { nodeId, fieldName, label: String(raw.description || raw.descriptionEn || `${raw.nodeName || nodeId} · ${fieldName}`), type,
    required: raw.required === true || ["image", "video", "audio"].includes(type) && !value };
  if (remoteType === "INT") { field.integer = true; field.step = 1; }
  if (["string", "number", "boolean"].includes(typeof value) && (typeof value !== "number" || Number.isFinite(value))) field.value = value as string | number | boolean;
  if (remoteType === "LIST") {
    const data = parsed(raw.fieldData);
    const choices = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : data;
    if (!Array.isArray(choices)) invalid(`RunningHub 参数 ${nodeId}.${fieldName} 没有有效选项`);
    field.options = [...new Set(choices.flatMap(item => {
      const option = typeof item === "string" || typeof item === "number" ? item : record(item).index;
      return typeof option === "string" || typeof option === "number" ? [String(option)] : [];
    }))];
    if (!field.options.length) invalid(`RunningHub 参数 ${nodeId}.${fieldName} 没有有效选项`);
    if (value !== undefined) field.value = String(value);
  }
  return field;
}

export async function describeRunningHub(context: CreativeContext, input: RunningHubInput): Promise<CreativeDescription> {
  if (!["app", "workflow"].includes(input.mode) || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workflowId)) invalid("请选择应用或工作流，并填写有效 ID");
  if (input.mode === "app") {
    const data = record(successful(context, await request(context, "/api/webapp/apiCallDemo", undefined, { webappId: input.workflowId })));
    if (!Array.isArray(data.nodeInfoList)) invalid("RunningHub 没有返回可编辑的应用字段");
    return { label: typeof data.webappName === "string" ? data.webappName : undefined, fields: data.nodeInfoList.filter(item => !credentialField(String(record(item).fieldName ?? ""))).map(item => appField(record(item))) };
  }
  const data = record(successful(context, await request(context, "/api/openapi/getJsonApiFormat", { workflowId: input.workflowId })));
  const prompt = parsed(data.prompt);
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) invalid("RunningHub 没有返回 API 格式工作流");
  const fields: CreativeField[] = [];
  for (const [nodeId, item] of Object.entries(prompt)) {
    const node = record(item), inputs = record(node.inputs), className = String(node.class_type ?? "");
    if (!className) invalid("工作流节点缺少 class_type，不能把编辑器布局当成 API 工作流");
    for (const [fieldName, value] of Object.entries(inputs)) {
      if (credentialField(fieldName)) continue;
      // ACT: API 导出只声明当前原始值；连接数组和结构化私有输入保留在远端，不猜控件或改接线。
      if (!["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) continue;
      let type = typeof value as "string" | "number" | "boolean" | "image" | "video" | "audio";
      const media = /load.*(image|audio|video)/i.exec(className)?.[1]?.toLowerCase() as "image" | "audio" | "video" | undefined;
      if (media && /^(image|audio|video)(_(path|file))?$|^(path|file|filename)$/i.test(fieldName)) type = media;
      fields.push({ nodeId, fieldName, label: `${record(node._meta).title || className} · ${fieldName}`, type, value: value as string | number | boolean, required: !!media && type === media && !value });
    }
  }
  return { label: `ComfyUI · ${input.workflowId}`, fields };
}

const mediaExtensions: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/x-flac": "flac",
  "video/mp4": "mp4", "video/x-msvideo": "avi", "video/quicktime": "mov", "video/x-matroska": "mkv",
};

async function readMedia(context: CreativeContext, value: CreativeReference, type: CreativeField["type"]) {
  if (!value || typeof value.path !== "string" || typeof value.mimeType !== "string") invalid("媒体参数须选择工作区文件");
  const media = await context.readMedia(value);
  if (!media.mimeType.startsWith(`${type}/`) || !mediaExtensions[media.mimeType]) invalid("媒体文件实际类型与参数要求不匹配，或 RunningHub 不支持该格式");
  const data = media.data.replace(/^data:[^,]+,/, "").replace(/\s/g, "");
  if (!data || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) invalid("媒体文件没有有效的 Base64 内容");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) invalid("RunningHub 上传文件不能为空或超过 30 MB");
  return { bytes, mimeType: media.mimeType };
}

export async function validateRunningHub(context: CreativeContext, input: RunningHubInput): Promise<RunningHubInput> {
  try {
    const description = await describeRunningHub(context, input);
    const supplied = new Map<string, RunningHubInput["fields"][number]["value"]>();
    for (const field of input.fields) {
      const key = JSON.stringify([field.nodeId, field.fieldName]);
      if (supplied.has(key) || !description.fields.some(item => item.nodeId === field.nodeId && item.fieldName === field.fieldName)) invalid("存在重复或不属于当前工作流的参数，请重新载入字段");
      supplied.set(key, field.value);
    }
    const fields: RunningHubInput["fields"] = [];
    for (const field of description.fields) {
      let value = supplied.has(JSON.stringify([field.nodeId, field.fieldName])) ? supplied.get(JSON.stringify([field.nodeId, field.fieldName])) : field.value;
      if (value === undefined || typeof value === "string" && !value.trim()) {
        if (field.required) invalid(`请填写 ${field.label}`);
        if (value === undefined) continue;
      }
      if (["image", "video", "audio"].includes(field.type)) {
        if (typeof value === "object" && value) {
          const media = await readMedia(context, value, field.type);
          value = { ...value, mimeType: media.mimeType };
        }
        else if (typeof value !== "string" || value !== field.value) invalid(`${field.label} 须选择工作区媒体`);
      } else if (typeof value !== field.type || typeof value === "number" && !Number.isFinite(value)) invalid(`${field.label} 的参数类型不正确`);
      if (field.integer && !Number.isSafeInteger(value)) invalid(`${field.label} 必须为安全整数`);
      if (field.options && !field.options.includes(String(value))) invalid(`${field.label} 不在当前允许的选项范围内`);
      fields.push({ nodeId: field.nodeId, fieldName: field.fieldName, value: value! });
    }
    return { ...input, fields };
  } catch (cause) {
    if (cause && typeof cause === "object") Object.assign(cause, { definitive: true });
    throw cause;
  }
}

export async function submitRunningHub(context: CreativeContext, input: RunningHubInput): Promise<CreativeHandle> {
  const normalized = await validateRunningHub(context, input);
  const nodeInfoList = [];
  try {
    for (const field of normalized.fields) {
      let fieldValue = field.value;
      if (typeof fieldValue === "object") {
        const media = await readMedia(context, fieldValue, fieldValue.mimeType.split("/")[0] as CreativeField["type"]);
        const form = new FormData();
        form.set("apiKey", connection(context).apiKey); form.set("fileType", "input");
        form.set("file", new Blob([media.bytes], { type: media.mimeType }), `reference${crypto.randomUUID()}.${mediaExtensions[media.mimeType]}`);
        const response = await context.fetch(`${connection(context).endpoint}/task/openapi/upload`, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${connection(context).apiKey}` }, body: form });
        if (!response.ok) throw new Error(`RunningHub 上传失败（HTTP ${response.status}）`);
        const uploaded = record(successful(context, record(await response.json())));
        if (typeof uploaded.fileName !== "string" || !uploaded.fileName.trim()) throw new Error("RunningHub 没有返回上传文件名");
        fieldValue = uploaded.fileName;
      }
      nodeInfoList.push({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue });
    }
  } catch (cause) {
    if (cause && typeof cause === "object") Object.assign(cause, { definitive: true });
    throw cause;
  }
  const result = await request(context, normalized.mode === "app" ? "/task/openapi/ai-app/run" : "/task/openapi/create", { [normalized.mode === "app" ? "webappId" : "workflowId"]: normalized.workflowId, nodeInfoList });
  const data = record(result.data);
  if (typeof data.taskId !== "string" || !data.taskId.trim() || data.taskId.length > 512) {
    if (result.code !== 0) {
      const rejected = [301, 380, 412, 415, 416, 421, 433, 435, 436, 801, 802, 803, 806, 809, 810, 811, 812, 901, 1002, 1007, 1014, 1101, 1501, 1505].includes(Number(result.code));
      throw Object.assign(new Error(failure(context, result)), { status: rejected ? 400 : 502, ...(rejected ? { definitive: true } : {}) });
    }
    throw new Error("RunningHub 未返回有效任务 ID，请核查原请求，不要重新提交");
  }
  return { id: data.taskId, provider: "runningHub", endpoint: connection(context).endpoint, metadata: { mode: input.mode, workflowId: input.workflowId } };
}

function validateHandle(context: CreativeContext, handle: CreativeHandle) {
  if (handle.provider !== "runningHub" || handle.endpoint !== connection(context).endpoint || typeof handle.id !== "string" || !handle.id.trim() || handle.id.length > 512) invalid("RunningHub 原任务来源与当前连接不匹配，未发出请求");
}

function pollFailure(context: CreativeContext, result: Record<string, unknown>): CreativePoll {
  if ([423, 805, 807].includes(Number(result.code))) return { status: "failed", error: failure(context, result) };
  // 查询的鉴权、限流和服务错误不代表原任务失败；让调用方保留句柄，继续恢复原查询。
  throw Object.assign(new Error(failure(context, result)), { status: 502 });
}

export async function pollRunningHub(context: CreativeContext, handle: CreativeHandle): Promise<CreativePoll> {
  validateHandle(context, handle);
  const status = await request(context, "/task/openapi/status", { taskId: handle.id });
  if ([804, 813].includes(Number(status.code))) return { status: "pending" };
  if (status.code !== 0) return pollFailure(context, status);
  const state = String(typeof status.data === "string" ? status.data : record(status.data).taskStatus ?? record(status.data).status ?? "").toUpperCase();
  if (["RUNNING", "QUEUED", "PENDING"].includes(state)) return { status: "pending" };
  const result = await request(context, "/task/openapi/outputs", { taskId: handle.id });
  if ([804, 813].includes(Number(result.code))) return { status: "pending" };
  if (result.code !== 0) return pollFailure(context, result);
  if (!Array.isArray(result.data) || !result.data.length) return { status: "failed", error: "RunningHub 没有返回原任务的输出文件" };
  const formats: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", ply: "application/ply", zip: "application/zip" };
  const assets = result.data.map(item => {
    const asset = record(item);
    let url: URL;
    try { url = new URL(String(asset.fileUrl ?? "")); } catch { throw new Error("RunningHub 输出地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("RunningHub 输出地址无效");
    return { url: url.href, mimeType: formats[String(asset.fileType ?? "").toLowerCase()], name: url.pathname.split("/").at(-1) };
  });
  return { status: "completed", assets };
}

export async function cancelRunningHub(context: CreativeContext, handle: CreativeHandle): Promise<void> {
  validateHandle(context, handle);
  successful(context, await request(context, "/task/openapi/cancel", { taskId: handle.id }));
}
