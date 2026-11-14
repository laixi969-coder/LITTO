import { z } from "zod";

export const imageViewSchema = z.strictObject({
  yaw: z.number().finite().min(-180).max(180), pitch: z.number().finite().min(-80).max(80),
  distance: z.number().finite().min(1).max(20), fov: z.number().finite().min(20).max(100),
});
export type ImageView = z.infer<typeof imageViewSchema>;
export const referenceViewsSchema = z.array(z.strictObject({ role: z.enum(["image", "firstFrame", "lastFrame"]), index: z.number().int().min(0).max(63), view: imageViewSchema })).max(64);
export type ReferenceViews = z.infer<typeof referenceViewsSchema>;
export function compileImageViews(prompt: string, values?: ReferenceViews) {
  if (!values?.length) return prompt;
  return [prompt, ...referenceViewsSchema.parse(values).map(item => `${item.role === "image" ? "图片参考 " + (item.index + 1) : item.role === "firstFrame" ? "首帧图片" : "尾帧图片"}：${imageViewDirection(item.view)}`)].filter(Boolean).join("\n\n");
}
export function imageViewDirection(value: ImageView) {
  const view = imageViewSchema.parse(value);
  return `机位相对主体：水平角 ${view.yaw}°，仰俯角 ${view.pitch}°（正值为俯视），距离 ${view.distance} 个预演单位，视场角 ${view.fov}°。只调整观看位置，保留主体身份、衣着、材质、光源与环境关系；未知背面细节不作事实。`;
}
export function imageViewCamera(value: ImageView) {
  const view = imageViewSchema.parse(value), yaw = view.yaw * Math.PI / 180, pitch = view.pitch * Math.PI / 180;
  return { camera: { position: { x: view.distance * Math.cos(pitch) * Math.sin(yaw), y: 1 + view.distance * Math.sin(pitch), z: view.distance * Math.cos(pitch) * Math.cos(yaw) }, fov: view.fov, near: 0.1, far: 1000 }, controls: { target: { x: 0, y: 1, z: 0 } } };
}
export function imageViewFromCamera(value: { camera: { position: { x: number; y: number; z: number }; fov: number } }) {
  const { x, y, z } = value.camera.position, distance = Math.hypot(x, y - 1, z);
  const rounded = (number: number) => Math.round(number * 1000000) / 1000000;
  return imageViewSchema.parse({ yaw: rounded(Math.atan2(x, z) * 180 / Math.PI), pitch: rounded(Math.asin((y - 1) / distance) * 180 / Math.PI), distance: rounded(distance), fov: value.camera.fov });
}
