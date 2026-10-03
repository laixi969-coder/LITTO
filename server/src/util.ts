import { randomBytes, createHash } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID: 48-bit time + 80-bit randomness, sortable. */
export function ulid(): string {
    let t = Date.now();
    let time = "";
    for (let i = 0; i < 10; i++) {
        time = ALPHABET[t % 32] + time;
        t = Math.floor(t / 32);
    }
    const rnd = randomBytes(16);
    let r = "";
    for (let i = 0; i < 16; i++) r += ALPHABET[rnd[i] % 32];
    return time + r;
}

export const now = () => new Date().toISOString();
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export class HttpError extends Error {
    constructor(
        public status: number,
        message: string,
        public code = "error",
        public details?: unknown,
    ) {
        super(message);
    }
}
export const bad = (m: string, details?: unknown) => new HttpError(400, m, "bad_request", details);
export const notFound = (what = "resource") => new HttpError(404, `${what} not found`, "not_found");
export const forbidden = (m = "forbidden") => new HttpError(403, m, "forbidden");
export const conflict = (m: string, code = "conflict", details?: unknown) => new HttpError(409, m, code, details);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const j = (v: unknown) => JSON.stringify(v ?? null);

/** Strip anything that looks like an API key from log strings. */
export function redact(s: string): string {
    return s.replace(/(sk|key|tok|Bearer)[-_ ]?[A-Za-z0-9_\-]{12,}/g, "$1-***");
}
export const log = {
    info: (...a: unknown[]) => !process.env.FILMFLOW_QUIET && console.log(redact(a.map(String).join(" "))),
    error: (...a: unknown[]) => !process.env.FILMFLOW_QUIET && console.error(redact(a.map(String).join(" "))),
};
