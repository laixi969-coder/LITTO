import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { isBlockedIp } from "@/utils/ssrf";

const isFakeIp = (address: string) => /^198\.(18|19)\./.test(address);
let deepSeekAddress: { address: string; expiresAt: number } | undefined;

async function modelFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://api.deepseek.com" || url.username || url.password) return fetch(input, init);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.some(item => isFakeIp(item.address))) return fetch(input, init);

  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  request.signal.throwIfAborted();
  // ACT: 仅兼容 DeepSeek 官方域名的 Fake-IP；不重试生成请求，不改全局 DNS/代理。
  // 按 DNS TTL 缓存一个公网地址，其他供应商继续使用原网络路径。
  if (!deepSeekAddress || deepSeekAddress.expiresAt <= Date.now()) {
    const response = await fetch("https://dns.google/resolve?name=api.deepseek.com&type=A", {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`DeepSeek 公网地址解析失败（HTTP ${response.status}）`);
    const result = z.object({
      Status: z.literal(0),
      Answer: z.array(z.object({ type: z.number(), data: z.string(), TTL: z.number().int().nonnegative() })),
    }).parse(await response.json());
    const answer = result.Answer.find(item => item.type === 1 && isIP(item.data) === 4 && !isBlockedIp(item.data) && !isFakeIp(item.data));
    if (!answer) throw new Error("DeepSeek 公网地址解析失败：未返回可用的公网 IPv4 地址");
    deepSeekAddress = { address: answer.data, expiresAt: Date.now() + Math.min(answer.TTL, 300) * 1000 };
  }
  url.hostname = deepSeekAddress.address;
  const directRequest = new Request(url.href, request);
  directRequest.headers.set("Host", "api.deepseek.com");
  return fetch(directRequest, {
    // Bun 支持 false 显式直连；当前工作区的类型声明尚未包含它。
    // @ts-expect-error BunFetchRequestInit.proxy 缺少 false 类型。
    proxy: false,
    redirect: "error",
    tls: { serverName: "api.deepseek.com", rejectUnauthorized: true },
  });
}

export default Object.assign(modelFetch, { preconnect: fetch.preconnect }) as typeof fetch;
