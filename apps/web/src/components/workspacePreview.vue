<template>
  <div class="workspacePreview">
    <img v-if="url && !error && mimeType?.startsWith('image/')" :src="url" :alt="label" loading="lazy" @error="error = true" />
    <video
      v-else-if="url && !error && mimeType?.startsWith('video/')"
      :src="url"
      preload="metadata"
      muted
      playsinline
      :aria-label="label"
      @error="error = true" />
    <span v-else class="previewStatus">{{ error ? "画面无法读取" : path ? "读取画面…" : "尚未生成" }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const props = defineProps<{ directory?: string; path?: string; mimeType?: string; label: string }>();
const url = ref("");
const error = ref(false);
watch(
  () => [props.directory, props.path, props.mimeType] as const,
  async ([directory, path, mimeType], _previous, onCleanup) => {
    url.value = "";
    error.value = false;
    if (!directory || !path) return;
    let active = true;
    const resource = useWorkspaceFiles(directory).acquireUrl(path, mimeType);
    onCleanup(() => {
      active = false;
      resource.release();
    });
    try {
      const value = await resource.url;
      if (active) url.value = value;
    } catch {
      if (active) error.value = true;
    }
  },
  { immediate: true },
);
</script>

<style scoped lang="scss">
.workspacePreview {
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--studioInset);
  img,
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .previewStatus {
    color: var(--studioMuted);
    font-size: 12px;
  }
}
</style>
