import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

/** AES-256-GCM. Secrets (provider API keys) only ever exist in plaintext inside this process. */
export function encrypt(plain: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", config.masterKey, iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return { cipher: enc.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
export function decrypt(p: { cipher: string; iv: string; tag: string }): string {
    const d = createDecipheriv("aes-256-gcm", config.masterKey, Buffer.from(p.iv, "base64"));
    d.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(p.cipher, "base64")), d.final()]).toString("utf8");
}
export const mask = (secret: string) => (secret.length <= 8 ? "••••" : `••••${secret.slice(-4)}`);

export function sign(payload: string): string {
    return createHmac("sha256", config.masterKey).update(payload).digest("hex");
}
export function verifySig(payload: string, sig: string): boolean {
    const a = Buffer.from(sign(payload));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
}
