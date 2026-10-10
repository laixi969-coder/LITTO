<template>
  <section v-if="renderer" class="toolInteraction" :class="{ awaiting: tool.status === 'running' && !!tool.question }" :data-tool-id="tool.id" tabindex="-1">
    <div v-if="tool.status === 'running' && tool.question" class="attentionHeader"><icon-message-question :size="16" /><strong>需要你确认</strong><el-button link @click="collapsed = false">查看提出此问题的步骤</el-button></div>
    <component :is="renderer" :tool="tool" :directory="directory" @copy="emit('copy', $event)" />
  </section>
  <div v-if="rendererError" class="rendererError" role="alert" :data-tool-id="tool.id" tabindex="-1"><el-text type="danger">确认界面暂时无法显示：{{ rendererError }}</el-text><el-button size="small" @click="rendererRetry++">重新加载卡片</el-button></div>
  <chat-reasoning :id="'toolStep' + tool.id" v-model:collapsed="collapsed" class="messageReasoning toolCall" expandIconPlacement="left">
    <template #header>
      <span class="toolHeader" :data-status="tool.status">
        <icon-tool :size="14" />
        <span class="toolName" :title="tool.name">{{ toolLabel }}</span>
        <span class="toolState">{{ tool.name === 'subAgent' && tool.status === 'success' ? '调用已返回' : toolStatusLabels[tool.status] }}</span>
        <span v-if="duration !== undefined" class="toolDuration">{{ duration.toFixed(1) }} 秒</span>
      </span>
      <span v-if="targetPath" class="toolTarget" :title="targetPath">{{ targetPath }}</span>
    </template>
    <div v-if="!collapsed" class="toolDetails">
      <template v-for="(data, index) in [args, result]" :key="index">
        <template v-if="data">
          <span class="toolLabel">
            {{ index === 0 ? "参数" : "结果" }}
            <el-button v-if="!data.markdown" text size="small" :icon="IconCopy" :aria-label="index === 0 ? '复制工具参数' : '复制工具结果'" @click="emit('copy', data.content)" />
          </span>
          <messageMarkdown v-if="data.markdown" class="toolData" :class="{ toolError: index === 1 && tool.status === 'error' }" :content="data.markdown" :codeOptions="toolCodeOptions" />
          <pre v-else class="toolData toolPlain" :class="{ toolError: index === 1 && tool.status === 'error' }" tabindex="0" :aria-label="index === 0 ? '工具参数' : '工具结果'">{{ data.content }}</pre>
        </template>
      </template>
    </div>
  </chat-reasoning>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, ref, shallowRef, watch, type Component } from "vue";
import { loadToolComponent } from "@toonflow/tools-scaffold/client";
import { IconCopy, IconTool, IconMessageQuestion } from "@tabler/icons-vue";
import chatReasoning from "@tdesign-vue-next/chat/es/chat-reasoning";
import type { AgentToolCall } from "@toonflow/server/agent/types";
import messageMarkdown from "@/components/messageMarkdown.vue";

const { tool, directory, duration } = defineProps<{ tool: AgentToolCall; directory?: string; duration?: number }>();
const emit = defineEmits<{ copy: [content: string] }>();
const renderer = shallowRef<Component>();
const rendererError = ref("");
const rendererRetry = ref(0);
watch(() => [tool.name, tool.question?.callId, rendererRetry.value] as const, async ([name], _previous, onCleanup) => {
  let active = true;
  onCleanup(() => { active = false; });
  renderer.value = undefined;
  rendererError.value = "";
  if (name === "subAgent") return;
  try {
    const component = await loadToolComponent(["requestStoryApproval", "requestStoryDecision"].includes(name) ? "askUser" : name);
    if (active) {
      renderer.value = component;
      if (!component && tool.status === "running" && tool.question?.callId) rendererError.value = "该工具未提供可用的交互组件";
    }
  } catch (error) {
    if (active) rendererError.value = error instanceof Error ? error.message : String(error);
  }
}, { immediate: true });
onErrorCaptured(error => {
  if (!renderer.value) return;
  renderer.value = undefined;
  rendererError.value = error.message;
  return false;
});
const collapsed = defineModel<boolean>("collapsed", { default: true });
const toolStatusLabels = { running: "调用中…", success: "已完成", error: "调用失败", interrupted: "已中断" };
const toolLabels: Record<string, string> = { read: "读取文件", write: "写入文件", edit: "修改文件", askUser: "确认创作需求", requestStoryApproval: "确认采用故事", requestStoryDecision: "确认故事创作选择", subAgent: "委派任务", generateImage: "生成图片", generateVideo: "生成视频", generateAudio: "生成音频", getCanvas: "读取画布", getCanvasNodes: "读取画面节点", addCanvasNodes: "添加画面节点", listMediaModels: "读取可用模型" };
const toolLabel = computed(() => toolLabels[tool.name] || tool.name || "工具调用");
const targetPath = computed(() => {
  const path = tool.args?.path ?? tool.args?.filePath ?? tool.args?.canvasId;
  return typeof path === "string" ? path : undefined;
});
const toolCodeOptions = { maxHeight: 240, lineNumbers: false };
const args = computed(() => formatToolData(tool.args));
const result = computed(() => formatToolData(tool.result));

function formatToolData(value: unknown) {
  if (value === undefined) return;
  try {
    const content = JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2) ?? "";
    // ACT: 超过 16K 字符只渲染完整文本，限制高亮与 token DOM 开销；更大数据量可改为虚拟行。
    return { content, markdown: content.length <= 16_384 ? `~~~json\n${content}\n~~~` : undefined };
  } catch {
    return { content: String(value), markdown: undefined };
  }
}
</script>

<style scoped lang="scss">
.rendererError { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 0; }
.toolInteraction {
  &.awaiting { padding: 12px; margin: 8px 0; border: 1px solid var(--studioAttention); border-radius: var(--ui-radius); background: var(--studioAttentionSoft); }
  .attentionHeader { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--studioAttention); font-size: 12px; margin-bottom: 12px; .el-button { margin-left: auto; color: inherit; } }
}
.toolCall {
  min-width: 0;
  padding: 8px 0;
  border-bottom: 1px solid var(--studioBorder);
  .toolTarget { display: block; padding: 4px 0 0 20px; color: var(--studioMuted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .toolHeader {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--el-text-color-secondary);

    .toolName {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toolState {
      flex-shrink: 0;
      font-size: 12px;
    }

    .toolDuration { margin-left: auto; flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; }
    &[data-status="success"] { color: var(--studioDone); }

    &[data-status="error"] .toolState { color: var(--el-color-danger); }
  }

  .toolDetails {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    font-size: 12px;

    .toolLabel {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--el-text-color-secondary);
    }

    .toolData {
      margin: 0 0 6px;
      font-size: 12px;
      line-height: 1.5;

      :deep([data-stream-markdown="code-block"]) {
        margin: 0;
        border-radius: var(--ui-radius);
      }

      :deep([data-stream-markdown="code-block-content"]) {
        overscroll-behavior: contain;
        pre {
          white-space: pre;
          overflow-wrap: normal;
        }
      }

      &.toolError :deep([data-stream-markdown="code-block"]) { border-color: var(--el-color-danger-light-5); }

      &.toolPlain {
        min-width: 0;
        max-width: 100%;
        max-height: 240px;
        padding: 12px;
        overflow: auto;
        overscroll-behavior: contain;
        white-space: pre;
        overflow-wrap: normal;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        color: var(--el-text-color-primary);
        background: var(--el-fill-color-light);
        border: 1px solid var(--el-border-color-lighter);
        border-radius: var(--ui-radius);

        &.toolError { border-color: var(--el-color-danger-light-5); }
      }
    }
  }
}
</style>
