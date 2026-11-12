<template>
  <section class="shotOverview" aria-label="镜头总览">
    <header>
      <strong>{{ shots.length }} 个镜头</strong>
      <div class="viewSwitch" aria-label="镜头视图">
        <button type="button" :aria-pressed="view === 'grid'" @click="view = 'grid'">宫格</button>
        <button type="button" :aria-pressed="view === 'list'" @click="view = 'list'">列表</button>
      </div>
    </header>
    <div class="shotItems" :class="{ listView: view === 'list' }">
      <article v-for="shot in shots" :key="shot.id" :class="{ selected: selectedId === shot.id }">
        <button class="shotSelect" type="button" :aria-pressed="selectedId === shot.id" @click="emit('open', shot.id, 'shot')">
          <img v-if="shot.heroKeyframe?.media" :src="mediaUrl(shot.heroKeyframe.media.url)" :alt="shot.title" loading="lazy" />
          <span class="shotMeta"><strong>{{ shot.ord + 1 }} · {{ shot.title }}</strong><span>{{ shot.duration }} 秒 · {{ shot.approvedTakeId ? '已选 Take' : shot.heroKeyframeId ? '已选主帧' : '待选主帧' }}</span><span>{{ shot.bindings?.length ?? 0 }} 项参考绑定</span></span>
        </button>
        <p v-if="shot.reviewStale" class="reviewWarning">规格或参考已变化，已选版本待重新检查</p>
        <div class="shotActions">
          <button type="button" @click="emit('locate', shot.id, shot.title)">定位画布</button>
          <button type="button" @click="emit('open', shot.id, 'review')">版本与采用</button>
          <button type="button" @click="emit('open', shot.id, 'shot')">规格与参考</button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
defineProps<{ shots: any[]; selectedId: string }>();
const emit = defineEmits<{ open: [id: string, section: string]; locate: [id: string, title: string] }>();
const view = ref("grid");
const mediaUrl = (url: string) => url.startsWith("/") ? `/cloud${url}` : url;
</script>

<style scoped lang="scss">
.shotOverview {
  button { color: var(--el-text-color-primary); background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 5px; padding: 6px 10px; cursor: pointer; &:hover { border-color: var(--el-color-primary); } &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; } &[aria-pressed="true"] { color: var(--el-color-primary); } }
  header { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; .viewSwitch { display: flex; gap: 8px; } }
  .shotItems {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px;
    article {
      border: 1px solid var(--el-border-color); border-radius: 8px; overflow: hidden;
      &.selected { border-color: var(--el-color-primary); }
      .reviewWarning { margin: 0 12px 12px; color: var(--el-color-warning); }
      .shotSelect { display: flex; flex-direction: column; width: 100%; padding: 0; border: 0; text-align: left; img { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: var(--el-fill-color); } .shotMeta { display: grid; gap: 6px; padding: 12px; overflow-wrap: anywhere; } }
      .shotActions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 12px; }
    }
    &.listView { grid-template-columns: 1fr; article .shotSelect { flex-direction: row; align-items: center; img { width: 140px; flex: none; } } }
  }
}
</style>
