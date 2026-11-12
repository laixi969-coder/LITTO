import { z } from "zod";

const direction = z.string().max(2000);
export const videoStoryboardSchema = z.strictObject({
  version: z.literal(1),
  soundEffects: z.enum(["auto", "on", "off"]),
  music: z.enum(["auto", "on", "off"]),
  shots: z.array(z.strictObject({
    id: z.string().min(1).max(120),
    editId: z.string().min(1).max(120).optional(),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    transition: z.enum(["continuous", "cut"]),
    description: direction,
    foreground: direction,
    background: direction,
    lensMm: z.number().finite().positive().max(2000).optional(),
    aperture: z.number().finite().min(0.5).max(64).optional(),
    cameraMove: direction,
  })).min(1).max(8),
}).superRefine((plan, ctx) => {
  const ids = new Set<string>();
  plan.shots.forEach((shot, index) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["shots", index], message: `分镜 ${index + 1}：${message}` });
    if (ids.has(shot.id)) issue("镜号重复");
    ids.add(shot.id);
    if (!shot.description.trim()) issue("请填写画面与动作");
    if (shot.end <= shot.start) issue("结束时间须晚于开始时间");
    if (Math.abs(shot.start - (index ? plan.shots[index - 1]!.end : 0)) > 0.000001) issue("时间须从 0 连续排列，不能重叠或留空");
    if (!index && shot.transition === "cut") issue("第一镜不能从切镜开始");
    if ([shot.description, shot.foreground, shot.background, shot.cameraMove].join("\n").length > 3400) issue("描述过长，请精简至 3400 字以内");
  });
});
export type VideoStoryboard = z.infer<typeof videoStoryboardSchema>;
export type VideoStoryboardShot = VideoStoryboard["shots"][number];

export function storyboardDescription(shot: { description: string; foreground?: string; background?: string; lensMm?: number; aperture?: number; cameraMove?: string }) {
  return [shot.description.trim(), shot.foreground?.trim() && `前景：${shot.foreground.trim()}`,
    shot.background?.trim() && `远景：${shot.background.trim()}`, shot.lensMm && `焦距：${shot.lensMm}mm`,
    shot.aperture && `光圈：f/${shot.aperture}`, shot.cameraMove?.trim() && `运镜：${shot.cameraMove.trim()}`].filter(Boolean).join("\n");
}

export function storyboardAudio(plan: VideoStoryboard) {
  return ([ ["音效", plan.soundEffects], ["背景音乐", plan.music] ] as const)
    .filter(([, value]) => value !== "auto")
    .map(([name, value]) => `${name}：${value === "on" ? "生成与画面匹配的" + name : "不要" + name}`).join("；");
}

// ACT: 沿用项目的 start/end/description/transition 时间线；摄影字段编译进每镜描述，不另建执行时间线。
export function storyboardTimeline(plan: VideoStoryboard) {
  return plan.shots.map(shot => ({
    editId: shot.editId ?? shot.id, start: shot.start, end: shot.end, transition: shot.transition,
    description: [shot.description.trim(), storyboardAudio(plan)].filter(Boolean).join("\n"),
    foreground: shot.foreground, background: shot.background, lensMm: shot.lensMm, aperture: shot.aperture, cameraMove: shot.cameraMove,
  }));
}

export function validateVideoStoryboard(value: unknown, duration?: number) {
  const parsed = videoStoryboardSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues.map(item => item.message).join("；"));
  if (!duration || Math.abs(parsed.data.shots.at(-1)!.end - duration) > 0.000001) throw new Error(`分镜时间须完整覆盖生成时长${duration ? ` ${duration} 秒` : "，请先选择模型与时长"}`);
  return parsed.data;
}

export function compileVideoStoryboard(prompt: string, plan?: VideoStoryboard) {
  if (!plan) return prompt;
  const timeline = storyboardTimeline(plan).map((shot, index) => `【分镜 ${index + 1} · ${shot.start}–${shot.end} 秒 · ${shot.transition === "cut" ? "切镜" : "连续动作"}】\n${storyboardDescription(shot)}`).join("\n\n");
  return [prompt.trim(), "按以下时间线执行画面、动作与摄影变化。仅在标记切镜处切换镜头，其余段落保持动作、人物、道具和空间连续。", timeline].filter(Boolean).join("\n\n");
}

export function storyboardGenerateAudio(plan: VideoStoryboard, modelAudio: boolean | "optional" | undefined, current?: boolean) {
  if (plan.soundEffects === "on" || plan.music === "on") {
    if (!modelAudio) throw new Error("当前模型不支持生成声音，请将音效与音乐设为沿用或关闭");
    return true;
  }
  return current;
}
