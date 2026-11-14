<template>
  <el-button text :disabled="disabled || !image" aria-label="轻量机位与3D导演台" @click="open">机位 / 3D</el-button>
  <el-dialog v-model="visible" title="参考图片机位" width="min(650px, 94vw)" top="4vh" appendToBody :closeOnClickModal="false">
    <div class="imageViewTools nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
      <img v-if="previewUrl" :src="previewUrl" alt="原始图片参考" />
      <svg viewBox="0 0 220 130" role="img" aria-label="机位俯视示意"><ellipse cx="110" cy="65" rx="90" ry="50" fill="none" stroke="currentColor" /><circle cx="110" cy="65" r="8" fill="currentColor" /><line :x1="110 + Math.sin(draft.yaw * Math.PI / 180) * 90" :y1="65 + Math.cos(draft.yaw * Math.PI / 180) * 50" x2="110" y2="65" stroke="currentColor" /><circle :cx="110 + Math.sin(draft.yaw * Math.PI / 180) * 90" :cy="65 + Math.cos(draft.yaw * Math.PI / 180) * 50" r="7" fill="var(--el-color-primary)" /></svg>
      <label v-for="field in fields" :key="field.key">{{ field.label }}<input v-model.number="draft[field.key]" type="number" :min="field.min" :max="field.max" :step="field.step" :aria-label="field.label" /></label>
      <p>示意机位用于组织生成指令，不从单张图片重建真实三维。打开导演台可在已有预演场景中取景；数值轨迹仍须单独校准与模型支持。</p>
      <pre>{{ direction }}</pre><p v-if="error" role="alert">{{ error }}</p>
    </div>
    <template #footer><el-button :disabled="busy || !image?.view" @click="apply(undefined)">移除机位</el-button><el-button :disabled="busy" @click="visible = false">取消</el-button><el-button :disabled="busy || !openDirector" @click="director">打开3D导演台</el-button><el-button type="primary" :disabled="busy || !valid" @click="apply(imageViewSchema.parse(draft))">应用到参考图片</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useNode } from "@vue-flow/core";
import { ElButton, ElDialog } from "element-plus";
import { imageViewSchema, imageViewDirection, type ImageView } from "@toonflow/tools-scaffold/runtime";
import type { NodeMediaValue } from "../values";
const props = defineProps<{ image?: NodeMediaValue; previewUrl?: string; disabled?: boolean; sourceHandle: string }>();
const emit = defineEmits<{ apply: [view: ImageView | undefined] }>();
const { node } = useNode();
const openDirector = inject<((source: string, handle: string, view: ImageView) => Promise<void>) | undefined>("openImageDirector", undefined);
const visible = ref(false), busy = ref(false), error = ref("");
const draft = ref<ImageView>({ yaw: 0, pitch: 0, distance: 4, fov: 55 });
const valid = computed(() => imageViewSchema.safeParse(draft.value).success);
const direction = computed(() => valid.value ? imageViewDirection(draft.value) : "请填写范围内的机位参数");
const fields = [{ key: "yaw", label: "水平角（度）", min: -180, max: 180, step: 1 }, { key: "pitch", label: "仰俯角（度）", min: -80, max: 80, step: 1 }, { key: "distance", label: "距离（预演单位）", min: 1, max: 20, step: 0.1 }, { key: "fov", label: "视场角（度）", min: 20, max: 100, step: 1 }] as const;
let sourcePath = "";
function open() { sourcePath = props.image?.url ?? ""; draft.value = imageViewSchema.parse(props.image?.view ?? { yaw: 0, pitch: 0, distance: 4, fov: 55 }); error.value = ""; visible.value = true; }
function assertSource() { if (props.disabled || !sourcePath || props.image?.url !== sourcePath) throw new Error("图片已变化，请重新打开机位编辑"); }
function apply(view: ImageView | undefined) { try { assertSource(); emit("apply", view); visible.value = false; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function director() { if (!openDirector || busy.value) return; busy.value = true; try { assertSource(); await openDirector(node.id, props.sourceHandle, imageViewSchema.parse(draft.value)); visible.value = false; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { busy.value = false; } }
</script>
<style scoped lang="scss">
.imageViewTools { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-height: 65vh; overflow-y: auto; img { width: 100%; max-height: 140px; object-fit: contain; } svg { width: 100%; height: 140px; } label { display: grid; gap: 6px; input { width: 100%; box-sizing: border-box; } } p, pre { grid-column: 1 / -1; white-space: pre-wrap; line-height: 1.6; } }
</style>
