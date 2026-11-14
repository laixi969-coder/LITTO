<template>
  <div class="videoReferencePanel nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
    <p v-if="production">正式镜头沿用镜头制作中绑定的主帧与素材；请在镜头制作中更换参考。</p>
    <template v-else>
      <div v-if="frameMode" class="frameSlots">
        <section v-for="slot in slots" :key="slot.key">
          <label>{{ slot.label }}<el-select :modelValue="frames.bindings[slot.key] ? referenceKey(frames.bindings[slot.key]!) : ''" :disabled="disabled" :aria-label="slot.label" @change="value => assign(slot.key, value)"><el-option label="未指定" value="" /><el-option v-for="item in images" :key="referenceKey(item)" :value="referenceKey(item)" :label="`图片参考 ${references.indexOf(item) + 1} · ${item.value && item.dataType === 'IMAGE' ? item.value.url.split('/').at(-1) : '暂无输出'}`" /></el-select></label>
          <el-image v-if="slot.key === 'first' ? firstUrl : lastUrl" class="frameImage" :src="slot.key === 'first' ? firstUrl : lastUrl" :previewSrcList="[slot.key === 'first' ? firstUrl! : lastUrl!]" previewTeleported fit="contain" :alt="slot.label" @error="onPreviewError" />
        </section>
        <el-button v-if="mode !== 'singleImage'" :disabled="disabled" @click="swap">互换首尾帧</el-button>
      </div>
      <template v-if="Array.isArray(mode)"><p>{{ editing ? '待编辑原片' : '混合参考：图片用于外观与内容，视频用于动作与镜头，音频用于声音参考；用途仍以所选模型支持为准。' }}</p><p v-for="type in mediaTypes" :key="type.key">{{ type.label }}：{{ references.filter(item => item.dataType === type.key).length }} / {{ limit(type.name) }} 个</p><p v-if="!editing">素材时长限制按渠道要求核验；当前能力未声明统一的秒数上限。</p></template>
      <template v-if="editing"><p>继承原片时长与画幅，只选择输出分辨率；描述要修改的内容。</p><video v-if="sourceUrl" :src="sourceUrl" controls preload="metadata" aria-label="待编辑原片预览" @loadedmetadata="readSource" @error="onPreviewError" /><p v-if="sourceInfo">原片 {{ sourceInfo }}</p></template>
      <p v-if="error || previewError" role="alert" class="referenceError">{{ error || previewError }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElImage, ElSelect, ElOption } from "element-plus";
import { useNodeFiles } from "@toonflow/nodes-scaffold/workspaceFiles";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/runtime";
import { readVideoFrames, referenceKey, type VideoFrames } from "../videoReferences";
const props = defineProps<{ references: NodeInputValue[]; mode: unknown; editing?: boolean; production?: boolean; disabled?: boolean; error?: string }>();
const model = defineModel<VideoFrames>();
const frameMode = computed(() => ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(props.mode)));
const frames = computed(() => readVideoFrames(props.references, props.mode, model.value));
const images = computed(() => props.references.filter(item => item.dataType === "IMAGE"));
const slots = computed(() => props.mode === "singleImage" ? [{ key: "first" as const, label: "首帧（必填）" }] : [{ key: "first" as const, label: props.mode === "startFrameOptional" ? "首帧（可选）" : "首帧（必填）" }, { key: "last" as const, label: props.mode === "endFrameOptional" ? "尾帧（可选）" : "尾帧（必填）" }]);
const files = useNodeFiles();
const previewError = ref("");
const onPreviewError = () => { previewError.value = "无法读取参考预览，请检查素材文件"; };
const firstUrl = files.useFileUrl(computed(() => frames.value.first?.dataType === "IMAGE" ? frames.value.first.value : undefined), onPreviewError);
const lastUrl = files.useFileUrl(computed(() => frames.value.last?.dataType === "IMAGE" ? frames.value.last.value : undefined), onPreviewError);
const sourceUrl = files.useFileUrl(computed(() => { const item = props.editing ? props.references.find(item => item.dataType === "VIDEO") : undefined; return item?.dataType === "VIDEO" ? item.value : undefined; }), onPreviewError);
const sourceInfo = ref("");
watch([sourceUrl, firstUrl, lastUrl], () => { sourceInfo.value = ""; previewError.value = ""; });
function readSource(event: Event) { const video = event.target as HTMLVideoElement; sourceInfo.value = `${video.duration.toFixed(2)} 秒 · ${video.videoWidth} × ${video.videoHeight}`; }
const mediaTypes = [{ key: "IMAGE", name: "image", label: "图片参考" }, { key: "VIDEO", name: "video", label: "视频参考" }, { key: "AUDIO", name: "audio", label: "音频参考" }];
function limit(type: string) { return Array.isArray(props.mode) ? Number(props.mode.find(item => String(item).startsWith(`${type}Reference:`))?.split(":")[1] ?? 0) : 0; }
function assign(slot: "first" | "last", value: string) { const item = images.value.find(item => referenceKey(item) === value); model.value = { ...frames.value.bindings, [slot]: item ? { source: item.source, sourceHandle: item.sourceHandle } : null }; }
function swap() { model.value = { first: frames.value.bindings.last, last: frames.value.bindings.first }; }
</script>

<style scoped lang="scss">
.videoReferencePanel {
  margin: 10px 0; font-size: 12px;
  p { margin: 6px 0; line-height: 1.5; }
  .frameSlots { display: flex; align-items: start; gap: 10px; section { flex: 1; min-width: 0; label { display: grid; gap: 6px; } .frameImage { width: 100%; height: 80px; margin-top: 6px; } } }
  video { max-width: 100%; max-height: 150px; }
  .referenceError { color: var(--el-color-danger); }
}
</style>
