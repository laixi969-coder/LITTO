import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { assertPublicHttpUrl, guardedFetch } from "@/utils/ssrf";

const images = new Map<string, { data: Buffer; mimeType: string; expires: number }>();
const maxBytes = 200 * 1024 * 1024;
const lifetime = 2 * 60 * 60 * 1000;
let storedBytes = 0;

function remove(token: string) {
  const image = images.get(token);
  if (!image) return;
  storedBytes -= image.data.length;
  images.delete(token);
}

export function readRelayImage(request: Request, response: Response) {
  const token = request.params.token;
  const image = typeof token === "string" ? images.get(token) : undefined;
  if (!image || image.expires <= Date.now()) {
    if (typeof token === "string") remove(token);
    return void response.sendStatus(404);
  }
  response.set({ "Content-Type": image.mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.send(image.data);
}

export async function relayImage(input: MediaInput, signal?: AbortSignal) {
  if (input.type !== "url") {
    if (!["image/png", "image/jpeg"].includes(input.mimeType)) throw new Error("腾讯 WAND 参考图片须为 PNG 或 JPEG");
    const size = input.type === "binary" ? input.data.byteLength : Buffer.byteLength(input.data.replace(/^data:[^,]+,/, ""), "base64");
    if (!size || size > 20 * 1024 * 1024) throw new Error("腾讯 WAND 参考图片须不超过 20 MB");
  }
  return relayMedia(input, signal);
}

export async function relayMedia(input: MediaInput, signal?: AbortSignal) {
  if (input.type === "url") return input.url;
  if (!["image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/wav", "audio/mp4"].includes(input.mimeType)) throw new Error("不支持此参考素材格式");
  const data = input.type === "binary" ? Buffer.from(input.data) : Buffer.from(input.data.replace(/^data:[^,]+,/, ""), "base64");
  if (!data.length || data.length > 100 * 1024 * 1024) throw new Error("参考素材须不超过 100 MB");
  const base = process.env.MILIMILI_PUBLIC_URL?.trim();
  if (!base) throw new Error("临时素材中转需要服务管理员设置 MILIMILI_PUBLIC_URL 为此服务的公网 HTTPS 地址");
  const publicUrl = await assertPublicHttpUrl(base);
  if (publicUrl.protocol !== "https:" || publicUrl.search || publicUrl.hash) throw new Error("MILIMILI_PUBLIC_URL 必须是不含查询参数或片段的公网 HTTPS 地址");
  for (const [key, value] of images) if (value.expires <= Date.now()) remove(key);
  // ACT: 单进程内存中转上限为 200 MB，部署多实例时须将请求固定到同一实例或改用共享存储。
  if (storedBytes + data.length > maxBytes || images.size >= 100) throw new Error("临时素材中转空间已满，请稍后重试");
  const token = randomBytes(32).toString("hex");
  images.set(token, { data, mimeType: input.mimeType, expires: Date.now() + lifetime });
  storedBytes += data.length;
  const timer = setTimeout(() => remove(token), lifetime);
  timer.unref();
  const url = `${publicUrl.href.replace(/\/+$/, "")}/mediaRelay/${token}`;
  try {
    const response = await guardedFetch(url, { signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]), redirect: "error" });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== input.mimeType) throw new Error("临时素材公网地址不可访问或响应不正确");
    if (!response.body) throw new Error("临时素材公网地址未返回素材");
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > data.length) throw new Error("临时素材公网地址返回了不匹配的素材");
        hash.update(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (size !== data.length || hash.digest("hex") !== createHash("sha256").update(data).digest("hex")) throw new Error("临时素材公网地址返回了不匹配的素材");
    return url;
  } catch (error) {
    clearTimeout(timer);
    remove(token);
    if (signal?.aborted) throw error;
    throw new Error("临时素材中转的公网地址不可访问，请检查 MILIMILI_PUBLIC_URL、反向代理和 HTTPS 配置", { cause: error });
  }
}
