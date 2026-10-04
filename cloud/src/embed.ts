/**
 * Embedding surface for the LITTO server (Toonflow's Express app).
 *   initCloud()           – migrate DB, seed providers/skills, start the job worker
 *   cloudRequestListener  – (req,res) handler for Express: app.use("/cloud", cloudRequestListener)
 *   resolveSession()      – cookie/bearer → { user, workspaceId, role } | null
 */
import { getRequestListener } from "@hono/node-server";
import { app } from "./app.ts";
import { startWorker } from "./jobs.ts";
import { seedProviders } from "./providers/registry.ts";
import { seedSkills } from "./domain/market-seed.ts";
import { sweepUploads } from "./routes/extra.ts";

export { resolveSession } from "./auth.ts";
export type { Auth, Role } from "./auth.ts";
export { scoped, get as dbGet, all as dbAll, run as dbRun, audit, setting } from "./db.ts";
export { recordUsage } from "./usage.ts";
export { configureWorkspaceMedia, linkWorkspaceProject, enqueueWorkspaceMedia } from "./workspaceMedia.ts";
export { cancelJob, jobView } from "./jobs.ts";
export type { GenRequest, GenResult } from "./providers/adapter.ts";
export { encrypt, decrypt } from "./crypto.ts";
export { accountOf, adminAdjust, creditsFor, hold, charge, release } from "./credits.ts";
export const cloudRequestListener = getRequestListener(app.fetch);

let started = false;
export function initCloud() {
    if (started) return;
    started = true;
    seedProviders();
    seedSkills();
    startWorker();
    setInterval(() => sweepUploads(), 3600_000).unref();
}

export const SESSION_COOKIE = "litto_session";
/** Pull the session token from an Express/Node request (Authorization: Bearer … or the session cookie). */
export function tokenFromHeaders(h: { authorization?: string; cookie?: string }): string | null {
    if (h.authorization?.startsWith("Bearer ")) return h.authorization.slice(7);
    const m = h.cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
}
