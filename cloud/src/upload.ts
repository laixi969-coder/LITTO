import type { Context, Next } from "hono";
import { HttpError } from "./util.ts";

export const uploadMaxBytes = 200 * 1024 * 1024;
let receiving = false;

// ACT: 单进程一次只缓冲一个上传/合并，峰值受 200 MiB 文件上限约束；扩容需流式存储适配器。
export async function uploadSlot(c: Context, next: Next) {
  if (!["POST", "PUT"].includes(c.req.method)) return next();
  if (receiving) throw new HttpError(429, "正在接收另一个文件，请稍后重试", "upload_busy");
  receiving = true;
  try { await next(); } finally { receiving = false; }
}

export async function readUpload(request: Request, maxBytes = uploadMaxBytes) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(413, "上传文件过大", "upload_too_large");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 120_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (expired) throw new HttpError(408, "上传超时，请重试", "upload_timeout");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new HttpError(413, "上传文件过大", "upload_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
