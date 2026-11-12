<template>
  <section v-if="productionShots.length || shots.length || loadError" class="shotStrip" aria-label="镜头与素材">
    <header>
      <strong>{{ productionShots.length ? '镜头条' : '画布素材' }}</strong>
      <span v-if="productionShots.length">{{ productionShots.length }} 个镜头 · {{ productionShots.filter(item => item.approvedTake).length }} 个已批准 Take</span>
      <span v-else>{{ shots.length }} 个画面 · {{ shots.filter((item) => item.finalized).length }} 个已标记</span>
      <span v-if="loadError" role="status">{{ loadError }}</span>
    </header>
    <div class="shotItems">
      <article v-for="shot in productionShots" :key="shot.shotId" class="shotItem" :class="{ selected: workspaceStore.selectedProductionShotId === shot.shotId }">
        <button type="button" class="shotSelect" @click="openProduction?.(shot.shotId)">
          <img v-if="shot.hero?.media" :src="'/cloud' + shot.hero.media.url" :alt="shot.title" style="width:100%;aspect-ratio:2.6;object-fit:cover" />
          <span class="shotLabel">{{ shot.order + 1 }} · {{ shot.title }}</span>
        </button>
        <div class="shotState"><span :class="{ done: shot.approvedTake && !shot.reviewStale, attention: shot.highIssues || shot.reviewStale }">{{ shot.reviewStale ? '采用版本待复核' : shot.highIssues ? '连续性待处理' : shot.approvedTake ? 'Take 已批准' : shot.hero ? '主帧已选定' : '待选主帧' }}</span></div>
        <p class="shotWarning" v-if="shot.openIssues">{{ shot.openIssues }} 项连续性提示</p>
      </article>
      <article v-for="(shot, index) in productionShots.length ? [] : shots" :key="shot.id" class="shotItem">
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
                  ? "已标记"
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
            :aria-label="'标记素材 ' + (index + 1)"
            @change="emit('finalize', shot.id, $event === true)">
            标记
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
import { computed, inject, type ShallowRef } from "vue";
import type { ProductionSummary } from "@/lib/productionShots";
import { useWorkspaceStore } from "@/stores/workspace";
const workspaceStore = useWorkspaceStore();
const props = defineProps<{ shots: CanvasShot[]; directory?: string; projectId?: string }>();
const summary = inject<ShallowRef<ProductionSummary>>("productionSummary");
const productionShots = computed(() => summary?.value.shots ?? []), loadError = computed(() => summary?.value.error ?? "");
const openProduction = inject<(id: string) => void>("openProductionShot");
const emit = defineEmits<{ select: [id: string]; finalize: [id: string, finalized: boolean] }>();
</script>

<style scoped lang="scss">
.shotStrip {
  flex: none;
  max-height: 180px;
  box-sizing: border-box;
  overflow: auto;
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
      &.selected .shotSelect { border-color: var(--el-color-primary); }
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
