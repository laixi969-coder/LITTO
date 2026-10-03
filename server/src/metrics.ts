/** In-process metrics (Prometheus-style text available at /admin/metrics.txt). */
const counters = new Map<string, number>();
const sums = new Map<string, { n: number; total: number }>();
export const inc = (k: string, by = 1) => counters.set(k, (counters.get(k) ?? 0) + by);
export const observe = (k: string, v: number) => { const s = sums.get(k) ?? { n: 0, total: 0 }; s.n++; s.total += v; sums.set(k, s); };
export const snapshot = () => ({ counters: Object.fromEntries(counters), latency: Object.fromEntries([...sums].map(([k, v]) => [k, { count: v.n, avgMs: v.n ? v.total / v.n : 0 }])) });
