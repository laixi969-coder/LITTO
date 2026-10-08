import { z } from "@toonflow/nodes-scaffold/runtime";
import { Matrix4, PerspectiveCamera } from "three";
import { cameraViewSchema, type CameraView } from "./scene";

export const anchorSchema = cameraViewSchema.extend({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  time: z.number().min(0).max(300).optional(),
}).strip();
export type CameraAnchor = z.infer<typeof anchorSchema>;
export const cameraFramesSchema = z.array(z.strictObject({
  time: z.number().min(0).max(300),
  view: cameraViewSchema,
  easing: z.enum(["linear", "smooth", "cut"]),
})).min(1).max(120).refine(frames => frames.every((frame, index) => !index || frame.time > frames[index - 1]!.time), "镜头时间必须递增");

export function applyCamera(camera: PerspectiveCamera, view: CameraView) {
  const { position, fov, near, far } = view.camera;
  if (Math.hypot(position.x - view.controls.target.x, position.y - view.controls.target.y, position.z - view.controls.target.z) < 0.000001) throw new Error("摄像机位置不能与观察目标重合");
  camera.position.set(position.x, position.y, position.z);
  Object.assign(camera, { fov, near, far });
  camera.lookAt(view.controls.target.x, view.controls.target.y, view.controls.target.z);
  camera.updateProjectionMatrix();
}

export function exportCameraTrajectory(value: z.infer<typeof cameraFramesSchema>, duration: number, translationScale: number) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 5) throw new Error("GEN3C 首期只导出不超过 5 秒的单镜头，较长方案请先拆镜");
  if (!Number.isFinite(translationScale) || translationScale <= 0 || translationScale > 100) throw new Error("尺度须在 0～100 内，且不能为 0");
  const frames = prepareMotion(value);
  if (frames[0]!.time !== 0 || frames.some(frame => frame.time > duration) || frames.slice(1).some(frame => frame.easing === "cut")) throw new Error("轨迹须从 0 开始，覆盖当前方案且不含硬切");
  const camera = new PerspectiveCamera();
  const basis = new Matrix4().makeScale(1, -1, -1);
  sampleMotion(camera, frames, 0);
  camera.updateMatrixWorld(true);
  const initialInverse = camera.matrixWorld.clone().multiply(basis).invert();
  return {
    version: 1 as const, coordinateSystem: "opencvRelative" as const, fps: 24 as const, translationScale,
    frames: Array.from({ length: 121 }, (_, i) => {
      sampleMotion(camera, frames, Math.min(i / 24, duration));
      camera.updateMatrixWorld(true);
      const matrix = initialInverse.clone().multiply(camera.matrixWorld).multiply(basis).elements;
      return { pose: [0, 1, 2].flatMap(row => [0, 1, 2, 3].map(column => matrix[column * 4 + row]!)), fov: camera.fov };
    }),
  };
}

export function prepareMotion(value: z.infer<typeof cameraFramesSchema>) {
  return cameraFramesSchema.parse(value).map(frame => {
    const camera = new PerspectiveCamera();
    applyCamera(camera, frame.view);
    return { ...frame, camera };
  });
}

export function sampleMotion(camera: PerspectiveCamera, frames: ReturnType<typeof prepareMotion>, time: number) {
  if (!Number.isFinite(time)) throw new Error("运镜时间无效");
  const last = frames.at(-1)!;
  const end = frames.findIndex(frame => frame.time >= time);
  const next = frames[end < 0 ? frames.length - 1 : end]!;
  const previous = frames[Math.max(0, (end < 0 ? frames.length - 1 : end) - 1)]!;
  let progress = next === previous ? 1 : Math.min(1, Math.max(0, (time - previous.time) / (next.time - previous.time)));
  if (next.easing === "cut") progress = time >= next.time ? 1 : 0;
  if (next.easing === "smooth") progress = progress * progress * (3 - 2 * progress);
  camera.position.lerpVectors(previous.camera.position, next.camera.position, progress);
  camera.quaternion.slerpQuaternions(previous.camera.quaternion, next.camera.quaternion, progress);
  for (const field of ["fov", "near", "far"] as const) camera[field] = previous.camera[field] + (next.camera[field] - previous.camera[field]) * progress;
  camera.updateProjectionMatrix();
  return time >= last.time;
}
