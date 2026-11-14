<template>
  <div class="modelView nodrag nopan nowheel" @pointerdown.stop @wheel.stop>
    <canvas ref="canvas" aria-label="旋转拖拽查看生成的 3D 模型，滚轮缩放" />
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="!ready" @click="capture().catch(showError)">当前机位截图并输出</button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { AmbientLight, Box3, Color, DirectionalLight, LoadingManager, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Material, type Mesh, type Object3D, type Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const props = defineProps<{ content: ArrayBuffer; saveSnapshot: (file: File) => Promise<void> }>();
const canvas = ref<HTMLCanvasElement>();
const ready = ref(false);
const error = ref("");
let renderer: WebGLRenderer | undefined;
let scene: Scene | undefined;
let controls: OrbitControls | undefined;
let frame = 0;
let revision = 0;

function disposeObject(object: Object3D) {
  object.traverse(child => {
    const mesh = child as Mesh;
    mesh.geometry?.dispose();
    const materials: Material[] = !mesh.material ? [] : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) if ((value as Texture | undefined)?.isTexture) (value as Texture).dispose();
      material.dispose();
    }
  });
}

function close() {
  cancelAnimationFrame(frame);
  controls?.dispose();
  controls = undefined;
  if (scene) disposeObject(scene);
  scene = undefined;
  renderer?.dispose();
  renderer = undefined;
  ready.value = false;
}

function validateGlb(content: ArrayBuffer) {
  if (content.byteLength < 20 || content.byteLength > 512 * 1024 * 1024) throw new Error("GLB 文件大小无效");
  const view = new DataView(content);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== content.byteLength) throw new Error("请选择有效的 GLB 2.0 模型");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length > content.byteLength - 20) throw new Error("GLB 缺少有效场景描述");
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(content, 20, length)));
  // ACT: 仅预览自包含 GLB；不请求远端纹理、缓冲或解码器，避免模型文件成为网络请求入口。
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri" && typeof child === "string" && !child.startsWith("data:")) throw new Error("模型含外部资源，请使用自包含 GLB");
      inspect(child);
    }
  };
  inspect(document);
}

watch([canvas, () => props.content], async ([element, content]) => {
  const current = ++revision;
  close();
  error.value = "";
  if (!element) return;
  try {
    validateGlb(content);
    const manager = new LoadingManager();
    manager.setURLModifier(url => {
      if (!/^(data:|blob:)/.test(url)) throw new Error("模型外部资源已阻止");
      return url;
    });
    const model = await new GLTFLoader(manager).parseAsync(content, "");
    if (current !== revision) { disposeObject(model.scene); return; }
    scene = new Scene();
    scene.background = new Color("#242424");
    scene.add(model.scene, new AmbientLight(0xffffff, 2));
    const light = new DirectionalLight(0xffffff, 3);
    light.position.set(3, 4, 5);
    scene.add(light);
    const bounds = new Box3().setFromObject(model.scene);
    if (bounds.isEmpty()) throw new Error("模型未包含可预览的几何体");
    const center = bounds.getCenter(new Vector3());
    const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001);
    const camera = new PerspectiveCamera(40, 440 / 280, radius / 1000, radius * 100);
    camera.position.copy(center).add(new Vector3(radius * 1.4, radius, radius * 2.8));
    renderer = new WebGLRenderer({ canvas: element, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(440, 280, false);
    controls = new OrbitControls(camera, element);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.update();
    const draw = () => {
      if (current !== revision || !renderer || !scene) return;
      controls?.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    };
    draw();
    ready.value = true;
  } catch (failure) {
    if (current === revision) { close(); showError(failure); }
  }
}, { immediate: true });

async function capture() {
  if (!renderer || !ready.value) throw new Error("请先载入 3D 模型");
  const blob = await new Promise<Blob>((resolve, reject) => renderer!.domElement.toBlob(value => value ? resolve(value) : reject(new Error("截图失败")), "image/png"));
  await props.saveSnapshot(new File([blob], "模型机位.png", { type: "image/png" }));
}

function showError(failure: unknown) { error.value = failure instanceof Error ? failure.message : "模型预览失败"; }
onBeforeUnmount(() => { revision++; close(); });
defineExpose({ capture });
</script>

<style scoped lang="scss">
.modelView {
  canvas { display: block; width: 100%; height: 280px; touch-action: none; }
  p { color: var(--el-color-danger); }
  button { margin: 8px; }
}
</style>
