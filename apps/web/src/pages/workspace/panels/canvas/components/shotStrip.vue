<template>
  <section class="shotStrip" aria-label="镜头条">
    <header>
      <strong>镜头条</strong>
      <span>{{ shots.length }} 个画面 · {{ shots.filter((item) => item.finalized).length }} 个已定稿</span>
    </header>
    <div class="shotItems">
      <article v-for="(shot, index) in shots" :key="shot.id" class="shotItem">
        <button type="button" class="shotSelect" :aria-label="'定位镜头 ' + (index + 1) + '，' + shot.label" @click="emit('select', shot.id)">
          <workspacePreview :directory="directory" :path="shot.path" :mimeType="shot.mimeType" :label="shot.label" />
          <span class="shotLabel">{{ index + 1 }} · {{ shot.label }}</span>
        </button>
        <div class="shotState">
          <span :class="{ done: !!shot.path, attention: !!shot.warning }">
            {{
              shot.warning
                ? "一致性提示"
                : shot.finalized
                  ? "已定稿"
                  : shot.path
                    ? shot.kind === "video"
                      ? "已出片"
                      : "已出图"
                    : shot.kind === "video"
                      ? "待出片"
                      : "待出图"
            }}
          </span>
          <el-checkbox
            v-if="shot.path"
            :modelValue="shot.finalized"
            :aria-label="'将镜头 ' + (index + 1) + ' 标记为定稿'"
            @change="emit('finalize', shot.id, $event === true)">
            定稿
          </el-checkbox>
        </div>
        <p v-if="shot.warning" class="shotWarning">{{ shot.warning }}</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { CanvasShot } from "@/lib/canvasShots";
import workspacePreview from "@/components/workspacePreview.vue";
defineProps<{ shots: CanvasShot[]; directory?: string }>();
const emit = defineEmits<{ select: [id: string]; finalize: [id: string, finalized: boolean] }>();
</script>

<style scoped lang="scss">
.shotStrip {
  height: 180px;
  border-top: 1px solid var(--studioBorder);
  background: var(--studioSurface);
  padding: 12px 16px;
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
    strong {
      font-size: 12px;
      font-weight: 600;
    }
    span {
      font-size: 11px;
      color: var(--studioMuted);
    }
  }
  .shotItems {
    display: flex;
    gap: 12px;
    overflow: auto;
    padding: 2px 2px 8px;
    max-height: 140px;
    .shotItem {
      flex: 0 0 144px;
      min-width: 0;
      .shotSelect {
        display: block;
        padding: 0;
        border: 1px solid var(--studioBorder);
        border-radius: var(--ui-radius);
        background: transparent;
        color: var(--studioInk);
        overflow: hidden;
        text-align: left;
        width: 100%;
        cursor: pointer;
        .workspacePreview {
          aspect-ratio: 2.6;
        }
        .shotLabel {
          display: block;
          padding: 6px 8px;
          font-size: 11px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
      .shotState {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: var(--studioMuted);
        .done {
          color: var(--studioDone);
        }
        .attention {
          color: var(--studioAttention);
        }
        :deep(.el-checkbox) {
          height: 28px;
          .el-checkbox__label {
            font-size: 11px;
            padding-left: 4px;
          }
        }
      }
      .shotWarning {
        font-size: 11px;
        line-height: 1.6;
        color: var(--studioAttention);
        margin: 0;
      }
    }
  }
}
</style>
