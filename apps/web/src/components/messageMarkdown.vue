<template>
  <div class="messageMarkdown">
    <!-- ACT: 流式结束时重建末块，清除解析器遗留的未闭合链接状态；逐字更新仍复用实例。 -->
    <span v-if="renderFailed" class="plainText">{{ content }}</span>
    <template v-else>
      <markdown
        v-for="(chunk, index) in chunks"
        :key="index + '-' + !!definitions + '-' + (streaming && index === chunks.length - 1 ? 'streaming' : 'static')"
        v-memo="[chunk, streaming && index === chunks.length - 1, codeOptions, directory, markdownLocale]"
        class="markdownChunk"
        :content="chunk"
        :mode="streaming && index === chunks.length - 1 ? 'streaming' : 'static'"
        :enableAnimate="false"
        :shikiOptions="shikiOptions"
        :codeOptions="codeOptions"
        :linkOptions="{ safetyCheck: false }"
        :cdnOptions="cdnOptions"
        :components="markdownOverlays"
        :nodeRenderers="nodeRenderers"
        :parseMarkdownIntoBlocks="definitions ? keepChunk : undefined"
        :locale="markdownLocale" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onErrorCaptured, ref } from "vue";
import { Markdown, parseMarkdownIntoBlocks } from "vue-stream-markdown";
import { MarkdownAstParser } from "@markmend/ast";
import type { CodeOptions, ImageNodeRendererProps, LinkNodeRendererProps, ShikiOptions } from "vue-stream-markdown";
import "vue-stream-markdown/index.css";
import "vue-stream-markdown/theme.css";
import markdownOverlays from "./markdownOverlays";
import markdownImage from "./markdownImage.vue";
import markdownVideoLink from "./markdownVideoLink.vue";
import { markdownLocale } from "@/lib/i18n";

const { content, streaming = false, codeOptions, directory } = defineProps<{ content: string; streaming?: boolean; codeOptions?: CodeOptions; directory?: string }>();
const renderFailed = ref(false);
onErrorCaptured(() => {
  // 排版资源断网加载失败时保留正文和父级编辑器，不让节点错误边界卸载未保存输入。
  renderFailed.value = true;
  return false;
});
const renderImage = (image: ImageNodeRendererProps) => h(markdownImage, { image, directory: directory! });
const renderLink = (link: LinkNodeRendererProps) => h(markdownVideoLink, { link, directory: directory! });
const nodeRenderers = computed(() => directory ? { image: renderImage, link: renderLink } : {});
const shikiOptions: ShikiOptions = { theme: ["github-light", "github-dark"] };
const cdnOptions = { shiki: false } as const;
const keepChunk = (value: string) => [value];
const blocks = computed(() => parseMarkdownIntoBlocks(content));
const definitionParser = new MarkdownAstParser({ mode: "static" });
const isDefinition = (block: string) => /^ {0,3}\[(?!\^)[^\]\n]+\]:/.test(block)
  && definitionParser.markdownToAst(block).children.every(node => node.type === "definition");
const definitions = computed(() => blocks.value.length > 1 ? blocks.value.filter(isDefinition).join("\n\n") : "");
const chunks = computed(() => {
  if (blocks.value.length < 2) return blocks.value;
  const groups: string[] = [];
  let current = "";
  // ACT: 不拆语法块，稳定组不重渲染；单个语法块仍完整交给库处理。
  for (const block of blocks.value) {
    if (isDefinition(block)) continue;
    if (current && current.length + block.length > 8192) {
      groups.push(current);
      current = "";
    }
    current += block;
  }
  if (current) groups.push(current);
  // 定义放在组前，避免落入末尾尚未闭合的代码块。
  return definitions.value ? groups.map(group => `${definitions.value}\n\n${group}`) : groups;
});
</script>

<style scoped lang="scss">
.messageMarkdown {
  min-width: 0;

  .plainText { white-space: pre-wrap; overflow-wrap: anywhere; }

  .markdownChunk {
    --background: var(--el-bg-color);
    --foreground: var(--el-text-color-primary);
    --muted: var(--el-fill-color-light);
    --muted-foreground: var(--el-text-color-secondary);
    --border: var(--el-border-color-lighter);
    --primary: var(--el-color-primary);
    font-size: inherit;
    line-height: inherit;

    & + .markdownChunk {
      margin-top: 12px;
    }
  }
}
</style>
