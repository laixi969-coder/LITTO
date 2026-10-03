import { all } from "./db.ts";
import { HttpError } from "./util.ts";

export const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";

/** The enabled SSO connection that owns this email's domain (if any). */
export function connectionForEmail(email: string) {
    const d = domainOf(email);
    if (!d) return null;
    return all("SELECT * FROM sso_connections WHERE enabled=1").find((c) => (JSON.parse(c.domains) as string[]).map((x) => x.toLowerCase()).includes(d)) ?? null;
}

/** Enforced domains must sign in through their IdP: OTP and generic OAuth refuse them (403 sso_required). */
export function assertNotSsoEnforced(email: string) {
    const c = connectionForEmail(email);
    if (c?.enforce) throw new HttpError(403, `${domainOf(email)} requires single sign-on (${c.name})`, "sso_required", { connectionId: c.id });
}
