import { tx, type Scope } from "../db.ts";
import { bad, notFound } from "../util.ts";
import { enqueue } from "../jobs.ts";
import { resolvePolicy, mustRoute } from "../providers/router.ts";
import { event } from "./assets.ts";
import { promoteHero } from "./lifecycle.ts";
import { z } from "zod";
import { listModels } from "../providers/registry.ts";
import type { Compiled } from "./compiler.ts";

/**
 * 局部修复（对应 QC 的 inpaint_local / hand_artifact / face_artifact）。
 *
 * ACT: 全部已适配图像供应商都不接受 mask，因此这里不做真正的区域遮罩，
 * 而是用原图加目标区域描述做参考图编辑，不能保证遮罩级区域隔离：
 * 参考图作为图像输入，提示词明确要求除指定区域外逐项保持不变。
 * 代价是整帧会有轻微重绘漂移，因此必须作为新关键帧产出并走人工验收，
 * 不能原地替换原图。
 */

/** 各缺陷类型的局部修复指令：写清楚修什么、保留什么。 */
const regionDirectives: Record<string, { region: string; fix: string; preserve: string }> = {
    face_artifact: {
        region: "face",
        fix: "rebuild correct human facial anatomy: exactly two eyes aligned to the head's perspective, one nose, one mouth, natural jaw and ear placement",
        preserve: "the person's identity, age, skin tone, natural skin texture, makeup, expression direction and eyeline must match the identity reference",
    },
    hand_artifact: {
        region: "affected hand",
        fix: "correct the affected hand's anatomy and finger joints, preserving its pose and natural occlusion; do not force all fingers to be visible",
        preserve: "the hand's skin tone, gesture, pose, interaction with props and lighting direction must stay unchanged",
    },
    anatomy_failure: {
        region: "the affected limbs and joints in frame",
        fix: "correct the limb count and joint structure so the body reads as a single anatomically coherent figure",
        preserve: "the character's identity, clothing, pose intent and position in frame must stay unchanged",
    },
    plastic_surface: {
        region: "the affected skin, fabric or product surface",
        fix: "restore material-specific roughness and highlight response so this surface no longer shares one uniform glossy finish",
        preserve: "identity, colour, texture direction, lighting source direction and the rest of the frame must stay unchanged",
    },
};

export function repairDirective(kind: string) {
    const d = Object.hasOwn(regionDirectives, kind) ? regionDirectives[kind] : undefined;
    if (!d) throw bad(`暂无 ${kind} 的局部修复策略，请改用重新生成`);
    return d;
}

export const localRepairSchema = z.object({
    keyframeId: z.string().min(1), kind: z.enum(["face_artifact", "hand_artifact", "anatomy_failure", "plastic_surface"]),
    target: z.object({ assetId: z.string().min(1).optional(), region: z.string().trim().min(1).max(500) }).strict().optional(),
    note: z.string().trim().max(2000).optional(),
}).strict();

export function prepareLocalRepair(s: Scope, input: z.infer<typeof localRepairSchema>) {
    const parsed = localRepairSchema.parse(input);
    const keyframe = s.get("keyframes", parsed.keyframeId);
    if (!keyframe) throw notFound("keyframe");
    const shot = s.get("shots", keyframe.shotId);
    if (!shot || shot.projectId !== keyframe.projectId) throw notFound("shot");
    const media = keyframe.mediaId && s.get("media", keyframe.mediaId);
    if (!media || media.projectId !== shot.projectId || !media.mime.startsWith("image/")) throw bad("精修需要本项目的原始图像关键帧");
    const visibleIds: string[] = shot.visibleAssetIds ?? shot.assetIds;
    let target = parsed.target;
    if (!target) {
        const characters = visibleIds.map(id => s.get("assets", id)).filter(asset => asset?.type === "Character");
        if (parsed.kind !== "face_artifact" || characters.length !== 1) throw bad("请根据实际图像指定 target.region（如画面左侧人物握杯的右手），有对应资产时传 target.assetId；不要重绘所有同类部位");
        target = { assetId: characters[0]!.id, region: "face" };
    }
    const asset = target.assetId ? s.get("assets", target.assetId) : undefined;
    if (target.assetId && (!asset || asset.projectId !== shot.projectId || !visibleIds.includes(asset.id))) throw bad("精修对象须为本镜出镜资产");
    const directive = repairDirective(parsed.kind);
    const sections = {
        source: "Edit the supplied original frame.",
        change: `${asset ? `${asset.name}: ` : ""}${target.region}. ${directive.fix}.${parsed.note ? ` Specific correction: ${parsed.note}` : ""}`,
        preserve: `${directive.preserve}. Preserve all other people, objects, framing, pose, lens, depth, light and colour. Do not restyle, add or remove elements.`,
    };
    const compiled: Compiled = {
        sections, prompt: Object.entries(sections).map(([key, value]) => `${key.toUpperCase()}: ${value}`).join("\n"), negativePrompt: "",
        inputs: [{ referenceId: `keyframe:${keyframe.id}`, mediaId: media.id, role: "COMPOSITION", weight: 1, lockLevel: "LOCK", sent: true }],
        warnings: ["无蒙版参考图编辑：区域外仍可能漂移；输出为新候选，须与原图比较后采用。"], degradations: [],
        freedomMap: { LOCK: [], CONTROL: [target.region], ALLOW: [], RANDOM: [] },
    };
    return { keyframe, shot, media, target, directive, compiled, kind: parsed.kind };
}

/**
 * 排一个局部修复任务。原关键帧作为参考图送入，提示词锁定其余部分。
 * 返回新任务而非新图：结果须与原图并列比较，由人工决定是否采用。
 */
export function scheduleLocalRepair(s: Scope, input: {
    keyframeId: string; kind: string; actor: string; note?: string; target?: { assetId?: string; region: string };
}, options: { policy?: ReturnType<typeof resolvePolicy> } = {}) {
    const { actor, ...request } = input;
    const { keyframe: kf, shot, media, target, directive, compiled } = prepareLocalRepair(s, localRepairSchema.parse(request));
    const policy = resolvePolicy(s.workspaceId, shot.projectId, options.policy);
    const { chosen } = mustRoute({
        kind: "image", workspaceId: s.workspaceId, projectId: shot.projectId,
        roles: [], need: ["imageEdit"], policy,
        exclude: listModels(true).filter(model => Number(model.capabilities.maxInputs ?? 0) < 1
            || policy.imageModelId && model.id !== policy.imageModelId).map(model => model.id),
    });
    if (!chosen?.usable) throw bad("当前没有可用于局部修复的图像模型");
    return tx(() => {
        const job = enqueue({
            workspaceId: s.workspaceId, projectId: shot.projectId, kind: "image", targetType: "shot", targetId: shot.id,
            modelId: chosen!.modelId, compiledPrompt: compiled.prompt, negativePrompt: compiled.negativePrompt,
            parameters: { width: media.width ?? 1280, height: media.height ?? 1280, count: 1, localRepairOf: kf.id, localRepairKind: input.kind, localRepairTarget: target },
            inputRefs: compiled.inputs,
            createdBy: actor, fallbackAllowed: false, label: `REPAIR ${input.kind} · shot ${shot.ord + 1}`,
        });
        event(s, shot.projectId, "keyframe", kf.id, "schedule_local_repair", input.actor, `${input.kind} → job ${job.id}`, shot.id);
        return { job, directive, target, degradations: chosen!.degradations, note: compiled.warnings[0] };
    });
}

/** 记录采用结果：修复通过则晋升为新的主关键帧，否则保留原图。 */
export function acceptLocalRepair(s: Scope, keyframeId: string, actor: string) {
    const kf = s.get("keyframes", keyframeId);
    if (!kf) throw notFound("keyframe");
    const origin = (kf.meta?.parameters ?? {}).localRepairOf;
    if (!origin) throw bad("该关键帧不是局部修复产物");
    const originKf = s.get("keyframes", origin);
    if (!originKf) throw notFound("原关键帧");
    if (originKf.shotId !== kf.shotId || originKf.projectId !== kf.projectId) throw bad("修复产物与原关键帧不属于同一镜头");
    return tx(() => {
        promoteHero(s, keyframeId, actor);
        event(s, kf.projectId, "keyframe", keyframeId, "accept_local_repair", actor, `replaced ${origin}`, kf.shotId);
        return { heroKeyframeId: keyframeId, replaced: origin };
    });
}
