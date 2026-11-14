<template>
  <section class="visualStylePicker" :inert="disabled">
    <div v-if="model.styleReference" class="selectedStyle">
      <img v-if="selectedFrame" :src="selectedFrame.src" :alt="model.styleReference.name" loading="lazy" referrerpolicy="no-referrer" />
      <span>已采用：{{ model.styleReference.name }}</span>
      <el-button @click="clearStyle">移除参考风格</el-button>
    </div>
    <details>
      <summary>从视觉参考库选风格</summary>
      <label>视觉方向<select v-model="directorId" aria-label="视觉方向"><option v-for="item in visualDirectors" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <figure v-if="frame && director">
        <img :key="frame.id" :src="frame.src" :alt="`${frame.film}（${frame.year}）风格参考画面`" loading="lazy" referrerpolicy="no-referrer" @load="imageError = false" @error="imageError = true" />
        <p v-if="imageError" role="status">参考画面暂无法加载，仍可查看并采用下方文字方法。</p>
        <figcaption>{{ frame.film }} · {{ frame.year }} <a :href="frame.source" target="_blank" rel="noopener noreferrer">画面来源</a></figcaption>
        <div class="galleryControls"><el-button :disabled="frameIndex === 0" @click="frameIndex--">上一张参考</el-button><span>{{ frameIndex + 1 }} / {{ gallery.length }}</span><el-button :disabled="frameIndex >= gallery.length - 1" @click="frameIndex++">下一张参考</el-button></div>
        <dl><dt>构图</dt><dd>{{ director.composition }}</dd><dt>光线</dt><dd>{{ director.light }}</dd></dl>
        <el-button :aria-pressed="model.styleReference?.frameId === frame.id" @click="applyStyle">采用此参考风格</el-button>
      </figure>
      <p>采用构图和光线方法，配色沿用工坊单独设置。参考图不自动上传为生成素材。</p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { visualDirectors, visualFrames } from "@toonflow/tool-scene-list/visualReference";
import type { VisualModifiers } from "@toonflow/tools-scaffold/runtime";

const props = defineProps<{ active: boolean; disabled?: boolean }>();
const model = defineModel<VisualModifiers>({ required: true });
const directorId = ref(visualDirectors[0]!.id), frameIndex = ref(0), imageError = ref(false);
const selectedFrame = computed(() => visualFrames.find(item => item.id === model.value.styleReference?.frameId));
const director = computed(() => visualDirectors.find(item => item.id === directorId.value));
const gallery = computed(() => visualFrames.filter(item => item.director === directorId.value));
const frame = computed(() => gallery.value[frameIndex.value]);
watch(directorId, () => { frameIndex.value = 0; imageError.value = false; }, { flush: "sync" });
watch(frame, () => { imageError.value = false; });
watch(() => props.active, active => {
  if (!active || !selectedFrame.value) return;
  directorId.value = selectedFrame.value.director;
  frameIndex.value = gallery.value.findIndex(item => item.id === selectedFrame.value!.id);
}, { immediate: true });

function applyStyle() {
  if (!frame.value || !director.value || props.disabled) return;
  model.value.styleReference = { frameId: frame.value.id, name: director.value.name };
  model.value.style = `构图方法：${director.value.composition}。光线方法：${director.value.light}。保持本作品既定人物、服装、材质、地点和剧情，不复制参考片内容；配色遵循单独指定的色板。`;
}
function clearStyle() { delete model.value.styleReference; model.value.style = ""; }
</script>

<style scoped lang="scss">
.visualStylePicker {
  .selectedStyle { display: flex; align-items: center; gap: 10px; img { width: 90px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 4px; } span { flex: 1; } }
  details {
    summary { cursor: pointer; margin-bottom: 12px; }
    label { display: grid; gap: 6px; select { padding: 8px; background: var(--el-bg-color); color: inherit; border: 1px solid var(--el-border-color); border-radius: 4px; } }
    figure {
      margin: 12px 0;
      > img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--el-fill-color-light); }
      figcaption { margin-top: 6px; font-size: 12px; a { color: var(--el-color-primary); margin-left: 10px; } }
      .galleryControls { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; font-size: 12px; line-height: 1.6; dd { margin: 0; } }
    }
    p { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
  }
}
</style>
