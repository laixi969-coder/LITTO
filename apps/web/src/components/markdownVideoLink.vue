<template>
  <component v-if="!workspaceVideo" :is="COMPONENT_RENDERERS.link" v-bind="link" />
  <span v-else class="workspaceVideo">
    <a v-if="videoUrl" :href="videoUrl" :download="fileName">
      <node-list v-bind="link" :parentNode="link.node" :nodes="link.node.children" :deep="link.deep + 1" />
    </a>
    <span v-else role="status">{{ failed ? "视频读取失败" : "视频加载中…" }}</span>
    <video v-if="videoUrl" :src="videoUrl" controls preload="metadata" :aria-label="fileName" />
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { COMPONENT_RENDERERS, NodeList, type LinkNodeRendererProps } from "vue-stream-markdown";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const props = defineProps<{ link: LinkNodeRendererProps; directory: string }>();
const videoUrl = ref("");
const failed = ref(false);
const workspaceVideo = computed(() => !!props.link.node.url
  && !/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(props.link.node.url)
  && /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(props.link.node.url));
const fileName = computed(() => props.link.node.url.split(/[?#]/, 1)[0]!.split("/").pop() || "video.mp4");

watch(() => [props.directory, props.link.node.url, props.link.node.loading] as const, async ([directory, url, streaming], _previous, onCleanup) => {
  videoUrl.value = "";
  failed.value = false;
  if (!workspaceVideo.value || streaming) return;
  let cancelled = false;
  let release = () => {};
  onCleanup(() => { cancelled = true; release(); });
  try {
    const path = decodeURIComponent(url.split(/[?#]/, 1)[0]!);
    const preview = useWorkspaceFiles(directory).acquireUrl(path);
    release = preview.release;
    const resolvedUrl = await preview.url;
    if (!cancelled) videoUrl.value = resolvedUrl;
  } catch {
    if (!cancelled) failed.value = true;
  }
}, { immediate: true });
</script>

<style scoped lang="scss">
.workspaceVideo {
  video {
    display: block;
    width: 100%;
    max-height: 480px;
    margin: 8px 0;
    border-radius: 8px;
    background: #000;
  }
}
</style>
