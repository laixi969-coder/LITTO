import { z } from "zod";

const instruction = z.string().trim().max(2000);
export const visualModifiersSchema = z.strictObject({
  camera: z.strictObject({ camera: instruction, lens: instruction, focal: instruction, aperture: instruction }),
  motions: z.array(z.strictObject({ id: z.string().min(1).max(120), label: instruction, instruction })).max(5),
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
    plan.color && `配色：${plan.color}`, plan.style && `风格：${plan.style}`].filter(Boolean).join("\n");
  return [prompt, fields && `生成修饰（逐镜设置优先；保持人物、资产本色、对白和剧情约束）：\n${fields}`].filter(Boolean).join("\n\n");
}
