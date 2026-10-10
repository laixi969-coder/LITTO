<template>
  <div class="mediaPreferences">
    <label v-for="field in fields" :key="field.key">
      <span>{{ field.label }}</span>
      <el-select v-model="value[field.key]" :disabled="disabled || !field.options.length" :aria-label="field.label" placeholder="模型默认" clearable>
        <el-option v-for="option in field.options" :key="option" :label="option" :value="option" />
      </el-select>
    </label>
    <span v-if="loadError" role="status">{{ loadError }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import axios from "axios";
import type { MediaModel } from "@toonflow/tool-media-generation/runtime";

const value = defineModel<{ imageRatio: string; imageSize: string; videoRatio: string; videoResolution: string }>({ required: true });
defineProps<{ disabled?: boolean }>();
const models = ref<MediaModel[]>([]);
const loadError = ref("");
function ratioOfSize(size: string) {
  const dimensions = /^(\d+)[x*](\d+)$/.exec(size);
  if (!dimensions) return "";
  const width = Number(dimensions[1]), height = Number(dimensions[2]);
  if (!width || !height) return "";
  let divisor = width, remainder = height;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  return `${width / divisor}:${height / divisor}`;
}
const fields = computed(() => {
  const images = models.value.filter(model => model.type === "image");
  const videos = models.value.filter(model => model.type === "video" && !model.lipSync);
  return [
    { key: "imageRatio" as const, label: "图片比例", options: [...new Set(images.flatMap(model => model.imageRatios?.length ? model.imageRatios : (model.imageSizes ?? []).map(ratioOfSize).filter(Boolean)))] },
    { key: "imageSize" as const, label: "图片精度", options: [...new Set(images.flatMap(model => model.imageSizes ?? []))].filter(size => !value.value.imageRatio || !ratioOfSize(size) || ratioOfSize(size) === value.value.imageRatio) },
    // ACT: 视频模型接口尚未提供画幅列表，沿用视频节点的选项，实际生成前由助手核对模型支持。
    { key: "videoRatio" as const, label: "视频比例", options: videos.length ? ["16:9", "9:16", "1:1", "4:3", "3:4", "20:11"] : [] },
    { key: "videoResolution" as const, label: "视频分辨率", options: [...new Set(videos.flatMap(model => model.durationResolutionMap?.flatMap(item => item.resolution) ?? []))] },
  ];
});
watch(() => value.value.imageRatio, () => {
  const sizeRatio = ratioOfSize(value.value.imageSize);
  if (sizeRatio && value.value.imageRatio && sizeRatio !== value.value.imageRatio) value.value.imageSize = "";
});
onMounted(async () => {
  try { models.value = (await axios.get<{ data: MediaModel[] }>("/api/ai/media/models")).data.data; }
  catch { loadError.value = "媒体规格读取失败，请检查模型设置后重新打开页面"; }
});
</script>

<style scoped lang="scss">
.mediaPreferences {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 12px 0;
  label {
    display: grid;
    gap: 6px;
    flex: 1 1 120px;
    font-size: 12px;
    .el-select { width: 100%; }
  }
}
</style>
