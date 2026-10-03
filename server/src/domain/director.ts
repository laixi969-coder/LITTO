import { type Scope } from "../db.ts";
import { bad, notFound } from "../util.ts";
import { checkSequence } from "./continuity.ts";
import { createShotsFromDrafts } from "./shots.ts";
import { storyboardDirector, visualDirector, assetDirector, type ShotDraft } from "./skills.ts";
import { generateKeyframes } from "./lifecycle.ts";
import { mustRoute, resolvePolicy } from "../providers/router.ts";
import { parseJson, runText } from "../llm.ts";
import { cameraSchema, lightingSchema, NARRATIVE_FUNCTIONS } from "./schema.ts";
import { z } from "zod";

type Step = { step: string; status: "done" | "skipped" | "needs_confirmation"; detail: any };

/**
 * Director Agent. Pipeline: understand goal → World/approved assets → Sequence/Shots → Skills → Reference plan →
 * Freedom map → Router → Generate → QC → Continuity → Repair.
 * Anything that touches LOCKed content, approved assets or core shot intent needs `confirm: true`.
 */
const refined = z.object({ shots: z.array(z.object({ title: z.string(), narrativeFunction: z.enum(NARRATIVE_FUNCTIONS), action: z.string(), performance: z.object({ emotion: z.string(), intensity: z.number().min(0).max(1), eyeline: z.string(), gesture: z.string(), timing: z.string() }), camera: cameraSchema, lighting: lightingSchema, duration: z.number().min(1).max(30), subtitle: z.string().optional() }).passthrough()) });

/**
 * LLM refinement on top of the deterministic storyboard: the model may rewrite function / action / performance / camera / lighting / timing,
 * but never the shot count, order, scene assignment or asset ids (those carry continuity). Anything invalid → keep the rule-based draft.
 */
async function refineWithLlm(s: Scope, projectId: string, actor: string, script: string, drafts: ShotDraft[], world: any) {
    const system = "You are a film storyboard director and cinematographer. Refine the draft shot list. Return ONLY JSON {\"shots\":[...]} with exactly the same number of shots in the same order; keep each shot's fields (title, narrativeFunction, action, performance{emotion,intensity,eyeline,gesture,timing}, camera{shotSize,position,height,angle,lensMm,focus,depth,motion,motivation,side,screenDirection}, lighting{motivatedLight,key,fill,negativeFill,practicals,exposure,keyDirection,timeOfDay,colorTemp}, duration, subtitle). Respect: cut by narrative function, stay on one side of the 180-degree axis within a scene, motivate every camera move, keep lighting consistent within a scene. No filler words like 8K or cinematic.";
    const slim = drafts.map((d) => ({ title: d.title, narrativeFunction: d.narrativeFunction, action: d.action, performance: d.performance, camera: d.camera, lighting: d.lighting, duration: d.duration, subtitle: d.subtitle ?? "" }));
    const r = await runText({ workspaceId: s.workspaceId, projectId, actor, system, prompt: `WORLD: ${JSON.stringify(world ?? {})}\nSCRIPT:\n${script}\nDRAFT:\n${JSON.stringify({ shots: slim })}`, json: true, label: "director.refine", mockEcho: JSON.stringify({ shots: slim }) });
    if (!r) return { used: false, reason: "no usable text model" };
    try {
        const parsed = refined.parse(parseJson(r.text));
        if (parsed.shots.length !== drafts.length) throw new Error(`shot count changed ${drafts.length} → ${parsed.shots.length}`);
        parsed.shots.forEach((x, i) => Object.assign(drafts[i], { title: x.title, narrativeFunction: x.narrativeFunction, action: x.action, performance: x.performance, camera: x.camera, lighting: x.lighting, duration: x.duration, subtitle: x.subtitle ?? drafts[i].subtitle }));
        return { used: true, model: r.modelId, jobId: r.jobId };
    } catch (e) {
        return { used: false, reason: `LLM reply rejected (${(e as Error).message}); kept rule-based draft`, model: r.modelId };
    }
}

export async function directorRun(s: Scope, projectId: string, actor: string, input: { useLlm?: boolean; goal?: string; script: string; sequenceId?: string; mode?: "simple" | "director"; generate?: boolean; confirm?: boolean; replace?: boolean; minShots?: number }) {
    const steps: Step[] = [];
    const project = s.get("projects", projectId);
    if (!project) throw notFound("project");
    if (!input.script?.trim()) throw bad("script required");

    steps.push({ step: "understand_goal", status: "done", detail: { goal: input.goal ?? "Break the script into a shootable sequence", mode: input.mode ?? "simple" } });

    const world = s.list("worlds", { projectId })[0];
    const assets = s.list("assets", { projectId }) as any[];
    const approved = assets.filter((a) => a.approvalStatus === "approved");
    const missing = [!world && "World", !s.list("looks", { projectId }).length && "Look", !approved.some((a) => a.type === "Character") && "approved Character", !approved.some((a) => a.type === "Environment") && "approved Environment"].filter(Boolean);
    steps.push({ step: "world_and_assets", status: missing.length ? "done" : "done", detail: { approvedAssets: approved.map((a) => a.name), warnings: missing.map((m) => `missing ${m}`) } });

    let seq = input.sequenceId ? s.get("sequences", input.sequenceId) : null;
    const existing = seq ? s.list("shots", { sequenceId: seq.id }) : [];
    const touchesApproved = existing.filter((x: any) => x.heroKeyframeId || x.approvedTakeId);
    if (input.replace && touchesApproved.length && !input.confirm) {
        steps.push({ step: "sequence_and_shots", status: "needs_confirmation", detail: { reason: `${touchesApproved.length} shot(s) with Hero Frame / Approved Take would be affected`, shotIds: touchesApproved.map((x: any) => x.id) } });
        return { steps, needsConfirmation: true };
    }
    if (!seq) seq = s.insert("sequences", { project_id: projectId, name: "Sequence 1", ord: 0, script: input.script, data: {} });
    else s.update("sequences", seq.id, { script: input.script });

    const drafts = storyboardDirector(input.script, assets.map((a) => ({ id: a.id, name: a.name, type: a.type })), { minShots: input.minShots ?? 8 });
    const llm = input.useLlm ? await refineWithLlm(s, projectId, actor, input.script, drafts, world) : null;
    const shots = createShotsFromDrafts(s, projectId, seq.id, drafts, { replace: input.replace });
    if (llm) steps.push({ step: "llm_refine", status: llm.used ? "done" : "skipped", detail: llm });
    steps.push({ step: "sequence_and_shots", status: "done", detail: { sequenceId: seq.id, shotCount: shots.length, functions: shots.map((x: any) => x.narrativeFunction) } });

    const vis = visualDirector(`${world?.realism ?? ""} ${input.goal ?? ""}`);
    steps.push({ step: "skills", status: "done", detail: { storyboardDirector: "shots by narrative function", cinematographer: "lens/lighting per function", motionDirector: "biomechanics notes at compile", visualDirector: vis.look, assetDirector: assets.filter((a) => !a.invariants?.length).map((a) => ({ asset: a.name, suggested: assetDirector(a.type, a.name) })) } });

    const bindings = s.list("reference_bindings", { targetType: "shot" });
    steps.push({ step: "reference_plan", status: "done", detail: { perShot: shots.map((x: any) => ({ shotId: x.id, assets: x.assetIds.length, bound: bindings.filter((b: any) => b.targetId === x.id).map((b: any) => b.role) })) } });
    steps.push({ step: "freedom_map", status: "done", detail: { default: { LOCK: "approved asset invariants", CONTROL: "composition, lens, action, camera, lighting", ALLOW: "creases, micro-expression", RANDOM: "dust, background" } } });

    const policy = resolvePolicy(s.workspaceId, projectId);
    const routed = shots.map((x: any) => ({ shotId: x.id, image: mustRoute({ kind: "image", workspaceId: s.workspaceId, projectId, roles: bindings.filter((b: any) => b.targetId === x.id).map((b: any) => b.role), policy }).chosen }));
    steps.push({ step: "router", status: "done", detail: routed.map((r) => ({ shotId: r.shotId, model: r.image?.modelId, degradations: r.image?.degradations })) });

    if (input.generate) {
        const jobs = shots.map((x: any) => generateKeyframes(s, x.id, actor, { count: 2 }).job.id);
        steps.push({ step: "generate", status: "done", detail: { jobIds: jobs } });
    } else steps.push({ step: "generate", status: "skipped", detail: "pass generate:true to enqueue keyframes" });

    steps.push({ step: "qc", status: "skipped", detail: "QC runs per Keyframe/Take once outputs exist" });
    const issues = checkSequence(s, seq.id);
    steps.push({ step: "continuity", status: "done", detail: { issues: issues.map((i) => ({ shotId: i.shotId, severity: i.severity, category: i.category, message: i.message })) } });
    steps.push({ step: "repair", status: "done", detail: issues.map((i) => ({ shotId: i.shotId, ...i.repair })) });
    return { steps, sequenceId: seq.id, shotIds: shots.map((x: any) => x.id), needsConfirmation: false };
}
