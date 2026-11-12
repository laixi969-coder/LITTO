<template>
  <section class="imageRegion" :aria-label="label">
    <p>{{ label }}：拖动框选，或输入 0–1 坐标；原图保留。</p>
    <div ref="stage" class="regionStage" :style="{ width: `${Math.min(600, 320 * aspect)}px`, aspectRatio: String(aspect) }"
      @pointerdown="start" @pointermove="move" @pointerup="finish" @pointercancel="cancel" @lostpointercapture="cancel">
      <img :src="src" :alt="label + '原图'" draggable="false" @load="loaded" @error="ready = false" />
      <div v-if="valid" class="regionBox" :style="boxStyle" />
    </div>
    <fieldset :disabled="disabled || !ready" class="regionFields">
      <label v-for="field in fields" :key="field.key">{{ label }} · {{ field.label }}<input :value="normalized[field.key]" type="number" min="0" max="1" step="0.01" @input="update(field.key, $event)" /></label>
      <button type="button" @click="model = { x: 0, y: 0, width: 1, height: 1, unit: 'normalized' }">使用整图</button>
    </fieldset>
    <p v-if="!valid" role="alert">区域必须在图内，宽高须大于零。</p>
    <div v-if="valid && ready" class="cropPreview" :style="{ aspectRatio: String(aspect * shown.width / shown.height), width: `${Math.min(280, 180 * aspect * shown.width / shown.height)}px` }">
      <img :src="src" :alt="label + '区域预览'" :style="{ width: `${100 / shown.width}%`, height: `${100 / shown.height}%`, left: `${-100 * shown.x / shown.width}%`, top: `${-100 * shown.y / shown.height}%` }" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
type Region = { x: number; y: number; width: number; height: number; unit: string };
const props = defineProps<{ src: string; label: string; disabled?: boolean }>();
const model = defineModel<Region>({ required: true });
const stage = ref<HTMLElement>(), ready = ref(false), imageSize = ref({ width: 1, height: 1 });
const drag = ref<{ id: number; x: number; y: number; currentX: number; currentY: number }>();
const fields = [{ key: "x", label: "左侧" }, { key: "y", label: "顶部" }, { key: "width", label: "宽度" }, { key: "height", label: "高度" }] as const;
const aspect = computed(() => imageSize.value.width / imageSize.value.height);
const normalized = computed(() => model.value.unit === "pixels" ? { x: model.value.x / imageSize.value.width, y: model.value.y / imageSize.value.height, width: model.value.width / imageSize.value.width, height: model.value.height / imageSize.value.height, unit: "normalized" } : model.value);
const shown = computed(() => drag.value ? { x: Math.min(drag.value.x, drag.value.currentX), y: Math.min(drag.value.y, drag.value.currentY), width: Math.abs(drag.value.currentX - drag.value.x), height: Math.abs(drag.value.currentY - drag.value.y), unit: "normalized" } : normalized.value);
const valid = computed(() => [shown.value.x, shown.value.y, shown.value.width, shown.value.height].every(Number.isFinite) && shown.value.x >= 0 && shown.value.y >= 0 && shown.value.width > 0 && shown.value.height > 0 && shown.value.x + shown.value.width <= 1 && shown.value.y + shown.value.height <= 1);
const boxStyle = computed(() => ({ left: `${shown.value.x * 100}%`, top: `${shown.value.y * 100}%`, width: `${shown.value.width * 100}%`, height: `${shown.value.height * 100}%` }));
function loaded(event: Event) { const image = event.target as HTMLImageElement; imageSize.value = { width: image.naturalWidth, height: image.naturalHeight }; ready.value = !!image.naturalWidth && !!image.naturalHeight; }
function location(event: PointerEvent) { const rect = stage.value!.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; }
function start(event: PointerEvent) {
  if (props.disabled || !ready.value || event.button !== 0) return;
  event.preventDefault(); const point = location(event);
  drag.value = { id: event.pointerId, ...point, currentX: point.x, currentY: point.y }; stage.value!.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) { if (!drag.value || drag.value.id !== event.pointerId) return; const point = location(event); drag.value.currentX = point.x; drag.value.currentY = point.y; }
function finish(event: PointerEvent) {
  if (!drag.value || drag.value.id !== event.pointerId) return;
  move(event);
  if (valid.value && shown.value.width * imageSize.value.width >= 1 && shown.value.height * imageSize.value.height >= 1) model.value = { ...shown.value };
  cancel();
}
function cancel() { if (drag.value && stage.value?.hasPointerCapture(drag.value.id)) stage.value.releasePointerCapture(drag.value.id); drag.value = undefined; }
function update(key: "x" | "y" | "width" | "height", event: Event) { model.value = { ...normalized.value, [key]: (event.target as HTMLInputElement).valueAsNumber, unit: "normalized" }; }
watch(() => props.src, () => { cancel(); ready.value = false; });
watch(() => props.disabled, disabled => { if (disabled) cancel(); });
</script>

<style scoped lang="scss">
.imageRegion {
  .regionStage { position: relative; max-width: 100%; touch-action: none; cursor: crosshair;
    img { display: block; width: 100%; height: 100%; user-select: none; }
    .regionBox { position: absolute; box-sizing: border-box; border: 2px solid var(--studioDone); background: color-mix(in srgb, var(--studioDone) 15%, transparent); pointer-events: none; }
  }
  .regionFields { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px 0; border: 0;
    label { display: grid; gap: 6px; }
    input { width: 96px; }
    input, button { font: inherit; color: var(--studioInk); background: var(--studioSurface); padding: 8px; min-height: 44px; box-sizing: border-box; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); }
    :focus-visible { outline: 2px solid var(--studioDone); outline-offset: 2px; }
  }
  [role="alert"] { color: var(--el-color-danger); }
  .cropPreview { position: relative; max-width: 100%; overflow: hidden; img { position: absolute; max-width: none; } }
}
</style>
