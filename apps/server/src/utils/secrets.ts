/** Secret handling for settings returned to / received from the browser: keys never leave the server in clear text. */
const SECRET_KEY = /^(apiKey|token|secret|password|accessKey)$/i;
const MASK = "••••";
export const isMasked = (v: unknown) => typeof v === "string" && v.startsWith(MASK);
const mask = (v: string) => (v ? `${MASK}${v.slice(-4)}` : "");

type SecretCipher = { cipher: string; iv: string; tag: string };

export function encryptSecrets(value: unknown, encrypt: (value: string) => SecretCipher, key = ""): unknown {
  if (SECRET_KEY.test(key) && typeof value === "string" && value) return { littoSecretVersion: 1, ...encrypt(value) };
  if (Array.isArray(value)) return value.map(item => encryptSecrets(item, encrypt));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, encryptSecrets(item, encrypt, name)]));
  return value;
}

export function decryptSecrets(value: unknown, decrypt: (value: SecretCipher) => string): unknown {
  if (Array.isArray(value)) return value.map(item => decryptSecrets(item, decrypt));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.littoSecretVersion === 1 && typeof record.cipher === "string" && typeof record.iv === "string" && typeof record.tag === "string") {
      return decrypt({ cipher: record.cipher, iv: record.iv, tag: record.tag });
    }
    return Object.fromEntries(Object.entries(record).map(([name, item]) => [name, decryptSecrets(item, decrypt)]));
  }
  return value;
}

export function hasPlainSecrets(value: unknown, key = ""): boolean {
  if (SECRET_KEY.test(key) && typeof value === "string" && !!value) return true;
  if (Array.isArray(value)) return value.some(item => hasPlainSecrets(item));
  return !!value && typeof value === "object" && Object.entries(value).some(([name, item]) => hasPlainSecrets(item, name));
}

/** Deep copy with every secret-looking field masked. */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(maskSecrets) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === "string" ? mask(v) : maskSecrets(v)])) as T;
  }
  return value;
}

/** When the client sends a masked placeholder back, keep the stored secret instead of overwriting it with the mask. */
export function restoreSecrets<T>(incoming: T, stored: unknown): T {
  if (Array.isArray(incoming)) return incoming.map((v, i) => restoreSecrets(v, Array.isArray(stored) ? (stored.find((s) => s && typeof s === "object" && (s as { id?: unknown }).id !== undefined && (s as { id?: unknown }).id === (v as { id?: unknown })?.id) ?? stored[i]) : undefined)) as T;
  if (incoming && typeof incoming === "object") {
    const old = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(incoming as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) && isMasked(v) ? old[k] ?? "" : restoreSecrets(v, old[k])])) as T;
  }
  return incoming;
}
