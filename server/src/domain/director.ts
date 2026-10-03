import { type Scope } from "../db.ts";
import { bad, notFound } from "../util.ts";
import { checkSequence } from "./continuity.ts";
import { createShotsFromDrafts } from "./shots.ts";
import { storyboardDirector, visualDirector, assetDirector } from "./skills.ts";
import { generateKeyframes } from "./lifecycle.ts";
import { mustRoute, resolvePolicy } from "../providers/router.ts";

type Step = { step: string; status: "done" | "skipped" | "needs_confirmation"; detail: any };

/**
 * Director Agent. Pipeline: understand goal → World/approved assets → Sequence/Shots → Skills → Reference plan →
 * Freedom map → Router → Generate → QC → Continuity → Repair.
 * Anything that touches LOCKed content, approved assets or core shot intent needs `confirm: true`.
 */
export function directorRun(s: Scope, projectId: string, actor: string, input: { goal?: string; script: string; sequenceId?: string; mode?: "simple" | "director"; generate?: boolean; confirm?: boolean; replace?: boolean; minShots?: number }) {
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
    const shots = createShotsFromDrafts(s, projectId, seq.id, drafts, { replace: input.replace });
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
