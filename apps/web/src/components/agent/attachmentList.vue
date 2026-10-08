<template>
  <div class="attachmentList">
    <div v-for="(attachment, index) in attachments" :key="attachment.path || index" class="attachmentEntry">
      <attachmentPreview :attachment="attachment" :directory="directory" :removable="removable" :restorable="restorable" :disabled="disabled" @remove="emit('remove', index)" @restore="emit('restore', index)" />
      <template v-if="attachment.mimeType.startsWith('image/')">
        <label v-if="editableNames">角色名 / 图片用途<input :value="attachment.name" :disabled="disabled" maxlength="200" @change="emit('rename', index, ($event.target as HTMLInputElement).value)" /></label>
        <span v-else class="imageName">{{ attachment.name }}</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import attachmentPreview from "./attachmentPreview.vue";
import type { AgentAttachment } from "./types";

defineProps<{ attachments: AgentAttachment[]; directory?: string; removable?: boolean; restorable?: boolean; disabled?: boolean; editableNames?: boolean }>();
const emit = defineEmits<{ remove: [index: number]; restore: [index: number]; rename: [index: number, name: string] }>();
</script>

<style scoped lang="scss">
.attachmentList {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  .attachmentEntry {
    max-width: 180px;
    label { display: grid; gap: 4px; margin-top: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
    input { width: 100%; box-sizing: border-box; border: 1px solid var(--el-border-color); border-radius: 4px; padding: 6px; color: var(--el-text-color-primary); background: var(--el-bg-color); }
    .imageName { display: block; margin-top: 4px; font-size: 12px; overflow-wrap: anywhere; }
  }
}
</style>
