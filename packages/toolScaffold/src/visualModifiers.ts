import { z } from "zod";

const instruction = z.string().trim().max(2000);
const hexColor = z.string().regex(/^#[\da-f]{6}$/i);
export const paletteHarmonySchema = z.strictObject({ mode: z.enum(["analogous", "complementary", "triadic"]), base: hexColor });
export type PaletteHarmony = z.infer<typeof paletteHarmonySchema>;

export function paletteHarmonyColors(value: PaletteHarmony) {
  const { base, mode } = paletteHarmonySchema.parse(value);
  const [red, green, blue] = [1, 3, 5].map(index => parseInt(base.slice(index, index + 2), 16) / 255) as [number, number, number];
  const high = Math.max(red, green, blue), low = Math.min(red, green, blue), delta = high - low, lightness = (high + low) / 2;
  const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
  const hue = !delta ? 0 : 60 * (high === red ? (green - blue) / delta : high === green ? (blue - red) / delta + 2 : (red - green) / delta + 4);
  const offsets = mode === "analogous" ? [0, -30, 30] : mode === "complementary" ? [0, 180] : [0, 120, 240];
  return offsets.map(offset => {
    if (!offset) return base.toUpperCase();
    const angle = ((hue + offset) % 360 + 360) % 360 / 60;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, middle = chroma * (1 - Math.abs(angle % 2 - 1)), match = lightness - chroma / 2;
    const channels = angle < 1 ? [chroma, middle, 0] : angle < 2 ? [middle, chroma, 0] : angle < 3 ? [0, chroma, middle] : angle < 4 ? [0, middle, chroma] : angle < 5 ? [middle, 0, chroma] : [chroma, 0, middle];
    return `#${channels.map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  });
}

export const visualModifiersSchema = z.strictObject({
  camera: z.strictObject({ camera: instruction, lens: instruction, focal: instruction, aperture: instruction }),
  motions: z.array(z.strictObject({ id: z.string().min(1).max(120), label: instruction, instruction })).max(5),
  palette: z.strictObject({ name: z.string().trim().min(1).max(100), colors: z.array(hexColor).min(1).max(16), harmony: paletteHarmonySchema.optional() }).optional(),
  styleReference: z.strictObject({ frameId: z.string().min(1).max(120), name: z.string().trim().min(1).max(100) }).optional(),
  references: z.array(z.strictObject({ frameId: z.string().min(1).max(120), purpose: z.enum(["composition", "lighting", "palette"]), note: instruction, direction: instruction })).max(24).optional(),
  color: instruction,
  style: instruction,
}).refine(value => new Set(value.motions.map(item => item.id)).size === value.motions.length, "运镜不能重复选择");
export type VisualModifiers = z.infer<typeof visualModifiersSchema>;

// ACT: 逐镜值优先；全局设置只作为该字段未指定的镜头的默认值，不覆盖已编排的镜头。
export function compileVisualModifiers(prompt: string, value?: VisualModifiers, timeline: { lensMm?: number; aperture?: number; cameraMove?: string }[] = []) {
  if (!value) return prompt;
  const plan = visualModifiersSchema.parse(value);
  const fields = [plan.camera.camera, plan.camera.lens,
    plan.camera.focal && `${timeline.some(item => item.lensMm) ? "仅未指定焦距的分镜采用：" : ""}${plan.camera.focal}`,
    plan.camera.aperture && `${timeline.some(item => item.aperture) ? "仅未指定光圈的分镜采用：" : ""}${plan.camera.aperture}`,
    plan.motions.length && `${timeline.some(item => item.cameraMove?.trim()) ? "仅未指定运镜的分镜采用下列顺序：" : "全局运镜按顺序执行："}${plan.motions.map((item, index) => `${index + 1}. ${item.label}：${item.instruction}`).join("；")}。保持既定动作与时间线，不增加切镜。`,
    plan.color && `配色：${plan.color}`, ...(plan.references ?? []).map(item => `视觉参考 ${item.frameId} · ${item.purpose}：${item.direction}；采用用途：${item.note}。仅借鉴所选方法，不复制参考片人物、地点或剧情。`), plan.style && `风格：${plan.style}`].filter(Boolean).join("\n");
  return [prompt, fields && `生成修饰（逐镜设置优先；保持人物、资产本色、对白和剧情约束）：\n${fields}`].filter(Boolean).join("\n\n");
}
