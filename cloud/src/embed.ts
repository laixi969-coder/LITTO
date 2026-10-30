/**
 * Embedding surface for the MILI MILI server (Toonflow's Express app).
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
import { sweepWorkspacePurges } from "./storage.ts";
import { recoverInterruptedRenders } from "./domain/nle-render.ts";
export { configureWorkspacePurge } from "./storage.ts";
export { storage, mediaView, saveMedia, sniff } from "./storage.ts";

export { resolveSession, modelPermissions, requireModelAccess } from "./auth.ts";
export { validMutationSource } from "./requestSecurity.ts";
export type { Auth, Role } from "./auth.ts";
export { scoped, get as dbGet, all as dbAll, run as dbRun, audit, setting } from "./db.ts";
export { recordUsage } from "./usage.ts";
export { configureWorkspaceMedia, linkWorkspaceProject, enqueueWorkspaceMedia, prepareWorkspaceShot } from "./workspaceMedia.ts";
export { cancelJob, jobView } from "./jobs.ts";
export type { GenRequest, GenResult } from "./providers/adapter.ts";
export { encrypt, decrypt } from "./crypto.ts";
export { workspaceProduction, readWorkspaceAsset, importWorkspaceKeyframe, importWorkspaceAudio, importWorkspaceSpeechTake, extractContinuationFrame } from "./domain/workspaceProduction.ts";
export { prepareKeyframeApproval, approveKeyframes } from "./domain/keyframeApproval.ts";
export { prepareProductionDecision, applyProductionDecision } from "./domain/productionDecision.ts";
export { inspectFinalQuality, finalQualityView, sequenceFingerprint, assertSpeechExport } from "./domain/finalQuality.ts";
export { shotFingerprint } from "./domain/realism.ts";
export { continuityPlanningIssues } from "./domain/continuity.ts";
export { assertSpeechPlan, speechPlanningIssues, shotDialogueMode } from "./domain/speechPlanning.ts";
export { editView, getEdit } from "./domain/nle.ts";
export { cutPairSchema, soundBridgeSchema, suggestCuts, previewCut, soundBridge } from "./domain/cutEditing.ts";
export { startRender } from "./domain/assembly.ts";
export { renderOptionsSchema, waitNleRender } from "./domain/nle-render.ts";
export { configureWorkspaceVision } from "./domain/qc-vision.ts";
export { inspectAd } from "./domain/adReview.ts";
export { accountOf, adminAdjust, creditsFor, hold, charge, release } from "./credits.ts";
export { trialProviderId, trialStatus, trialModelAccess, reserveTrialTokens, settleTrialTokens } from "./trial.ts";
export const cloudRequestListener = getRequestListener(app.fetch);

let started = false;
export function initCloud() {
    if (started) return;
    started = true;
    recoverInterruptedRenders();
    seedProviders();
    seedSkills();
    startWorker();
    void sweepWorkspacePurges();
    setInterval(() => void sweepWorkspacePurges(), 60_000).unref();
    setInterval(() => sweepUploads(), 3600_000).unref();
}

export const SESSION_COOKIE = "milimili_session";
/** Pull the session token from an Express/Node request (Authorization: Bearer … or the session cookie). */
export function tokenFromHeaders(h: { authorization?: string; cookie?: string }): string | null {
    if (h.authorization?.startsWith("Bearer ")) return h.authorization.slice(7);
    const m = h.cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
}

export { inspectProductionQuality, productionQualityView } from "./domain/qualityInspection.ts";
