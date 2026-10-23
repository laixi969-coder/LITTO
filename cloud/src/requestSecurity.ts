/** Cookie 写请求需自定义标记和可信来源；显式 Bearer 客户端不依赖浏览器 Cookie。 */
export function validMutationSource(headers: { authorization?: string; origin?: string; referer?: string; marker?: string }, requestOrigin: string) {
  if (headers.authorization?.startsWith("Bearer ")) return true;
  if (headers.marker !== "1") return false;
  try {
    const source = new URL(headers.origin ?? headers.referer ?? "").origin;
    const trusted = (process.env.MILIMILI_CORS_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
    return source !== "null" && (source === new URL(requestOrigin).origin || trusted.includes(source));
  } catch { return false; }
}
