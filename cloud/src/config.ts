import { mkdirSync, readFileSync, writeAtomicSync, lstatSync, chmodSync } from "@toonflow/file";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

const dataDir = resolve(process.env.MILIMILI_DATA_DIR ?? join(process.cwd(), "data"));
mkdirSync(dataDir, { recursive: true });

// 已有密钥只读取；并发首次启动只能有一个创建者，不能覆盖另一进程使用的密钥。
function masterKey(): Buffer {
    const configured = process.env.MILIMILI_MASTER_KEY;
    let value = configured;
    if (value === undefined) {
        const path = join(dataDir, ".master.key");
        try { writeAtomicSync(path, randomBytes(32).toString("hex"), { exclusive: true, mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("主密钥必须是普通文件");
        chmodSync(path, 0o600);
        value = readFileSync(path, "utf8").trim();
    }
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("主密钥必须是 32 字节十六进制值");
    return Buffer.from(value, "hex");
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
