import type { Request, Response, NextFunction } from "express";
import { error } from "@/lib/responseFormat";

// 所有响应的基础安全头；不设 CSP，画布节点脚本和第三方模型资源的来源尚未收敛。
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // 音频节点需要麦克风，视频播放器需要全屏，只关掉用不到的能力。
    "Permissions-Policy": "camera=(), geolocation=(), payment=()",
    // 私有创作空间，不希望任何页面或接口被搜索引擎收录。
    "X-Robots-Tag": "noindex, nofollow",
  });
  next();
}

// 接口默认不让浏览器和中间代理复用旧响应；需要缓存的接口自行设置 Cache-Control。
export function noStoreApi(_req: Request, res: Response, next: NextFunction) {
  res.set("Cache-Control", "private, no-cache");
  next();
}

// 带内容哈希的打包文件永不变化，可长期缓存；入口 HTML 每次校验，保证发版后立即拿到新资源。
export function staticCacheHeaders(res: Response, path: string) {
  if (/[\\/]assets[\\/]/.test(path)) res.set("Cache-Control", "public, max-age=31536000, immutable");
  else if (path.endsWith(".html")) res.set("Cache-Control", "no-cache");
}

// ACT: 进程内固定一分钟窗口，单实例够用；多实例或真正的 DDoS 需要在反向代理/CDN 层限流。
const windowMs = 60_000;
const buckets = new Map<string, { start: number; count: number }>();
setInterval(() => {
  const cutoff = Date.now() - windowMs;
  for (const [key, bucket] of buckets) if (bucket.start < cutoff) buckets.delete(key);
}, windowMs).unref();

export function rateLimit(limit: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    // req.ip 只在 app 设置 trust proxy 时才读取 x-forwarded-for，避免客户端伪造来源绕过限流。
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return next();
    }
    if (++bucket.count <= limit) return next();
    res.set("Retry-After", String(Math.ceil((bucket.start + windowMs - now) / 1000)));
    res.status(429).json(error("操作太频繁，请稍后再试", null, 429));
  };
}
