import { createHash } from "node:crypto";
import { config } from "../config.ts";
import type { GenRequest, GenResult, PollResult, ProviderAdapter } from "./adapter.ts";

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
const hue = (s: string, salt = 0) => (parseInt(createHash("md5").update(s).digest("hex").slice(0, 6), 16) + salt) % 360;

function wrap(text: string, n: number) {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
        if ((cur + " " + w).length > n) (lines.push(cur), (cur = w));
        else cur = (cur + " " + w).trim();
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 6);
}

/** Deterministic offline "renderer": produces a labelled storyboard-style SVG so the whole pipeline is exercisable without a paid provider. */
function frame(req: GenRequest, idx: number, animated: boolean) {
    const w = Number(req.params.width ?? 1280);
    const h = Number(req.params.height ?? 720);
    const seed = Number(req.params.seed ?? 0) + idx;
    const h1 = hue(req.prompt, seed * 37);
    const h2 = (h1 + 60) % 360;
    const lines = wrap(req.prompt.slice(0, 240), 46)
        .map((l, i) => `<text x="40" y="${h - 150 + i * 24}" font-size="18" fill="#fff" fill-opacity=".85" font-family="monospace">${esc(l)}</text>`)
        .join("");
    const sub = req.inputs.map((i) => i.role).join(" · ") || "no references";
    const motion = animated
        ? `<circle r="22" cx="80" cy="${h / 2}" fill="#fff" fill-opacity=".8"><animate attributeName="cx" values="80;${w - 80};80" dur="${Number(req.params.duration ?? 4)}s" repeatCount="indefinite"/></circle>`
        : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1} 45% 22%)"/><stop offset="1" stop-color="hsl(${h2} 50% 10%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>${motion}
<text x="40" y="52" font-size="26" fill="#fff" font-family="sans-serif" font-weight="700">${esc(req.label ?? (animated ? "TAKE" : "KEYFRAME"))} · ${esc(req.externalModelId)} · seed ${seed}</text>
<text x="40" y="82" font-size="16" fill="#ffd27a" font-family="monospace">refs: ${esc(sub)}</text>${lines}</svg>`;
}

type Task = { req: Omit<GenRequest, "inputs" | "apiKey">; readyAt: number };
const enc = (t: Task) => "mock_" + Buffer.from(JSON.stringify(t)).toString("base64url");
const dec = (id: string): Task => JSON.parse(Buffer.from(id.slice(5), "base64url").toString());

function build(req: Task["req"]): GenResult {
    const count = Number(req.params.count ?? 1);
    const video = req.kind === "video";
    const duration = Number(req.params.duration ?? 4);
    const price = video ? 0.05 * duration : 0.04 * count;
    return {
        outputs: Array.from({ length: video ? 1 : count }, (_, i) => ({ data: Buffer.from(frame({ ...req, inputs: [] } as GenRequest, i, video)), mime: "image/svg+xml", duration: video ? duration : undefined })),
        costUsd: price,
    };
}

/**
 * Stateless async adapter: the task id carries the request, so polling works across process restarts (job recovery).
 * baseUrl "mock://fail" always fails, "mock://flaky" fails attempt 1; req.params.mockDefect is passed through to QC tests.
 */
export const mockAdapter: ProviderAdapter = {
    requiresKey: false,
    async submit(req) {
        if (req.baseUrl === "mock://fail") throw new Error("mock provider unavailable (503)");
        if (req.baseUrl === "mock://flaky" && req.attempt === 1) throw new Error("mock transient error (502)");
        const slim = { kind: req.kind, externalModelId: req.externalModelId, prompt: req.prompt, params: req.params, attempt: req.attempt, label: req.label, baseUrl: req.baseUrl } as Task["req"] & { inputs?: never };
        const roles = req.inputs.map((i) => ({ role: i.role }));
        (slim as any).inputs = roles;
        return { taskId: enc({ req: slim, readyAt: Date.now() + config.mockLatencyMs }) };
    },
    async poll(taskId) {
        const t = dec(taskId);
        if (Date.now() < t.readyAt) return { status: "running" } satisfies PollResult;
        const req = { ...t.req } as any;
        return { status: "done", result: build({ ...req, inputs: req.inputs }) };
    },
    async testConnection(ctx) {
        const ok = ctx.baseUrl !== "mock://fail";
        return { ok, message: ok ? "mock provider reachable" : "mock provider unavailable", latencyMs: 1 };
    },
};
