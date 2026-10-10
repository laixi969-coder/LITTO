import { get, tx, type Scope } from "../db.ts";
import { bad, notFound } from "../util.ts";
import { enqueue } from "../jobs.ts";
import { resolvePolicy, mustRoute } from "../providers/router.ts";
import { event } from "./assets.ts";

/**
 * 局部修复（对应 QC 的 inpaint_local / hand_artifact / face_artifact）。
 *
 * ACT: 全部已适配图像供应商都不接受 mask，因此这里不做真正的区域遮罩，
 * 而是用「整帧重绘 + 锁定描述 + 局部区域指示」达到同样目的：
 * 参考图作为图像输入，提示词明确要求除指定区域外逐项保持不变。
 * 代价是整帧会有轻微重绘漂移，因此必须作为新关键帧产出并走人工验收，
 * 不能原地替换原图。
 */

/** 各缺陷类型的局部修复指令：写清楚修什么、保留什么。 */
const REGION_DIRECTIVES: Record<string, { region: string; fix: string; preserve: string }> = {
    face_artifact: {
        region: "the face region of every person in frame",
        fix: "rebuild correct human facial anatomy: exactly two eyes aligned to the head's perspective, one nose, one mouth, natural jaw and ear placement",
        preserve: "the person's identity, age, skin tone, natural skin texture, makeup, expression direction and eyeline must match the identity reference",
    },
    hand_artifact: {
        region: "every visible hand in frame",
        fix: "rebuild correct hand anatomy: exactly five fingers per hand with correct joints, correct thumb placement, natural finger spread matching the hand's pose",
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
    const d = REGION_DIRECTIVES[kind];
    if (!d) throw bad(`暂无 ${kind} 的局部修复策略，请改用重新生成`);
    return d;
}

/**
 * 排一个局部修复任务。原关键帧作为参考图送入，提示词锁定其余部分。
 * 返回新任务而非新图：结果须与原图并列比较，由人工决定是否采用。
 */
export function scheduleLocalRepair(s: Scope, input: {
    keyframeId: string; kind: string; actor: string; note?: string;
}, options: { policy?: ReturnType<typeof resolvePolicy> } = {}) {
    const kf = s.get("keyframes", input.keyframeId);
    if (!kf) throw notFound("keyframe");
    const shot = s.get("shots", kf.shotId);
    if (!shot) throw notFound("shot");
    if (!kf.mediaId) throw bad("该关键帧没有可用媒体");
    const media = s.get("media", kf.mediaId);
    if (!media || !media.mime.startsWith("image/")) throw bad("局部修复仅支持图像关键帧");
    const directive = repairDirective(input.kind);
    const policy = resolvePolicy(s.workspaceId, shot.projectId, options.policy);
    const { chosen } = mustRoute({
        kind: "image", workspaceId: s.workspaceId, projectId: shot.projectId,
        // 参考图作为身份与整体保持依据，因此按多参考能力选模型。
        roles: ["IDENTITY"], policy,
    });
    if (!chosen?.usable) throw bad("当前没有可用于局部修复的图像模型");
    const prompt = [
        `Retouch only ${directive.region}; ${directive.fix}.`,
        `${directive.preserve}.`,
        "Treat the supplied image as the exact reference for this frame: keep the framing, lens, depth of field, lighting direction, colour response and every element outside the corrected region unchanged.",
        "Do not restyle the image, change the aspect, add or remove people or objects, or alter the established colour grade.",
        input.note?.trim() ? `Additional instruction: ${input.note.trim()}` : "",
    ].filter(Boolean).join(" ");
    const negative = "additional fingers, fused limbs, changed identity, restyled frame, altered lighting direction, changed framing, added or removed objects, watermark, garbled text";
    return tx(() => {
        const job = enqueue({
            workspaceId: s.workspaceId, projectId: shot.projectId, kind: "image", targetType: "shot", targetId: shot.id,
            modelId: chosen!.modelId, compiledPrompt: prompt, negativePrompt: negative,
            parameters: { width: media.width ?? 1280, height: media.height ?? 1280, count: 1, localRepairOf: kf.id, localRepairKind: input.kind },
            // 原帧作为唯一参考图回灌，保证整体不被重画。
            inputRefs: [{ referenceId: `keyframe:${kf.id}`, mediaId: kf.mediaId, role: "IDENTITY", weight: 1, sent: true }],
            createdBy: input.actor, fallbackAllowed: false, label: `REPAIR ${input.kind} · shot ${shot.ord + 1}`,
        });
        event(s, shot.projectId, "keyframe", kf.id, "schedule_local_repair", input.actor, `${input.kind} → job ${job.id}`, shot.id);
        return { job, directive, degradations: chosen!.degradations, note: "无蒙版能力：采用整帧重绘 + 其余元素锁定，输出为新关键帧，须与原图并列验收。" };
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
    const shot = s.get("shots", kf.shotId)!;
    return tx(() => {
        for (const k of s.list("keyframes", { shotId: shot.id, status: "hero" })) s.update("keyframes", k.id, { status: "superseded" });
        s.update("keyframes", keyframeId, { status: "hero" });
        s.update("shots", shot.id, { hero_keyframe_id: keyframeId });
        event(s, shot.projectId, "keyframe", keyframeId, "accept_local_repair", actor, `replaced ${origin}`, shot.id);
        return { heroKeyframeId: keyframeId, replaced: origin };
    });
}
void get;
