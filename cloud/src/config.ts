import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

const dataDir = resolve(process.env.MILIMILI_DATA_DIR ?? join(process.cwd(), "data"));
mkdirSync(dataDir, { recursive: true });

// Master key: env wins; otherwise a generated key persisted next to the data (dev only).
function masterKey(): Buffer {
    if (process.env.MILIMILI_MASTER_KEY) return Buffer.from(process.env.MILIMILI_MASTER_KEY, "hex");
    const f = join(dataDir, ".master.key");
    if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
    return Buffer.from(readFileSync(f, "utf8").trim(), "hex");
}

export const config = {
    dataDir,
    production: process.env.NODE_ENV === "production",
    port: Number(process.env.PORT ?? 8787),
    dbFile: process.env.MILIMILI_DB ?? join(dataDir, "milimili.db"),
    mediaDir: join(dataDir, "media"),
    masterKey: masterKey(),
    adminEmails: (process.env.MILIMILI_ADMIN_EMAILS ?? "admin@milimili.local").split(",").map((s) => s.trim().toLowerCase()),
    publicUrl: process.env.MILIMILI_PUBLIC_URL ?? "http://localhost:8787",
    workerPollMs: Number(process.env.MILIMILI_WORKER_POLL_MS ?? 300),
    mockLatencyMs: Number(process.env.MILIMILI_MOCK_LATENCY_MS ?? 400),
};
