import { skinFinishes } from "@toonflow/tool-media-generation/runtime";
import type { Scope } from "../db.ts";
import { bad } from "../util.ts";
import { lookSchema } from "./schema.ts";

export function effectiveLook(s: Scope, projectId: string, sequenceId?: string, shotId?: string) {
  const looks = s.list("looks", { projectId });
  const result: Record<string, unknown> = {};
  for (const layer of [looks.find(item => item.scope === "project"),
    sequenceId ? looks.find(item => item.scope === "sequence" && item.scopeId === sequenceId) : undefined,
    shotId ? looks.find(item => item.scope === "shot" && item.scopeId === shotId) : undefined]) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(lookSchema.parse(layer))) {
      if (typeof value === "string" ? value.trim() : value.length) result[key] = value;
    }
  }
  return lookSchema.parse(result);
}

/** 同一份影调参考同时用于编译与对照审图，不能只保存编号。 */
export function lookReferenceBindings(s: Scope, projectId: string, look: { colorReferenceIds?: string[] }) {
  return [...new Set(look.colorReferenceIds ?? [])].map(referenceId => {
    const reference = s.get("refs", referenceId);
    const media = reference?.mediaId && s.get("media", reference.mediaId);
    if (reference?.projectId !== projectId || reference.kind !== "image" || !media?.mime.startsWith("image/")) throw bad("影调参考须是当前项目的有效图片参考记录，请先登记 reference 再保存 colorReferenceIds");
    return { referenceId, role: "LOOK", weight: 1, lockLevel: "LOCK", notes: `${reference.name || "视觉目标"}：只参考材质、光照响应、肤色与成像层次；不复制字幕、界面、黑边或压缩瑕疵；人物身份、场地、维护状态、时段和实际光源服从本镜设定` };
  });
}

// ACT: 正式镜头、独立生成与审看复用同一份清爽肤质规则；既定媒介、妆容与剧情状态优先。
export const cleanVisualDefaults = "Keep the chosen medium, era and maintenance state; the user's latest explicit restrictions take precedence over earlier drafts. For photographic scenes, aim for a clean, high-fidelity live-action photograph: natural color, clear subject exposure, believable depth, fine detail at the chosen scale, and distinct material reflections under coherent light. Keep surfaces and wardrobe clean and maintained unless the user or confirmed story specifies otherwise; avoid muddy color, haze, grime, artificial texture and oversharpening. Do not add visible noise, film grain, chroma noise or compression artifacts unless explicitly chosen and consistent with the user's restrictions. Preserve natural material texture instead of smoothing it away. Preserve intentional lighting, shadows, age, makeup and story state. For photographic human subjects only, fill unspecified skin and grooming details with this baseline: " + skinFinishes.clean;

export const characterReferenceUse = "Use references only for their assigned roles: IDENTITY for face, age and skin; WARDROBE for clothes; LOOK/LIGHTING/COMPOSITION for the specified visual relations. A face crop does not set body proportions. Preserve approved physique; new unspecified adult bodies default to naturally tall, proportionate silhouettes, never stretched or shortened to fit. Current action sets expression. Do not copy unrelated people, outfits or damage from references; text alone cannot lock identity. Preserve the approved face, ancestry-related visible features, age, hair and skin tone; never recast from a storyboard thumbnail. GEOMETRY references lock the same weapon: blade shape, guard, hilt, material and size relative to the wielder; action changes its pose, not its design. Identity portraits and costume sheets do not define the scene, lighting or end frame.";
