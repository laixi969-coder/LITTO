import { type Scope } from "../db.ts";
import { videoCoveragePlanning, videoMotionTiming } from "@toonflow/tool-media-generation/runtime";
import { bad, notFound, sha256 } from "../util.ts";
import { checkSequence } from "./continuity.ts";
import { createShotsFromDrafts, validateVisibleAssets } from "./shots.ts";
import { storyboardDirector, visualDirector, assetDirector, type ShotDraft } from "./skills.ts";
import { generateKeyframes } from "./lifecycle.ts";
import { mustRoute, resolvePolicy } from "../providers/router.ts";
import { parseJson, runText } from "../llm.ts";
import { cameraSchema, lightingSchema, NARRATIVE_FUNCTIONS, creativeBriefSchema, shotInput } from "./schema.ts";
import { z } from "zod";
import { tx } from "../db.ts";
import { validateStateDelta } from "./state.ts";

type Step = { step: string; status: "done" | "skipped" | "needs_confirmation"; detail: any };

/**
 * Director Agent. Pipeline: understand goal → World/approved assets → Sequence/Shots → Skills → Reference plan →
 * Freedom map → Router → Generate → QC → Continuity → Repair.
 * Anything that touches LOCKed content, approved assets or core shot intent needs `confirm: true`.
 */
const refined = z.object({ shots: z.array(z.object({
  sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
  visibleAssetIds: z.array(z.string()),
  title: z.string(), narrativeFunction: z.enum(NARRATIVE_FUNCTIONS), action: z.string().trim().min(1),
  performance: shotInput.shape.performance.removeDefault().extend({ intensity: z.number().min(0).max(1) }),
  blocking: shotInput.shape.blocking.removeDefault(),
  camera: cameraSchema, lighting: lightingSchema, duration: z.number().finite().min(0.5).max(30),
  intendedStateDelta: shotInput.shape.intendedStateDelta.removeDefault(),
  creativeBrief: creativeBriefSchema,
})).min(1).max(180) });

/**
 * 按源节拍映射拆合镜头；场次、事件顺序、资产与逐句对白仍可追踪。失败保留草稿，不自动生成。
 */
async function refineWithLlm(s: Scope, projectId: string, actor: string, script: string, drafts: ShotDraft[], world: any, goal?: string) {
  const system = [
    videoMotionTiming,
    videoCoveragePlanning,
    "You are a film director. Return ONLY JSON {\"shots\":[...]}. Each shot needs sourceIndexes (zero-based draft indexes), visibleAssetIds, title, narrativeFunction, action, performance{emotion,intensity,eyeline,lookTarget,gesture,timing}, blocking{foreground,midground,background}, camera, lighting, duration, intendedStateDelta and creativeBrief. Merge adjacent beats within a scene or split one beat into consecutive shots when motivated. Cover all beats in order without repeating events; repeated sourceIndexes are only for a split beat. Preserve real asset IDs; visibleAssetIds is the subset appearing at some point, excluding voice-only characters.",
    "Preserve SCRIPT facts and GOAL. Design unspecified staging and responses to established intentions without inventing events, props, backstory or dialogue. A shot earns its duration through action, information, relationship change or purposeful stillness. Use the shortest readable duration preserving speech, action and reaction; estimate edit handles separately. Do not fill a draft duration with breathing, blinking, slow pushes or explanatory narration. Select useful behavior from CHARACTERS for the current goal; do not paste biographies, relationships or full habit/knowledge lists into execution fields.",
    "Stage before photography. Anchor each visible performer to existing landmarks; separate body facing, gaze and camera direction, with contact/held props when relevant. camera.design needs technique,purpose,start,end,subjectPath,cameraPath,timing,cut,invariants[],acceptance[],fallback. start describes ONE initial instant, excluding later entrances; end is the visible result. Subject and camera paths are separate. Camera distance, framing, background, depth and focus describe visible results, not just lens numbers. A move needs trigger, path and stopping point; static is valid. Preserve world light source and geography across reverse angles. Acceptance, fallback and neighbouring-shot edit notes are production records, not extra actions.",
    "For each performer name the immediate goal, tactic and observable evidence in action/gesture; put cue and response order in timing, attention target in eyeline/lookTarget. Match behavior scale to framing. Change tactic when resistance or new information motivates it; listening starts only after the relevant cue, possibly during a partner's line. Preserve ending residue into the next shot. Give ensemble members distinct tasks rather than synchronized tics. Silent characters need no voice instructions. Nonhuman performers follow their medium; object/environment shots need no human acting notes.",
    "creativeBrief is {kind:performance|combat|establishing|product,intent,visualPayoff,dialogue:{mode:native|post,lines:[{speakerId,text,start,end,delivery,lipSync:visible|offscreen,framing}]}}. Copy every sourceDialogue exactly once, in order, with the same speakerId and full text, in a shot covering that source. Never rewrite, split or narrate a line. Preserve explicit offscreen coverage; otherwise keep speaking visible. Keep voice identity, adapt delivery to the current tactic. Use native unless a post-production plan is requested; silence uses lines:[]. Local times run from 0 to duration and allow natural speech and reactions. intendedStateDelta records only the changes actually reached at this shot's end, keyed by real asset IDs; do not apply the full source result prematurely in a split shot.",
    "Keep action, performance, paths, start/end and timing consistent without copying the same paragraph into each. Motion defaults to real time; show necessary contact, force, response and support rather than jumping between end states. Combat additionally needs combat{dramaticTurn,signature,coverage,beats:[{attackerId,defenderId,action,reaction,endState,supportingAction}]}. Preserve GOAL intensity through connected pressure, defense, displacement and follow-through, not alternating taps, equal multi-second slots or mutual resets. Supporting fighters affect routes and choices. Plan readable contact/reaction coverage and motivated cuts; preserve requested continuous takes. Do not impose combat speed or extra movement on purposeful stillness. No added cuts, slow motion or preparation merely to fill time.",
  ].join(" ");   if (drafts.some(draft => draft.subtitle && !draft.sourceDialogue)) return { used: false, reason: "存在未匹配说话人的台词或旁白，请先明确声音来源并补充真实角色；不把字幕静默当成已执行对白" };
    const usedAssets = new Set(drafts.flatMap(draft => draft.assetIds));
    const characterDirection = s.list("assets", { projectId }).filter(asset => asset.type === "Character" && usedAssets.has(asset.id)).map(asset => ({ id: asset.id, name: asset.name, characterDirection: asset.attributes?.characterDirection }));
    const slim = drafts.map((draft, index) => ({ ...draft, visibleAssetIds: draft.visibleAssetIds ?? draft.assetIds, sourceIndexes: [index] }));
    const r = await runText({ workspaceId: s.workspaceId, projectId, actor, system, prompt: `GOAL: ${JSON.stringify(goal ?? "Follow the script's intended tone and intensity")}\nCHARACTERS: ${JSON.stringify(characterDirection)}\nWORLD: ${JSON.stringify(world ?? {})}\nSCRIPT:\n${script}\nDRAFT:\n${JSON.stringify({ shots: slim })}`, json: true, label: "director.refine", mockEcho: JSON.stringify({ shots: slim }) });
    if (!r) return { used: false, reason: "no usable text model" };
    try {
        const parsed = refined.parse(parseJson(r.text));
        const coverage = parsed.shots.flatMap(shot => shot.sourceIndexes);
        if (coverage[0] !== 0 || coverage.at(-1) !== drafts.length - 1
          || coverage.some((index, i) => i > 0 && (index < coverage[i - 1] || index > coverage[i - 1] + 1))) throw new Error("源节拍遗漏、越界或顺序改变");
        const sourceCounts = new Map<number, number>();
        for (const index of coverage) sourceCounts.set(index, (sourceCounts.get(index) ?? 0) + 1);
        const expectedDialogue = drafts.flatMap(draft => draft.sourceDialogue ? [draft.sourceDialogue] : []);
        const actualDialogue = parsed.shots.flatMap(shot => shot.creativeBrief.dialogue.lines.map(({ speakerId, text }) => ({ speakerId, text })));
        if (JSON.stringify(actualDialogue) !== JSON.stringify(expectedDialogue)) throw new Error("原文对白遗漏、重复、改词或说话人改变");
        const next = parsed.shots.map(shot => {
          const sources = shot.sourceIndexes.map(index => drafts[index]);
          if (sources.some(source => source.sceneIndex !== sources[0].sceneIndex)) throw new Error("不能跨场合镜");
          if (shot.sourceIndexes.length > 1 && shot.sourceIndexes.some(index => sourceCounts.get(index)! > 1)) throw new Error("重复源节拍只能独立拆镜，不能与合镜交叉");
          for (const line of shot.creativeBrief.dialogue.lines) {
            if (line.end <= line.start || line.end > shot.duration) throw new Error("对白时间超出本镜");
            if (!sources.some(source => source.sourceDialogue?.speakerId === line.speakerId && source.sourceDialogue.text === line.text)) throw new Error("对白被移到无关源节拍");
          }
          validateStateDelta(s, projectId, shot.intendedStateDelta);
          const assetIds = [...new Set(sources.flatMap(source => source.assetIds))];
          validateVisibleAssets({ assetIds, visibleAssetIds: shot.visibleAssetIds, creativeBrief: shot.creativeBrief });
          const { sourceIndexes, ...design } = shot;
          return { ...sources[0], ...design, source: { scriptHash: sha256(script), beatIndexes: sourceIndexes, beats: sources.map(source => source.action), }, assetIds, subtitle: shot.creativeBrief.dialogue.lines.map(line => line.text).join("\n") };
        });
        drafts.splice(0, drafts.length, ...next);
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
    if (input.sequenceId && (!seq || seq.projectId !== projectId)) throw notFound("sequence");
    const existing = seq ? s.list("shots", { sequenceId: seq.id }) : [];
    const touchesApproved = existing.filter((x: any) => x.heroKeyframeId || x.approvedTakeId);
    if (input.replace && touchesApproved.length && !input.confirm) {
        steps.push({ step: "sequence_and_shots", status: "needs_confirmation", detail: { reason: `${touchesApproved.length} shot(s) with Hero Frame / Approved Take would be affected`, shotIds: touchesApproved.map((x: any) => x.id) } });
        return { steps, needsConfirmation: true };
    }
    const drafts = storyboardDirector(input.script, assets.map((a) => ({ id: a.id, name: a.name, type: a.type })));
    if (!drafts.length) throw bad("剧本没有可执行的动作或台词");
    drafts.forEach((draft, index) => { draft.source = { scriptHash: sha256(input.script), beatIndexes: [index], beats: [draft.action] }; });
    const llm = input.useLlm !== false ? await refineWithLlm(s, projectId, actor, input.script, drafts, world, input.goal) : null;
    if (input.generate && !llm?.used) throw bad("导演设计尚未完成，不能直接用规则草稿生成正式镜头", llm?.reason ?? "请开启 useLlm 或先人工补齐镜头设计");
    const shots = tx(() => {
        if (seq && s.get("sequences", seq.id)?.projectId !== projectId) throw notFound("sequence");
        if (!seq) seq = s.insert("sequences", { project_id: projectId, name: "Sequence 1", ord: 0, script: input.script, data: {} });
        else s.update("sequences", seq.id, { script: input.script });
        return createShotsFromDrafts(s, projectId, seq.id, drafts, { replace: input.replace });
    });
    if (!seq) throw notFound("sequence");
    if (llm) steps.push({ step: "llm_refine", status: llm.used ? "done" : "skipped", detail: llm });
    steps.push({ step: "sequence_and_shots", status: "done", detail: { sequenceId: seq.id, shotCount: shots.length, functions: shots.map((x: any) => x.narrativeFunction), warnings: input.minShots && shots.length < input.minShots ? ["原文节拍不足以支撑指定镜数，保留真实覆盖，需导演补充有目的的镜头设计"] : [] } });

    const vis = visualDirector(`${world?.realism ?? ""} ${input.goal ?? ""}`);
    steps.push({ step: "skills", status: "done", detail: { storyboardDirector: llm?.used ? "source-mapped director draft; actual video review still required" : "rule-based draft only; performance, blocking and dialogue execution require completion", cinematographer: "draft lens/lighting suggestions, not verified controls", motionDirector: "action-specific constraints require review", visualDirector: vis.look, assetDirector: assets.filter((a) => !a.invariants?.length).map((a) => ({ asset: a.name, suggested: assetDirector(a.type, a.name) })) } });

    const bindings = s.list("reference_bindings", { targetType: "shot" });
    steps.push({ step: "reference_plan", status: "done", detail: { perShot: shots.map((x: any) => ({ shotId: x.id, assets: x.assetIds.length, bound: bindings.filter((b: any) => b.targetId === x.id).map((b: any) => b.role) })) } });
    steps.push({ step: "freedom_map", status: "done", detail: { default: { LOCK: "approved asset invariants", CONTROL: "composition, lens, action, camera, lighting", ALLOW: "creases, micro-expression", RANDOM: "none unless specified by the story" } } });

    const policy = resolvePolicy(s.workspaceId, projectId);
    const routed = input.generate ? shots.map((x: any) => ({ shotId: x.id, image: mustRoute({ kind: "image", workspaceId: s.workspaceId, projectId, roles: bindings.filter((b: any) => b.targetId === x.id).map((b: any) => b.role), policy }).chosen })) : [];
    steps.push({ step: "router", status: input.generate ? "done" : "skipped", detail: routed.map((r) => ({ shotId: r.shotId, model: r.image?.modelId, degradations: r.image?.degradations })) });

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
