#!/usr/bin/env node
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

const pkg = createRequire(import.meta.url)("./package.json");

const corsHeaders = {
    "vary": "Origin",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
};

/** Headers that describe the hop to this proxy rather than the upstream request. */
const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
/** fetch() already decoded and re-framed the body, so the upstream framing headers no longer apply. */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function readArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function readTarget(url) {
    const raw = url.slice(1);
    // decodeURI undoes the escaping browsers apply to the path while keeping intentional encodeURIComponent escapes.
    let target = raw;
    try {
        target = decodeURI(raw);
    } catch {
        // Malformed escape sequence: forward the raw form instead of failing.
    }
    // Some clients collapse the "//" in the embedded target URL, so restore it before parsing.
    target = target.replace(/^(https?:)\/*/i, "$1//");
    return /^https?:\/\/[^/]/i.test(target) ? target : "";
}

function requestHeaders(req) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key) || value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function responseHeaders(upstream) {
    const headers = { ...corsHeaders };
    upstream.headers.forEach((value, key) => {
        if (SKIP_RESPONSE_HEADERS.has(key) || key.startsWith("access-control-")) return;
        headers[key] = value;
    });
    headers.vary = [upstream.headers.get("vary"), "Origin"].filter(Boolean).join(", ");
    return headers;
}

function sendJson(res, status, payload) {
    res.writeHead(status, { ...corsHeaders, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function logForward(method, target, outcome, startedAt) {
    console.log(`${new Date().toLocaleTimeString()} ${method} ${target} -> ${outcome} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

async function forward(req, res, target) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstream = await fetch(target, { method: req.method, headers: requestHeaders(req), body, redirect: "follow" });
    // Logged as soon as the status line arrives, so a long SSE stream still shows up immediately.
    res.writeHead(upstream.status, responseHeaders(upstream));
    if (!upstream.body) {
        res.end();
        return upstream.status;
    }
    // Streamed so that SSE responses (text generation) reach the browser chunk by chunk.
    const stream = Readable.fromWeb(upstream.body);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return upstream.status;
}

export function createProxyServer(allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"]) {
    const trustedOrigins = new Set(allowedOrigins.map(origin => new URL(origin).origin));
    return createServer((req, res) => {
        let hostname;
        try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { hostname = ""; }
        const localAddress = req.socket.localAddress?.replace(/^::ffff:/, "");
        const origin = req.headers.origin;
        if (!["localhost", "127.0.0.1", "[::1]", localAddress].includes(hostname)
            || (origin !== undefined ? !trustedOrigins.has(origin) : req.headers["sec-fetch-site"] === "cross-site")) {
            sendJson(res, 403, { error: "页面来源或代理地址未授权" });
            return;
        }
        if (origin) res.setHeader("access-control-allow-origin", origin);
        if (req.method === "OPTIONS") {
            res.writeHead(204, corsHeaders);
            res.end();
            return;
        }
        const target = readTarget(req.url || "/");
        if (!target) {
            sendJson(res, 200, { app: "infinite-canvas", proxy: pkg.name, version: pkg.version, usage: "/<full-target-url>" });
            return;
        }
        const startedAt = Date.now();
        const method = req.method || "GET";
        forward(req, res, target)
            .then((status) => logForward(method, target, status, startedAt))
            .catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                logForward(method, target, `failed (${reason})`, startedAt);
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                sendJson(res, 502, { error: reason });
            });
    });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
    console.log(`${pkg.name} v${pkg.version}\n\nUsage: npx ${pkg.name}@latest [--port 23210] [--host 127.0.0.1] [--origin http://localhost:3000]\n\nForwards http://<host>:<port>/<full-target-url> to <full-target-url> for explicitly allowed browser origins.`);
    process.exit(0);
}

const port = Number(readArg(args, "port", process.env.PORT || 23210));
const host = readArg(args, "host", process.env.HOST || "127.0.0.1");

const origins = readArg(args, "origin", "http://localhost:3000,http://127.0.0.1:3000").split(",").map(value => value.trim()).filter(Boolean);

createProxyServer(origins).listen(port, host, () => {
    console.log(`${pkg.name} v${pkg.version} listening on http://${host}:${port}`);
    console.log(`Fill this address into Infinite Canvas → 配置 → 本地代理: http://${host}:${port}`);
});
