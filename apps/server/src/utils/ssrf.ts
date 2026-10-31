import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for every URL a tenant can influence (provider API addresses, fetched pages, generated-media URLs).
 * Blocks loopback, private, link-local, CGNAT, cloud-metadata and equivalent IPv6 ranges — after DNS resolution and on every redirect hop.
 * Single-user mode (MILIMILI_AUTH=off, e.g. a local Ollama) or MILIMILI_ALLOW_PRIVATE_UPSTREAMS=1 turns the guard off.
 *
 * Known gap: resolution and connection are separate lookups, so a hostile DNS server could answer differently the second time
 * (rebinding). Closing it fully needs connecting to the pinned IP (not possible with Bun's fetch); run the server in a network
 * segment without access to internal services as defence in depth.
 */
export const privateUpstreamsAllowed = () => process.env.MILIMILI_AUTH === "off" || process.env.MILIMILI_ALLOW_PRIVATE_UPSTREAMS === "1";

// 198.18.0.0/15 (benchmarking) is deliberately NOT blocked: Fake-IP proxies (Clash etc., common on dev machines) answer every DNS lookup with it.
const v4Blocked: [number, number][] = [ // [network, prefix length]
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];
function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
}
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return v4Blocked.some(([net, bits]) => (n & (~0 << (32 - bits))) >>> 0 === net);
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / translated forms: judge the embedded IPv4 address.
    const mapped = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedIp(mapped[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
      return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === "::" || lower === "::1") return true;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 /* fc00::/7 unique local */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 link-local */ || (first & 0xff00) === 0xff00 /* multicast */;
  }
  return true; // not an IP at all: never treat as safe
}

export class UnsafeUpstreamError extends Error {
  status = 400;
}

/** Throws unless `value` is an http(s) URL pointing at a public host. `strictDns:false` tolerates unresolvable names (used when merely saving a setting). */
export async function assertPublicHttpUrl(value: string | URL, { strictDns = true }: { strictDns?: boolean } = {}): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new UnsafeUpstreamError("地址格式不正确，请填写以 http:// 或 https:// 开头的完整地址"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new UnsafeUpstreamError("只支持 http:// 或 https:// 地址");
  if (url.username || url.password) throw new UnsafeUpstreamError("地址里不能带用户名或密码");
  if (privateUpstreamsAllowed()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const blocked = () => new UnsafeUpstreamError("出于安全原因，不能使用内网、本机或云服务内部地址，请填写服务商的公网地址");
  if (isIP(host)) { if (isBlockedIp(host)) throw blocked(); return url; }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw blocked();
  let addresses: { address: string }[];
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch {
    if (strictDns) throw new UnsafeUpstreamError("连不上这个地址：域名无法解析，请检查拼写");
    return url;
  }
  if (!addresses.length || addresses.some(item => isBlockedIp(item.address))) throw blocked();
  return url;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
/** fetch() that re-validates the target before the request and after every redirect (max 5 hops). */
async function safeFetchImpl(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  let url = await assertPublicHttpUrl(request.url);
  let method = request.method;
  let body = request.body !== null;
  let headers = new Headers(request.headers);
  let referrer = request.referrer;
  let credentials = request.credentials;
  for (let hop = 0; ; hop++) {
    const response = await fetch(url, {
      ...init, method, headers, body: body ? request.clone().body : undefined,
      signal: request.signal, credentials, cache: request.cache,
      referrer, referrerPolicy: request.referrerPolicy, integrity: request.integrity,
      redirect: "manual",
    });
    if (!redirectStatuses.has(response.status) || request.redirect === "manual") return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (request.redirect === "error") throw new UnsafeUpstreamError("请求不允许重定向");
    if (!location || hop >= 5) throw new UnsafeUpstreamError("重定向过多或缺少目标地址");
    const target = await assertPublicHttpUrl(new URL(location, url));
    if (response.status === 303 && method !== "HEAD" || (response.status === 301 || response.status === 302) && method === "POST") {
      method = "GET";
      body = false;
      for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name);
    }
    if (target.origin !== url.origin) {
      if (body || !["GET", "HEAD"].includes(method)) throw new UnsafeUpstreamError("不能向其他来源重定向请求内容");
      // 凭据头名称由供应商定义，不能只删除 Authorization 或固定几个 API Key 名称。
      const publicHeaders = new Headers();
      for (const name of ["accept", "accept-language", "range"]) {
        const value = headers.get(name);
        if (value !== null) publicHeaders.set(name, value);
      }
      headers = publicHeaders;
      referrer = "";
      credentials = "omit";
    }
    url = target;
  }
}
export const safeFetch: typeof fetch = Object.assign(safeFetchImpl, { preconnect: fetch.preconnect }) as typeof fetch;

/** The fetch tenants' provider code and downloads should use: guarded in multi-tenant mode, plain fetch otherwise. */
export const guardedFetch: typeof fetch = Object.assign(((input: Parameters<typeof fetch>[0], init?: RequestInit) => (privateUpstreamsAllowed() ? fetch(input, init) : safeFetchImpl(input, init))) as typeof fetch, { preconnect: fetch.preconnect });

/** Literal-address / hostname-only check, no DNS and no await: cheap enough for synchronous config paths. */
export function assertPublicUrlLiteral(value: string) {
  if (privateUpstreamsAllowed()) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new UnsafeUpstreamError("地址格式不正确"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol)) throw new UnsafeUpstreamError("只支持 http:// 或 https:// 地址");
  if ((isIP(host) && isBlockedIp(host)) || /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) {
    throw new UnsafeUpstreamError("出于安全原因，不能使用内网、本机或云服务内部地址，请填写服务商的公网地址");
  }
}
