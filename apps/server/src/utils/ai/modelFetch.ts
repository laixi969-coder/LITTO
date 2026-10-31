import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { guardedFetch, isBlockedIp } from "@/utils/ssrf";

const isFakeIp = (address: string) => /^198\.(18|19)\./.test(address);
const modelAddresses = new Map<string, { address: string; expiresAt: number }>();

async function modelFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!["https://api.deepseek.com", "https://open.bigmodel.cn"].includes(url.origin) || url.username || url.password) return guardedFetch(input, init);
  const hostname = url.hostname;
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.some(item => isFakeIp(item.address))) return guardedFetch(input, init);

  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  request.signal.throwIfAborted();
  // ACT: 仅兼容这两个官方域名的 Fake-IP；缓存最多两个域名，不重试生成请求，不改全局 DNS/代理。
  // 按 DNS TTL 缓存一个公网地址，其他供应商继续使用原网络路径。
  let address = modelAddresses.get(hostname);
  if (!address || address.expiresAt <= Date.now()) {
    const response = await fetch(`https://dns.google/resolve?name=${hostname}&type=A`, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`${hostname} 公网地址解析失败（HTTP ${response.status}）`);
    const result = z.object({
      Status: z.literal(0),
      Answer: z.array(z.object({ type: z.number(), data: z.string(), TTL: z.number().int().nonnegative() })),
    }).parse(await response.json());
    const answer = result.Answer.find(item => item.type === 1 && isIP(item.data) === 4 && !isBlockedIp(item.data) && !isFakeIp(item.data));
    if (!answer) throw new Error(`${hostname} 公网地址解析失败：未返回可用的公网 IPv4 地址`);
    address = { address: answer.data, expiresAt: Date.now() + Math.min(answer.TTL, 300) * 1000 };
    modelAddresses.set(hostname, address);
  }
  url.hostname = address.address;
  const directRequest = new Request(url.href, request);
  directRequest.headers.set("Host", hostname);
  return fetch(directRequest, {
    // Bun 支持 false 显式直连；当前工作区的类型声明尚未包含它。
    // @ts-expect-error BunFetchRequestInit.proxy 缺少 false 类型。
    proxy: false,
    redirect: "error",
    tls: { serverName: hostname, rejectUnauthorized: true },
  });
}

export default Object.assign(modelFetch, { preconnect: fetch.preconnect }) as typeof fetch;
