import { all, audit, get, run, scoped, setting, tx } from "./db.ts";
import { charge, creditsFor, hold, release } from "./credits.ts";
import { ADAPTERS, credentialFor, markCredential, modelView, secretOf } from "./providers/registry.ts";
import { route, resolvePolicy } from "./providers/router.ts";
import type { GenRequest, GenResult } from "./providers/adapter.ts";
import { saveMedia, storage } from "./storage.ts";
import { bad, conflict, j, log, now, sha256, sleep, ulid } from "./util.ts";
import { config } from "./config.ts";
import { onJobSucceeded } from "./domain/lifecycle.ts";
import { inc, observe } from "./metrics.ts";
import { assertSpeechPlan } from "./domain/speechPlanning.ts";
import { shotFingerprint } from "./domain/realism.ts";
import { requireModelAccess } from "./auth.ts";

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
    requireModelAccess(spec.createdBy);
    if (spec.idempotencyKey) {
        const ex = get("SELECT response FROM idempotency_keys WHERE workspace_id=? AND key=?", spec.workspaceId, spec.idempotencyKey);
        if (ex) {
            const receipt = JSON.parse(ex.response);
            if (receipt.cancelled) throw conflict("生成请求已取消，不会重新提交", "cancelled");
            const previous = scoped(spec.workspaceId).get("generation_jobs", receipt.id);
            if (!previous) throw conflict("原生成任务已不存在，请核查后重试", "missing_job");
            if (previous.projectId !== spec.projectId || previous.kind !== spec.kind || previous.modelId !== spec.modelId
                || (previous.targetType ?? null) !== (spec.targetType ?? null) || (previous.targetId ?? null) !== (spec.targetId ?? null)) {
                throw conflict("请求 ID 与原生成任务的项目、模型或目标不一致", "request_conflict");
            }
            return { ...jobView(previous), reused: true };
        }
    }
    const model = get("SELECT * FROM models m WHERE id=?", spec.modelId);
    if (!model || model.status !== "active") throw bad("model unavailable");
    const limits = JSON.parse(model.limits);
    if (limits.workspaceId && limits.workspaceId !== spec.workspaceId) throw bad("model unavailable");
    if (spec.projectId && !scoped(spec.workspaceId).get("projects", spec.projectId)) throw bad("project unavailable");
    for (const reference of spec.inputRefs) {
        if (reference.sent && reference.mediaId) inputMedia(spec.workspaceId, spec.projectId, reference.mediaId);
    }
    if (spec.targetType === "shot" && (!spec.targetId || scoped(spec.workspaceId).get("shots", spec.targetId)?.projectId !== spec.projectId)) throw bad("生成目标镜头不属于当前项目");
    if (spec.targetType === "shot" && spec.kind === "video") {
        const scope = scoped(spec.workspaceId), shot = scope.get("shots", spec.targetId!)!;
        assertSpeechPlan(scope, shot);
        if (shot.creativeBrief?.dialogue.lines.length && spec.parameters.specFingerprint !== shotFingerprint(scope, shot.id)) throw conflict("对白规划与提交版本不一致，请重新编译，不能直接重试旧参数", "speech_plan_stale");
    }
    if (spec.parameters.candidateBatchId) {
        const batch = scoped(spec.workspaceId).get("candidate_batches", spec.parameters.candidateBatchId);
        if (!batch || batch.projectId !== spec.projectId || batch.kind !== spec.kind
            || spec.targetType !== "shot" || batch.shotId !== spec.targetId) throw bad("候选批次与生成项目、镜头或媒体类型不一致");
        if (spec.parameters.fingerprint && batch.promptFingerprint !== spec.parameters.fingerprint) throw conflict("镜头规格已改变，请新建候选批次", "candidate_batch_changed");
    }
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

export const jobView = (r: any) => {
    if (!r) return r;
    const s = scoped(r.workspaceId);
    const request = r.parameters?.request ?? {};
    const assetId = /^assets\/characters\/([^/]+)\/?$/.exec(request.outputDirectory ?? "")?.[1];
    const asset = assetId ? s.get("assets", assetId) : undefined;
    const shot = r.targetType === "shot" ? s.get("shots", r.targetId) : undefined;
    const label = request.outputName || (shot && shot.projectId === r.projectId ? `${shot.title || `镜头 ${shot.ord + 1}`} · ${r.kind === "video" ? "视频" : "关键帧"}` : asset && asset.projectId === r.projectId ? `${asset.name} · 角色参考` : undefined);
    return {
    label,
    id: r.id, projectId: r.projectId, kind: r.kind, targetType: r.targetType, targetId: r.targetId, providerId: r.providerId, modelId: r.modelId, status: r.status, attempts: r.attempts,
    compiledPrompt: r.compiledPrompt, parameters: { ...r.parameters, negativePrompt: undefined }, seed: r.seed, estimatedCost: r.estimatedCost, actualCost: r.actualCost, userCharge: r.userCharge, durationMs: r.durationMs,
    error: r.error, parentJobId: r.parentJobId, fallbackChain: r.fallbackChain, createdAt: r.createdAt, finishedAt: r.finishedAt,
    settled: !inflight.has(r.id),
    inputRefs: r.inputRefs ?? [],
    files: all("SELECT meta FROM generation_outputs WHERE job_id=? ORDER BY idx", r.id).flatMap(o => { const m = JSON.parse(o.meta); return m.workspacePath ? [{ path: m.workspacePath, mimeType: m.mime, mediaType: r.kind }] : []; }),
    outputs: all("SELECT media_id, idx FROM generation_outputs WHERE job_id=? ORDER BY idx", r.id).map((o) => o.media_id),
    };
};

// ---------------- worker ----------------
let timer: NodeJS.Timeout | null = null;
let ticking = false;
const inflight = new Set<string>();
const controllers = new Map<string, AbortController>();

export function startWorker() {
    // 回执或已交付文件可恢复；没有回执的提交结果仍待核查，不能当作未受理重发。
    for (const job of all("SELECT * FROM generation_jobs WHERE status='RUNNING' AND provider_id='workspaceMedia'")) {
        tx(() => {
            const parameters = JSON.parse(job.parameters ?? "{}");
            if (workspaceResumable(parameters)) {
                run("UPDATE generation_jobs SET status='QUEUED',run_after=?,finished_at=NULL,error=NULL WHERE id=?", now(), job.id);
                return;
            }
            // 没有回执不等于未受理；旧适配器重启后也必须阻止手动重发。
            if (!parameters.remoteTask) parameters.remoteTask = { status: "unknown", updatedAt: now() };
            run("UPDATE generation_jobs SET parameters=? WHERE id=?", j(parameters), job.id);
            run("UPDATE generation_jobs SET status='FAILED', finished_at=?, held=0, error=? WHERE id=?", now(), "服务重启，供应商结果待核查；未自动重发，请核查后重试", job.id);
            release(job.workspace_id, job.id, job.held, "server interrupted");
        });
    }
    // 兼容旧版本因重启标失败的已提交任务，沿用原 ID 与冻结额，只恢复原结果。
    for (const job of all("SELECT * FROM generation_jobs WHERE provider_id='workspaceMedia' AND status IN ('FAILED','TIMEOUT') AND (error LIKE '服务重启，供应商结果待核查%' OR error LIKE '供应商结果待核查%')")) {
        if (workspaceResumable(JSON.parse(job.parameters ?? "{}"))) run("UPDATE generation_jobs SET status='QUEUED',run_after=?,finished_at=NULL,error=NULL WHERE id=?", now(), job.id);
    }
    // 无句柄的已提交请求不能证明未受理，重启也不能重新付费提交。
    run("UPDATE generation_jobs SET status='FAILED', parameters=json_set(COALESCE(parameters,'{}'), '$.remoteTask.status', 'unknown'), finished_at=?, error='提交结果待核查，未自动重发' WHERE status='RUNNING' AND provider_task_id IS NULL", now());
    // 有远端任务号的请求仅恢复查询。
    run("UPDATE generation_jobs SET status='QUEUED', run_after=? WHERE status='RUNNING'", now());
    if (!timer) timer = setInterval(() => void tick(), config.workerPollMs);
}
export const stopWorker = () => { if (timer) clearInterval(timer); timer = null; };
export const kick = () => { if (timer) setTimeout(() => void tick(), 0); };

export async function settleWorkspaceJobs(workspaceId: string) {
    for (const job of all("SELECT id FROM generation_jobs WHERE workspace_id=? AND status IN ('QUEUED','RUNNING')", workspaceId)) cancelJob(workspaceId, job.id, "workspaceDeletion");
    if (all("SELECT id FROM generation_jobs WHERE workspace_id=?", workspaceId).some(job => inflight.has(job.id))) throw conflict("等待运行任务停止后重试清理");
}

function runningCount(providerId: string) {
    return all("SELECT id FROM generation_jobs WHERE provider_id=? AND status='RUNNING'", providerId).length;
}

function workspaceResumable(parameters: Record<string, any>) {
    const task = parameters.remoteTask;
    return task && !["failed", "rejected", "blocked"].includes(String(task.status).toLowerCase())
        && (typeof task.id === "string" && !!task.id || task.assets?.length || task.files?.length);
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
            const resuming = row.provider_id === "workspaceMedia" && workspaceResumable(JSON.parse(row.parameters ?? "{}"));
            run("UPDATE generation_jobs SET status='RUNNING', started_at=COALESCE(started_at,?), attempts=attempts+? WHERE id=? AND status='QUEUED'", now(), resuming ? 0 : 1, row.id);
            inflight.add(row.id);
            void execute(row.id).finally(() => inflight.delete(row.id));
        }
    } finally {
        ticking = false;
    }
}

function inputMedia(workspaceId: string, projectId: string | null, mediaId: string) {
    const media = scoped(workspaceId).get("media", mediaId);
    if (!media || media.projectId !== projectId) throw Object.assign(bad("生成参考素材不属于当前项目或已被删除"), { retryable: false, fallbackAllowed: false });
    return media;
}

async function loadInputs(workspaceId: string, projectId: string | null, refs: any[]) {
    const out: GenRequest["inputs"] = [];
    for (const r of refs) {
        if (!r.sent || !r.mediaId) continue;
        const m = inputMedia(workspaceId, projectId, r.mediaId);
        out.push({ role: r.role, mime: m.mime, data: await storage.get(m.storageKey), weight: r.weight });
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
        if (!raw.provider_task_id && !job.parameters?.remoteTask) requireModelAccess(job.createdBy);
        if (adapter.requiresKey && !cred) throw Object.assign(new Error("no credential for provider"), { retryable: false });
        const apiKey = cred ? secretOf(cred) : undefined;
        const p = job.parameters ?? {};
        if (job.kind === "video" && job.targetType === "shot" && !raw.provider_task_id && !p.remoteTask) {
            const shot = s.get("shots", job.targetId);
            try {
                if (!shot || shot.projectId !== job.projectId) throw bad("排队镜头已失效");
                assertSpeechPlan(s, shot);
                if (shot.creativeBrief?.dialogue.lines.length && p.specFingerprint !== shotFingerprint(s, shot.id)) throw conflict("排队后对白或镜头规划已改变，停止旧任务，不自动重新提交", "speech_plan_stale");
            } catch (cause) { throw Object.assign(cause as Error, { retryable: false, fallbackAllowed: false }); }
        }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(prov.timeout_ms)]);
        const req: GenRequest = { signal, context: { jobId, workspaceId: job.workspaceId, projectId: job.projectId, userId: job.createdBy }, kind: job.kind, externalModelId: model.external_model_id, prompt: job.compiledPrompt, negativePrompt: p.negativePrompt, params: { ...p, seed: job.seed }, inputs: job.providerId === "workspaceMedia" && p.remoteTask ? [] : await loadInputs(job.workspaceId, job.projectId, job.inputRefs ?? []), apiKey, baseUrl: prov.base_url, attempt: job.attempts, label: p.label };
        let result: GenResult | null = null;
        let taskId: string | null = raw.provider_task_id; // resume after restart
        const deadline = started + prov.timeout_ms;
        if (!taskId) {
            if (job.providerId !== "workspaceMedia") {
                if (p.remoteTask && !["failed", "rejected"].includes(p.remoteTask.status)) throw Object.assign(new Error("供应商提交结果待核查，不能重复提交"), { retryable: false, fallbackAllowed: false });
                run("UPDATE generation_jobs SET parameters=? WHERE id=?", j({ ...p, remoteTask: { status: "submitting", updatedAt: now() } }), jobId);
            }
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
                if (hook.status === "failed") {
                    run("UPDATE generation_jobs SET parameters=?, provider_task_id=NULL WHERE id=?", j({ ...p, remoteTask: { status: "failed", updatedAt: now() } }), jobId);
                    throw Object.assign(new Error(hook.error ?? "provider reported failure"), { retryable: false });
                }
                const outputs = [];
                for (const o of hook.outputs ?? []) outputs.push(o.b64 ? { data: Buffer.from(o.b64, "base64"), mime: o.mime ?? "image/png", duration: o.duration } : await (async () => { const r = await fetch(o.url); if (!r.ok) throw new Error(`callback output HTTP ${r.status}`); return { data: Buffer.from(await r.arrayBuffer()), mime: o.mime ?? r.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream", duration: o.duration }; })());
                result = { outputs, costUsd: typeof hook.costUsd === "number" && Number.isFinite(hook.costUsd) && hook.costUsd >= 0 ? hook.costUsd : null };
                break;
            }
            const t0 = Date.now();
            const r = await adapter.poll(taskId!, { apiKey, baseUrl: prov.base_url, signal });
            observe(`provider_${prov.id}_poll_ms`, Date.now() - t0);
            if (r.status === "done") result = r.result;
            else if (r.status === "failed") {
                run("UPDATE generation_jobs SET parameters=?, provider_task_id=NULL WHERE id=?", j({ ...p, remoteTask: { status: "failed", updatedAt: now() } }), jobId);
                throw Object.assign(new Error(r.error), { retryable: r.retryable });
            }
            else await sleep(Math.min(config.workerPollMs, 250));
        }
        if (get("SELECT status FROM generation_jobs WHERE id=?", jobId)?.status === "CANCELLED") return;
        await finish(job, result, Date.now() - started);
        if (cred) markCredential(cred.id, null);
    } catch (e) {
        const err = e as Error & { retryable?: boolean; timeout?: boolean; fallbackAllowed?: boolean };
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
        const existing = get("SELECT o.media_id,m.hash FROM generation_outputs o JOIN media m ON m.id=o.media_id WHERE o.job_id=? AND o.idx=?", job.id, i);
        if (existing) {
            if (existing.hash !== sha256(o.data)) throw Object.assign(new Error("原任务输出已登记且字节不同，停止恢复，不重复登记或扣费"), { retryable: false, fallbackAllowed: false });
            mediaIds.push(existing.media_id);
            continue;
        }
        const m = await saveMedia(job.workspaceId, job.projectId, o.data, { source: "generation", mime: o.mime, duration: o.duration, allowUnsniffed: false });
        mediaIds.push(m.id);
        s.insert("generation_outputs", { job_id: job.id, media_id: m.id, idx: i, meta: { seed: job.seed, model: job.modelId, workspacePath: o.workspacePath, mime: o.mime } });
    }
    const userCharge = creditsFor(result.costUsd);
    tx(() => {
        // A cancel may have raced us; the guard keeps the ledger consistent.
        const cur = get("SELECT status,held FROM generation_jobs WHERE id=?", job.id)!;
        if (cur.status === "CANCELLED" || cur.status === "SUCCEEDED") return;
        run("UPDATE generation_jobs SET status='SUCCEEDED', actual_cost=?, user_charge=?, duration_ms=?, finished_at=?, held=0, error=NULL WHERE id=?", result.costUsd, userCharge, durationMs, now(), job.id);
        charge(job.workspaceId, job.id, cur.held, userCharge, result.costUsd);
        onJobSucceeded(s, scoped(job.workspaceId).get("generation_jobs", job.id, true)!, mediaIds);
    });
}

async function fail(job: any, err: Error & { retryable?: boolean; timeout?: boolean; fallbackAllowed?: boolean }, durationMs: number) {
    const cur = get("SELECT * FROM generation_jobs WHERE id=?", job.id)!;
    if (cur.status === "CANCELLED") return;
    const p = cur.parameters ? JSON.parse(cur.parameters) : {};
    if (cur.provider_id === "workspaceMedia" && p.remoteTask?.id && /prompt length cannot exceed 3072 characters/i.test(err.message)) {
        // 供应商已返回确定的提示词限制；保留回执供核查，不能把错误当成可恢复的查询。
        p.remoteTask.status = "blocked";
        run("UPDATE generation_jobs SET parameters=?,status='FAILED',error=?,duration_ms=?,finished_at=? WHERE id=?", j(p), "供应商提示词超过 3072 字符。请重新编译并检查当前模型的最终长度；原供应商任务已保留，请先核查，不会自动重发。", durationMs, now(), job.id);
        return;
    }
    if (cur.provider_id === "workspaceMedia" && workspaceResumable(p) && err.retryable !== false) {
        // ACT: 连续查询失败最多恢复两次；超时或三次失败后保留原回执，人工恢复只查询原任务。
        p.recoveryFailures = Number(p.recoveryFailures || 0) + 1;
        if (!err.timeout && p.recoveryFailures < 3) {
            run("UPDATE generation_jobs SET status='QUEUED',run_after=?,error=?,parameters=? WHERE id=?", new Date(Date.now() + 15000).toISOString(), `原任务查询失败（${p.recoveryFailures}/3）：${err.message}；将再次查询，不会重新生成`.slice(0, 300), j(p), job.id);
            return;
        }
        run("UPDATE generation_jobs SET parameters=?,status=?,error=?,duration_ms=?,finished_at=? WHERE id=?", j(p), err.timeout ? "TIMEOUT" : "FAILED", `原任务查询${err.timeout ? "超时" : "连续失败"}，供应商结果待核查，未重新提交：${err.message}`.slice(0, 300), durationMs, now(), job.id);
        return;
    }
    if (cur.provider_id === "workspaceMedia" && workspaceResumable(p) && err.retryable === false) {
        p.remoteTask.status = "blocked";
        run("UPDATE generation_jobs SET parameters=? WHERE id=?", j(p), job.id);
    }
    const remoteUnresolved = !!cur.provider_task_id || p.remoteTask && !["failed", "rejected"].includes(p.remoteTask.status);
    const retryable = err.retryable !== false && (!remoteUnresolved || !!cur.provider_task_id);
    inc(`provider_${cur.provider_id}_errors`);
    if (retryable && cur.attempts < cur.max_attempts) {
        inc("job_retries");
        const prov = get("SELECT retry_policy FROM providers WHERE id=?", cur.provider_id)!;
        const backoff = (JSON.parse(prov.retry_policy).backoffMs ?? 500) * cur.attempts;
        run("UPDATE generation_jobs SET status='QUEUED', run_after=?, error=? WHERE id=?", new Date(Date.now() + backoff).toISOString(), err.message.slice(0, 300), job.id);
        return;
    }
    // Provider exhausted → fallback to the next-best model that satisfies the same roles.
    if (!remoteUnresolved && err.fallbackAllowed !== false && p.fallbackAllowed !== false) {
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
    if (remoteUnresolved) {
        run("UPDATE generation_jobs SET status=?, error=?, duration_ms=?, finished_at=? WHERE id=?", err.timeout ? "TIMEOUT" : "FAILED", `供应商结果待核查；未重新提交：${err.message}`.slice(0, 300), durationMs, now(), job.id);
        return;
    }
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
    requireModelAccess(actor);
    const o = scoped(workspaceId).get("generation_jobs", id, true);
    if (!o) throw bad("job not found");
    if (["QUEUED", "RUNNING"].includes(o.status)) throw conflict("job still active");
    if (o.status === "SUCCEEDED") throw conflict("任务已完成，请复用已有结果", "job_already_completed");
    if (inflight.has(id)) throw conflict("原任务仍在停止或收取结果，不能同时重发", "job_still_settling");
    const task = o.parameters?.remoteTask;
    const workspaceRecovery = o.providerId === "workspaceMedia" && task && !["failed", "rejected"].includes(String(task.status).toLowerCase())
        && (task.id || task.assets?.length || task.files?.length);
    if (o.providerTaskId || workspaceRecovery) {
        tx(() => {
            const settled = get("SELECT id FROM credit_ledger WHERE workspace_id=? AND job_id=? AND type='GENERATION_CHARGE'", workspaceId, id);
            const held = o.held || (settled ? 0 : estimate(o.modelId, o.kind, o.parameters).credits);
            if (!o.held) hold(workspaceId, id, held);
            const parameters = workspaceRecovery ? { ...o.parameters, recoveryFailures: 0, remoteTask: { ...task, status: "recovering" } } : o.parameters;
            run("UPDATE generation_jobs SET status='QUEUED', attempts=?, held=?, run_after=?, finished_at=NULL,error=NULL,parameters=? WHERE id=?", workspaceRecovery ? o.attempts : 0, held, now(), j(parameters), id);
        });
        kick();
        return { ...jobView(scoped(workspaceId).get("generation_jobs", id, true)), reused: true };
    }
    if (o.parameters?.remoteTask && !["failed", "rejected"].includes(o.parameters.remoteTask.status)) throw conflict("供应商结果尚未核清或已完成，请先查询并恢复原任务，不得重复提交", "remote_result_unresolved");
    const { negativePrompt, label, remoteTask, ...rest } = o.parameters ?? {};
    return enqueue({ workspaceId, projectId: o.projectId, kind: o.kind, targetType: o.targetType, targetId: o.targetId, modelId: o.fallbackChain?.[0] ?? o.modelId, compiledPrompt: o.compiledPrompt, negativePrompt, parameters: rest, inputRefs: o.inputRefs ?? [], seed: o.seed, createdBy: actor, parentJobId: o.id, fallbackAllowed: o.parameters?.fallbackAllowed !== false, label, idempotencyKey: `retry:${o.id}` });
}
void setting; void conflict;
