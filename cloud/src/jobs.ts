import { all, audit, get, run, scoped, setting, tx } from "./db.ts";
import { charge, creditsFor, hold, release } from "./credits.ts";
import { ADAPTERS, credentialFor, markCredential, modelView, secretOf } from "./providers/registry.ts";
import { route, resolvePolicy } from "./providers/router.ts";
import type { GenRequest, GenResult } from "./providers/adapter.ts";
import { saveMedia, storage } from "./storage.ts";
import { bad, conflict, j, log, now, sleep, ulid } from "./util.ts";
import { config } from "./config.ts";
import { onJobSucceeded } from "./domain/lifecycle.ts";
import { inc, observe } from "./metrics.ts";

export type JobSpec = {
    workspaceId: string; projectId: string | null; kind: "image" | "video"; targetType?: string; targetId?: string; modelId: string;
    compiledPrompt: string; negativePrompt?: string; parameters: Record<string, any>; inputRefs: { referenceId: string; mediaId: string | null; role: string; weight: number; sent: boolean }[];
    seed?: number; createdBy: string; parentJobId?: string; fallbackAllowed?: boolean; idempotencyKey?: string; label?: string;
};

export function estimate(modelId: string, kind: string, params: Record<string, any>) {
    const m = modelView(get("SELECT * FROM models WHERE id=?", modelId)!);
    const rate = kind === "video" ? m.price.perSecond : m.price.perImage;
    const usd = typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate * Number(kind === "video" ? params.duration ?? 4 : params.count ?? 1) : null;
    return { usd, credits: creditsFor(usd) };
}

/** Creating a job never waits for the provider. Credits are held up-front; failure releases the hold. */
export function enqueue(spec: JobSpec) {
    if (spec.idempotencyKey) {
        const ex = get("SELECT response FROM idempotency_keys WHERE workspace_id=? AND key=?", spec.workspaceId, spec.idempotencyKey);
        if (ex) return JSON.parse(ex.response);
    }
    const model = get("SELECT * FROM models m WHERE id=?", spec.modelId);
    if (!model || model.status !== "active") throw bad("model unavailable");
    const limits = JSON.parse(model.limits);
    if (limits.workspaceId && limits.workspaceId !== spec.workspaceId) throw bad("model unavailable");
    if (spec.projectId && !scoped(spec.workspaceId).get("projects", spec.projectId)) throw bad("project unavailable");
    const prov = get("SELECT * FROM providers WHERE id=?", model.provider_id)!;
    const est = estimate(spec.modelId, spec.kind, spec.parameters);
    const id = ulid();
    const retry = JSON.parse(prov.retry_policy);
    const seed = spec.seed ?? Math.floor(Math.random() * 2 ** 31);
    const created = tx(() => {
        hold(spec.workspaceId, id, est.credits);
        scoped(spec.workspaceId).insert("generation_jobs", {
            id, project_id: spec.projectId, kind: spec.kind, target_type: spec.targetType ?? null, target_id: spec.targetId ?? null, provider_id: prov.id, model_id: spec.modelId,
            model_version: model.external_model_id, compiled_prompt: spec.compiledPrompt, parameters: { ...spec.parameters, negativePrompt: spec.negativePrompt, label: spec.label, fallbackAllowed: spec.fallbackAllowed ?? true, excluded: [] },
            input_refs: spec.inputRefs, seed, status: "QUEUED", attempts: 0, max_attempts: retry.maxAttempts ?? 2, run_after: now(), estimated_cost: est.usd, held: est.credits, parent_job_id: spec.parentJobId ?? null, fallback_chain: [spec.modelId], created_by: spec.createdBy,
        });
        const out = jobView(scoped(spec.workspaceId).get("generation_jobs", id)!);
        if (spec.idempotencyKey) run("INSERT INTO idempotency_keys VALUES(?,?,?,?)", spec.idempotencyKey!, spec.workspaceId, j(out), now());
        return out;
    });
    kick();
    return created;
}

export const jobView = (r: any) => r && {
    id: r.id, projectId: r.projectId, kind: r.kind, targetType: r.targetType, targetId: r.targetId, providerId: r.providerId, modelId: r.modelId, status: r.status, attempts: r.attempts,
    compiledPrompt: r.compiledPrompt, parameters: { ...r.parameters, negativePrompt: undefined }, seed: r.seed, estimatedCost: r.estimatedCost, actualCost: r.actualCost, userCharge: r.userCharge, durationMs: r.durationMs,
    error: r.error, parentJobId: r.parentJobId, fallbackChain: r.fallbackChain, createdAt: r.createdAt, finishedAt: r.finishedAt,
    settled: !inflight.has(r.id),
    files: all("SELECT meta FROM generation_outputs WHERE job_id=? ORDER BY idx", r.id).flatMap(o => { const m = JSON.parse(o.meta); return m.workspacePath ? [{ path: m.workspacePath, mimeType: m.mime, mediaType: r.kind }] : []; }),
    outputs: all("SELECT media_id, idx FROM generation_outputs WHERE job_id=? ORDER BY idx", r.id).map((o) => o.media_id),
};

// ---------------- worker ----------------
let timer: NodeJS.Timeout | null = null;
let ticking = false;
const inflight = new Set<string>();
const controllers = new Map<string, AbortController>();

export function startWorker() {
    // ACT: 无上游任务句柄的脚本不能安全重发，重启后保留失败记录，交由用户决定重试。
    for (const job of all("SELECT * FROM generation_jobs WHERE status='RUNNING' AND provider_id='workspaceMedia'")) {
        tx(() => {
            run("UPDATE generation_jobs SET status='FAILED', finished_at=?, held=0, error=? WHERE id=?", now(), "服务重启，供应商结果待核查；未自动重发，请核查后重试", job.id);
            release(job.workspace_id, job.id, job.held, "server interrupted");
        });
    }
    // Crash recovery: anything RUNNING at boot either resumes polling (has provider task) or re-queues.
    run("UPDATE generation_jobs SET status='QUEUED', run_after=? WHERE status='RUNNING'", now());
    if (!timer) timer = setInterval(() => void tick(), config.workerPollMs);
}
export const stopWorker = () => { if (timer) clearInterval(timer); timer = null; };
export const kick = () => { if (timer) setTimeout(() => void tick(), 0); };

function runningCount(providerId: string) {
    return all("SELECT id FROM generation_jobs WHERE provider_id=? AND status='RUNNING'", providerId).length;
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const due = all("SELECT * FROM generation_jobs WHERE status='QUEUED' AND run_after<=? ORDER BY created_at LIMIT 50", now());
        for (const row of due) {
            if (inflight.has(row.id)) continue;
            const prov = get("SELECT * FROM providers WHERE id=?", row.provider_id);
            if (!prov || runningCount(prov.id) >= prov.concurrency) continue; // provider rate limit
            run("UPDATE generation_jobs SET status='RUNNING', started_at=COALESCE(started_at,?), attempts=attempts+1 WHERE id=? AND status='QUEUED'", now(), row.id);
            inflight.add(row.id);
            void execute(row.id).finally(() => inflight.delete(row.id));
        }
    } finally {
        ticking = false;
    }
}

async function loadInputs(refs: any[]) {
    const out: GenRequest["inputs"] = [];
    for (const r of refs) {
        if (!r.sent || !r.mediaId) continue;
        const m = get("SELECT * FROM media WHERE id=?", r.mediaId);
        if (m) out.push({ role: r.role, mime: m.mime, data: await storage.get(m.storage_key), weight: r.weight });
    }
    return out;
}

async function execute(jobId: string) {
    const controller = new AbortController();
    controllers.set(jobId, controller);
    const raw = get("SELECT * FROM generation_jobs WHERE id=?", jobId)!;
    const s = scoped(raw.workspace_id);
    const job = s.get("generation_jobs", jobId, true)!;
    const started = Date.now();
    observe("job_wait_ms", started - new Date(job.createdAt).getTime());
    const model = get("SELECT * FROM models WHERE id=?", job.modelId)!;
    const prov = get("SELECT * FROM providers WHERE id=?", job.providerId)!;
    const adapter = ADAPTERS[prov.adapter];
    const cred = credentialFor(prov.id, job.workspaceId, job.projectId);
    try {
        if (adapter.requiresKey && !cred) throw Object.assign(new Error("no credential for provider"), { retryable: false });
        const apiKey = cred ? secretOf(cred) : undefined;
        const p = job.parameters ?? {};
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(prov.timeout_ms)]);
        const req: GenRequest = { signal, context: { jobId, workspaceId: job.workspaceId, projectId: job.projectId, userId: job.createdBy }, kind: job.kind, externalModelId: model.external_model_id, prompt: job.compiledPrompt, negativePrompt: p.negativePrompt, params: { ...p, seed: job.seed }, inputs: await loadInputs(job.inputRefs ?? []), apiKey, baseUrl: prov.base_url, attempt: job.attempts, label: p.label };
        let result: GenResult | null = null;
        let taskId: string | null = raw.provider_task_id; // resume after restart
        const deadline = started + prov.timeout_ms;
        if (!taskId) {
            const sub = await adapter.submit(req);
            if ("done" in sub) result = sub.done;
            else { taskId = sub.taskId; run("UPDATE generation_jobs SET provider_task_id=? WHERE id=?", taskId, jobId); }
        }
        while (!result) {
            if (get("SELECT status FROM generation_jobs WHERE id=?", jobId)?.status === "CANCELLED") return;
            if (Date.now() > deadline) throw Object.assign(new Error(`timeout after ${prov.timeout_ms}ms`), { timeout: true });
            // A provider callback (webhook) wins over polling.
            const ev = get("SELECT payload FROM webhook_events WHERE job_id=? ORDER BY id DESC LIMIT 1", jobId);
            if (ev) {
                const hook = JSON.parse(ev.payload);
                if (hook.status === "failed") throw Object.assign(new Error(hook.error ?? "provider reported failure"), { retryable: false });
                const outputs = [];
                for (const o of hook.outputs ?? []) outputs.push(o.b64 ? { data: Buffer.from(o.b64, "base64"), mime: o.mime ?? "image/png", duration: o.duration } : await (async () => { const r = await fetch(o.url); if (!r.ok) throw new Error(`callback output HTTP ${r.status}`); return { data: Buffer.from(await r.arrayBuffer()), mime: o.mime ?? r.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream", duration: o.duration }; })());
                result = { outputs, costUsd: typeof hook.costUsd === "number" && Number.isFinite(hook.costUsd) && hook.costUsd >= 0 ? hook.costUsd : null };
                break;
            }
            const t0 = Date.now();
            const r = await adapter.poll(taskId!, { apiKey, baseUrl: prov.base_url, signal });
            observe(`provider_${prov.id}_poll_ms`, Date.now() - t0);
            if (r.status === "done") result = r.result;
            else if (r.status === "failed") throw Object.assign(new Error(r.error), { retryable: r.retryable });
            else await sleep(Math.min(config.workerPollMs, 250));
        }
        if (get("SELECT status FROM generation_jobs WHERE id=?", jobId)?.status === "CANCELLED") return;
        await finish(job, result, Date.now() - started);
        if (cred) markCredential(cred.id, null);
    } catch (e) {
        const err = e as Error & { retryable?: boolean; timeout?: boolean };
        if (cred) markCredential(cred.id, err.message);
        if (err.name === "TimeoutError") err.timeout = true;
        await fail(job, err, Date.now() - started);
    } finally {
        controllers.delete(jobId);
    }
}

async function finish(job: any, result: GenResult, durationMs: number) {
    observe("job_run_ms", durationMs);
    inc(`job_succeeded_model_${job.modelId}`);
    const s = scoped(job.workspaceId);
    const mediaIds: string[] = [];
    for (const [i, o] of result.outputs.entries()) {
        const m = await saveMedia(job.workspaceId, job.projectId, o.data, { source: "generation", mime: o.mime, duration: o.duration, allowUnsniffed: false });
        mediaIds.push(m.id);
        s.insert("generation_outputs", { job_id: job.id, media_id: m.id, idx: i, meta: { seed: job.seed, model: job.modelId, workspacePath: o.workspacePath, mime: o.mime } });
    }
    const userCharge = creditsFor(result.costUsd);
    tx(() => {
        // A cancel may have raced us; the guard keeps the ledger consistent.
        const cur = get("SELECT status FROM generation_jobs WHERE id=?", job.id)!;
        if (cur.status === "CANCELLED") return;
        run("UPDATE generation_jobs SET status='SUCCEEDED', actual_cost=?, user_charge=?, duration_ms=?, finished_at=?, held=0, error=NULL WHERE id=?", result.costUsd, userCharge, durationMs, now(), job.id);
        charge(job.workspaceId, job.id, job.held, userCharge, result.costUsd);
    });
    if (get("SELECT status FROM generation_jobs WHERE id=?", job.id)?.status !== "SUCCEEDED") return;
    try {
        onJobSucceeded(s, scoped(job.workspaceId).get("generation_jobs", job.id, true)!, mediaIds);
    } catch (e) {
        log.error("post-success hook failed", (e as Error).message);
    }
}

async function fail(job: any, err: Error & { retryable?: boolean; timeout?: boolean }, durationMs: number) {
    const cur = get("SELECT * FROM generation_jobs WHERE id=?", job.id)!;
    if (cur.status === "CANCELLED") return;
    const retryable = err.retryable !== false;
    inc(`provider_${cur.provider_id}_errors`);
    if (retryable && cur.attempts < cur.max_attempts) {
        inc("job_retries");
        const prov = get("SELECT retry_policy FROM providers WHERE id=?", cur.provider_id)!;
        const backoff = (JSON.parse(prov.retry_policy).backoffMs ?? 500) * cur.attempts;
        run("UPDATE generation_jobs SET status='QUEUED', provider_task_id=NULL, run_after=?, error=? WHERE id=?", new Date(Date.now() + backoff).toISOString(), err.message.slice(0, 300), job.id);
        return;
    }
    // Provider exhausted → fallback to the next-best model that satisfies the same roles.
    const p = cur.parameters ? JSON.parse(cur.parameters) : {};
    if (p.fallbackAllowed !== false) {
        const roles = (JSON.parse(cur.input_refs ?? "[]") as any[]).map((r) => r.role);
        const excluded = [...(p.excluded ?? []), cur.model_id];
        const chain = JSON.parse(cur.fallback_chain ?? "[]");
        const pol = resolvePolicy(cur.workspace_id, cur.project_id);
        const model = modelView(get("SELECT * FROM models WHERE id=?", cur.model_id)!);
        const next = (model.fallbackModelId && !excluded.includes(model.fallbackModelId) ? { modelId: model.fallbackModelId, providerId: get("SELECT provider_id FROM models WHERE id=?", model.fallbackModelId)?.provider_id } : null) ?? route({ kind: cur.kind, workspaceId: cur.workspace_id, projectId: cur.project_id, roles, policy: { ...pol, imageModelId: undefined, videoModelId: undefined }, exclude: excluded }).chosen;
        if (next && get("SELECT 1 FROM models WHERE id=? AND status='active'", next.modelId)) {
            const nm = get("SELECT * FROM models WHERE id=?", next.modelId)!;
            const est = estimate(next.modelId, cur.kind, p);
            inc("job_fallbacks");
            // Re-price the hold for the fallback model.
            tx(() => {
                release(cur.workspace_id, cur.id, cur.held, "fallback re-price");
                hold(cur.workspace_id, cur.id, est.credits);
                run("UPDATE generation_jobs SET status='QUEUED', provider_id=?, model_id=?, model_version=?, attempts=0, provider_task_id=NULL, run_after=?, estimated_cost=?, held=?, parameters=?, fallback_chain=?, error=? WHERE id=?", nm.provider_id, next.modelId, nm.external_model_id, now(), est.usd, est.credits, j({ ...p, excluded }), j([...chain, next.modelId]), `fallback from ${cur.model_id}: ${err.message}`.slice(0, 300), cur.id);
            });
            return;
        }
    }
    inc(`job_failed_model_${cur.model_id}`);
    tx(() => {
        run("UPDATE generation_jobs SET status=?, error=?, duration_ms=?, finished_at=?, held=0 WHERE id=?", err.timeout ? "TIMEOUT" : "FAILED", err.message.slice(0, 300), durationMs, now(), job.id);
        release(cur.workspace_id, cur.id, cur.held, "job failed: refund hold");
    });
}

export function cancelJob(workspaceId: string, id: string, actor: string) {
    const j0 = scoped(workspaceId).get("generation_jobs", id, true);
    if (!j0) throw bad("job not found");
    if (!["QUEUED", "RUNNING"].includes(j0.status)) throw conflict(`job already ${j0.status}`);
    tx(() => {
        run("UPDATE generation_jobs SET status='CANCELLED', finished_at=?, held=0 WHERE id=?", now(), id);
        release(workspaceId, id, j0.held, "cancelled: refund hold");
    });
    controllers.get(id)?.abort();
    audit(actor, "job.cancel", id, null, workspaceId);
}

/** Manual retry creates a child job (history is never overwritten). */
export function retryJob(workspaceId: string, id: string, actor: string) {
    const o = scoped(workspaceId).get("generation_jobs", id, true);
    if (!o) throw bad("job not found");
    if (["QUEUED", "RUNNING"].includes(o.status)) throw conflict("job still active");
    const { negativePrompt, label, ...rest } = o.parameters ?? {};
    return enqueue({ workspaceId, projectId: o.projectId, kind: o.kind, targetType: o.targetType, targetId: o.targetId, modelId: o.fallbackChain?.[0] ?? o.modelId, compiledPrompt: o.compiledPrompt, negativePrompt, parameters: rest, inputRefs: o.inputRefs ?? [], seed: o.seed, createdBy: actor, parentJobId: o.id, fallbackAllowed: o.parameters?.fallbackAllowed !== false, label });
}
void setting; void conflict;
