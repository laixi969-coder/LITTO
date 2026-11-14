import { z } from "zod";
import type { CreativeContext, CreativeDescription, CreativeHandle, CreativePoll, FalInput } from "@/utils/creative/types";

const endpoints = {
  mesh: "tripo3d/h3.1/image-to-3d",
  upscale: "topaz/upscale/image/precision",
  texture: "topaz/upscale/image/generative",
};
const unit = z.number().finite().min(0).max(1);
const meshOptions = z.strictObject({
  faceLimit: z.number().int().min(1000).max(2000000).optional(),
  texture: z.boolean().default(true), pbr: z.boolean().default(true),
  modelSeed: z.number().int().optional(), textureSeed: z.number().int().optional(),
  textureQuality: z.enum(["standard", "detailed"]).optional(), geometryQuality: z.enum(["standard", "detailed"]).optional(),
  textureAlignment: z.enum(["original_image", "geometry"]).optional(), autoSize: z.boolean().optional(),
  orientation: z.enum(["default", "align_image"]).optional(),
  // ACT: 当前资产链交付 GLB；Tripo 的 quad 可能返回 FBX，须先补齐对应导入能力再开放。
  quad: z.literal(false).optional(), enableSafetyChecker: z.boolean().default(true),
}).superRefine((options, ctx) => {
  if (!options.texture && (options.pbr || options.textureSeed !== undefined || options.textureQuality !== undefined || options.textureAlignment !== undefined)) {
    ctx.addIssue({ code: "custom", message: "关闭 texture 时须关闭 pbr，且不能设置纹理种子、质量或对齐参数" });
  }
});
const upscaleOptions = z.strictObject({
  model: z.enum(["Standard V2", "High Fidelity V3", "High Fidelity V2", "Low Resolution V2", "CGI", "Text Refine", "Faces"]).default("Standard V2"),
  upscaleFactor: z.number().finite().min(1).max(4).default(2), outputFormat: z.enum(["jpeg", "png"]).default("png"),
  cropToFill: z.boolean().optional(), subjectDetection: z.enum(["All", "Foreground", "Background"]).optional(),
  faceEnhancement: z.boolean().optional(), faceEnhancementCreativity: unit.optional(), faceEnhancementStrength: unit.optional(),
  sharpen: unit.optional(), denoise: unit.optional(), fixCompression: unit.optional(), strength: z.number().finite().min(0.01).max(1).optional(),
  enableSafetyChecker: z.boolean().default(true),
}).superRefine((options, ctx) => {
  if (options.strength !== undefined && options.model !== "Text Refine") ctx.addIssue({ code: "custom", path: ["strength"], message: "strength 仅适用于 Text Refine" });
  if (options.fixCompression !== undefined && options.model === "CGI") ctx.addIssue({ code: "custom", path: ["fixCompression"], message: "CGI 不支持 fixCompression" });
  if (options.faceEnhancement === false && (options.faceEnhancementCreativity !== undefined || options.faceEnhancementStrength !== undefined)) ctx.addIssue({ code: "custom", message: "关闭人脸增强时不能设置人脸增强强度或创造性" });
});
const textureOptions = z.strictObject({
  model: z.literal("Redefine").default("Redefine"),
  upscaleFactor: z.number().finite().min(1).max(4).default(1), outputFormat: z.enum(["jpeg", "png"]).default("png"),
  creativity: z.number().int().min(1).max(6).default(1), texture: z.number().int().min(1).max(5).default(1),
  sharpen: unit.optional(), denoise: unit.optional(), prompt: z.string().max(1024).optional(), autoprompt: z.boolean().optional(),
  enableSafetyChecker: z.boolean().default(true),
}).superRefine((options, ctx) => {
  if (options.autoprompt && options.prompt?.trim()) ctx.addIssue({ code: "custom", message: "不能同时提供 prompt 和 autoprompt，以免用户提示被自动提示覆盖" });
});
const optionSchemas = { mesh: meshOptions, upscale: upscaleOptions, texture: textureOptions };
const inputSchema = z.strictObject({
  operation: z.enum(["mesh", "upscale", "texture"]),
  image: z.strictObject({ path: z.string().min(1).max(4096), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]) }),
  options: z.record(z.string(), z.unknown()),
});

export function validateFalInput(input: FalInput): FalInput {
  try {
    const parsed = inputSchema.parse(input);
    return { ...parsed, options: optionSchemas[parsed.operation].parse(parsed.options) };
  } catch (cause) {
    if (cause instanceof z.ZodError) throw Object.assign(new Error(cause.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("；")), { status: 400 });
    throw cause;
  }
}

export function falEndpoint(input: FalInput): string {
  return endpoints[validateFalInput(input).operation];
}

function apiKey(context: CreativeContext) {
  if (typeof context.config.baseUrl === "string" && context.config.baseUrl.trim() && context.config.baseUrl.trim().replace(/\/$/, "") !== "https://queue.fal.run") throw Object.assign(new Error("Fal 专用工具使用官方 https://queue.fal.run 队列地址"), { status: 400 });
  const value = typeof context.config.apiKey === "string" ? context.config.apiKey.trim().replace(/^Key\s+/i, "") : "";
  if (!value || /[\r\n]/.test(value)) throw Object.assign(new Error("请先配置 Fal API Key"), { status: 400 });
  return value;
}

async function request(context: CreativeContext, path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
  const key = apiKey(context);
  const response = await context.fetch(`https://queue.fal.run/${path}`, {
    method, headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: "error",
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data && typeof data === "object" && "detail" in data ? String(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)).slice(0, 1000).replaceAll(key, "[redacted]") : "";
    throw Object.assign(new Error(`Fal 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`), { status: 502, upstreamStatus: response.status, definitive: [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status) });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Fal 响应格式无效");
  return data as Record<string, unknown>;
}

function requestPath(handle: CreativeHandle) {
  if (handle.provider !== "fal" || !Object.values(endpoints).includes(handle.endpoint) || !z.uuid().safeParse(handle.id).success) throw Object.assign(new Error("Fal 任务标识无效"), { status: 400 });
  // 官方 Queue 协议的查询/取消仅使用 owner/app；不信任上游返回的 status_url、response_url 或 cancel_url。
  return `${handle.endpoint.split("/").slice(0, 2).join("/")}/requests/${handle.id}`;
}

export async function submitFal(context: CreativeContext, input: FalInput): Promise<CreativeHandle> {
  const parsed = validateFalInput(input);
  apiKey(context);
  const media = await context.readMedia(parsed.image);
  const dataUri = /^data:([^;,]+);base64,([\s\S]+)$/.exec(media.data);
  const data = (dataUri?.[2] ?? media.data).replace(/\s/g, "");
  if (media.mimeType !== parsed.image.mimeType || dataUri && dataUri[1] !== media.mimeType || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 40 * 1024 * 1024) throw Object.assign(new Error("参考图像格式无效或超过 30 MB"), { status: 400 });
  const options = Object.fromEntries(Object.entries(parsed.options).map(([name, value]) => [name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
  const endpoint = endpoints[parsed.operation];
  const result = await request(context, endpoint, "POST", { ...options, ...(parsed.operation === "texture" ? { face_enhancement: false } : {}), image_url: `data:${media.mimeType};base64,${data}` });
  if (!z.uuid().safeParse(result.request_id).success) throw new Error("Fal 未返回有效任务 ID；请检查上游记录，不要自动重复提交");
  return { id: result.request_id as string, endpoint, provider: "fal", metadata: { operation: parsed.operation } };
}

const assetSchema = z.object({
  url: z.url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }, "Fal 输出须为 HTTPS 文件"),
  content_type: z.string().nullish(), file_name: z.string().nullish(),
});
function asset(value: unknown, fallbackMime?: string, fallbackName?: string) {
  const parsed = assetSchema.parse(value);
  return { url: parsed.url, mimeType: parsed.content_type || fallbackMime, name: parsed.file_name?.split(/[\\/]/).at(-1) || fallbackName };
}

export async function pollFal(context: CreativeContext, handle: CreativeHandle): Promise<CreativePoll> {
  const path = requestPath(handle);
  const state = await request(context, `${path}/status`);
  if (state.error) return { status: "failed", error: String(state.error).slice(0, 2000) };
  if (state.status === "IN_QUEUE" || state.status === "IN_PROGRESS") return { status: "pending" };
  if (state.status !== "COMPLETED") return { status: "failed", error: `Fal 返回未知任务状态：${String(state.status)}` };
  let result;
  try { result = await request(context, path); }
  catch (cause) {
    if (cause && typeof cause === "object" && "upstreamStatus" in cause && [400, 404, 422].includes(Number(cause.upstreamStatus))) return { status: "failed", error: cause instanceof Error ? cause.message : "Fal 任务执行失败" };
    throw cause;
  }
  if (result.error) return { status: "failed", error: String(result.error).slice(0, 2000) };
  try {
    if (handle.endpoint === endpoints.mesh) {
      const urls = result.model_urls && typeof result.model_urls === "object" ? result.model_urls as Record<string, unknown> : {};
      const assets = [asset(urls.glb ?? result.model_mesh, "model/gltf-binary", "model.glb")];
      if (result.rendered_image) assets.push(asset(result.rendered_image, "image/png", "preview.png"));
      return { status: "completed", assets };
    }
    return { status: "completed", assets: [asset(result.image)] };
  } catch {
    return { status: "failed", error: "Fal 已结束，但没有返回有效的模型或图像文件" };
  }
}

export async function cancelFal(context: CreativeContext, handle: CreativeHandle): Promise<void> {
  const result = await request(context, `${requestPath(handle)}/cancel`, "PUT");
  if (!["OK", "CANCELLATION_REQUESTED"].includes(String(result.status))) throw new Error("Fal 未确认取消或任务已结束，请查询原任务状态取回结果");
}

export function describeFal(): (CreativeDescription & { operation: FalInput["operation"] })[] {
  return [
    { operation: "mesh", label: "Tripo H3.1 · 2026 · 图片转 GLB", fields: [
      { nodeId: "options", fieldName: "texture", label: "生成纹理", type: "boolean", value: true },
      { nodeId: "options", fieldName: "pbr", label: "PBR 材质", type: "boolean", value: true },
      { nodeId: "options", fieldName: "faceLimit", label: "目标面数", type: "number", value: 30000, min: 1000, max: 2000000, step: 1000 },
      { nodeId: "options", fieldName: "textureQuality", label: "纹理质量", type: "string", value: "standard", options: ["standard", "detailed"] },
      { nodeId: "options", fieldName: "geometryQuality", label: "几何质量", type: "string", value: "standard", options: ["standard", "detailed"] },
      { nodeId: "options", fieldName: "orientation", label: "模型朝向", type: "string", value: "default", options: ["default", "align_image"] },
    ] },
    { operation: "upscale", label: "Topaz Precision · 原图超分", fields: [
      { nodeId: "options", fieldName: "upscaleFactor", label: "放大倍率", type: "number", value: 2, min: 1, max: 4, step: 0.1 },
      { nodeId: "options", fieldName: "outputFormat", label: "输出格式", type: "string", value: "png", options: ["png", "jpeg"] },
      { nodeId: "options", fieldName: "sharpen", label: "锐化", type: "number", min: 0, max: 1, step: 0.05 },
      { nodeId: "options", fieldName: "denoise", label: "降噪", type: "number", min: 0, max: 1, step: 0.05 },
      { nodeId: "options", fieldName: "fixCompression", label: "压缩瑕疵修复", type: "number", min: 0, max: 1, step: 0.05 },
    ] },
    { operation: "texture", label: "Topaz Redefine · 原图质感增强", fields: [
      { nodeId: "options", fieldName: "upscaleFactor", label: "放大倍率（1 为原尺寸）", type: "number", value: 1, min: 1, max: 4, step: 0.1 },
      { nodeId: "options", fieldName: "creativity", label: "创造性（越高改动越大）", type: "number", value: 1, min: 1, max: 6, step: 1 },
      { nodeId: "options", fieldName: "texture", label: "细节强度", type: "number", value: 1, min: 1, max: 5, step: 1 },
      { nodeId: "options", fieldName: "prompt", label: "质感方向（可选）", type: "string" },
      { nodeId: "options", fieldName: "outputFormat", label: "输出格式", type: "string", value: "png", options: ["png", "jpeg"] },
    ] },
  ];
}
