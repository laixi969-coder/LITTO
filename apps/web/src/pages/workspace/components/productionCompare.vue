<template>
  <section class="productionCompare" aria-label="画面对比与导演批注">
    <h3>画面对比与导演批注</h3>
    <label>对照版本<select v-model="compareId"><option value="">不对比</option><option v-for="item in alternatives" :key="item.id" :value="item.id">{{ label(item) }} · {{ item.id.slice(-5) }} · {{ item.modelId || '已有素材' }}</option></select></label>
    <div class="compareGrid" :class="{ paired: cards.length === 2 }">
      <article v-for="item in cards" :key="item.id">
        <h4>{{ item.id === target.id ? '当前检查版本' : '对照版本' }} · {{ label(item) }} · {{ item.id.slice(-5) }}</h4>
        <div class="mediaFrame" :style="frameStyle(item)">
          <img v-if="item.type === 'keyframe'" :src="mediaUrl(item.media!.url)" :alt="item.id === target.id ? '当前关键帧候选' : '对照关键帧'" @load="measure(item.id, $event)" />
          <video v-else :ref="element => setPlayer(item.id, element)" :src="mediaUrl(item.media!.url)" controls playsinline preload="metadata" :aria-label="item.id === target.id ? '当前 Take' : '对照 Take'" @loadedmetadata="measure(item.id, $event)" @timeupdate="clearMovedNote(item.id)" />
          <button v-if="marking && item.id === target.id" class="markSurface" type="button" aria-label="点击画面标记位置，键盘回车标记中心" @click="markPoint" />
          <button v-for="(entry, index) in notesFor(item.id)" v-show="entry.point && (item.type === 'keyframe' || selectedNote === entry.id)" :key="entry.id" class="notePin" type="button" :style="pinStyle(entry.point)" :aria-label="`查看批注 ${index + 1}：${entry.note}`" @click="showNote(entry)">{{ index + 1 }}</button>
          <span v-if="point && item.id === target.id && (item.type === 'keyframe' || Math.abs((playheads[item.id] ?? 0) - (time ?? 0)) <= 0.25)" class="draftPin" :style="pinStyle(point)" aria-label="待保存的批注位置">＋</span>
        </div>
        <ul v-if="notesFor(item.id).length" class="noteList">
          <li v-for="(entry, index) in notesFor(item.id)" :key="entry.id" :class="{ selectedNote: selectedNote === entry.id }">
            <button type="button" @click="showNote(entry)">{{ index + 1 }} · {{ entry.time === undefined ? '静帧 / 整体' : entry.time.toFixed(2) + ' 秒' }}</button>
            <p>{{ entry.note }}</p><small>{{ entry.createdAt }}</small>
            <button type="button" :disabled="dirty || saving" @click="emit('reviewNote', entry)">带入问题记录</button>
            <button v-if="item.type === 'keyframe'" type="button" :disabled="dirty || saving" @click="emit('repairNote', entry)">用于局部修改</button>
          </li>
        </ul>
      </article>
    </div>
    <p>批注保存到当前检查版本；正式采用仍需完成下方检查。</p>
    <div class="noteActions">
      <button type="button" :disabled="saving" :aria-pressed="marking" @click="startMark">{{ marking ? '取消位置标记' : '标记画面位置' }}</button>
      <button v-if="point" type="button" :disabled="saving" @click="point = undefined">清除位置</button>
      <button v-if="target.type === 'take'" type="button" :disabled="saving" @click="captureTime">记录当前时间点</button>
      <span v-if="time !== undefined">{{ time.toFixed(2) }} 秒</span>
    </div>
    <label>导演批注<textarea v-model="note" rows="3" maxlength="2000" :disabled="saving" @input="saved = false" /></label>
    <button type="button" :disabled="saving || !note.trim()" @click="save">{{ saving ? '保存中…' : '保存导演批注' }}</button>
    <button v-if="dirty" type="button" :disabled="saving" @click="clearDraft">放弃未保存批注</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="saved" role="status">导演批注已保存</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

type Point = { x: number; y: number };
type Version = { id: string; type: string; localRepairOf?: string; modelId?: string; media?: { id: string; url: string; width?: number; height?: number } };
type DirectorNote = { id: string; targetId: string; targetType: string; mediaId: string; note: string; point?: Point; time?: number; createdAt: string };
const props = defineProps<{ shotId: string; target: Version; versions: Version[]; notes: DirectorNote[]; label: (item: Version) => string; request: (path: string, method?: string, body?: unknown) => Promise<any> }>();
const emit = defineEmits<{ saved: []; reviewNote: [note: DirectorNote]; repairNote: [note: DirectorNote] }>();
const compareId = ref(""), note = ref(""), error = ref(""), saved = ref(false), saving = ref(false), marking = ref(false), selectedNote = ref("");
const point = ref<Point>(), time = ref<number>();
const dimensions = ref<Record<string, { width: number; height: number }>>({});
const playheads = ref<Record<string, number>>({});
const players = new Map<string, HTMLVideoElement>();
let requestId = crypto.randomUUID();
let pendingContent = "";
const dirty = computed(() => !!note.value.trim() || !!point.value || time.value !== undefined);
const alternatives = computed(() => props.versions.filter(item => item.id !== props.target.id && item.type === props.target.type && item.media));
const cards = computed(() => [props.target, ...alternatives.value.filter(item => item.id === compareId.value)].filter(item => item.media));
const notesFor = (id: string) => props.notes.filter(entry => entry.targetId === id);
const mediaUrl = (url: string) => url.startsWith("/") ? `/cloud${url}` : url;
const pinStyle = (value?: Point) => value ? { left: `${value.x * 100}%`, top: `${value.y * 100}%` } : {};
function setPlayer(id: string, element: unknown) { if (element instanceof HTMLVideoElement) players.set(id, element); else players.delete(id); }
function frameStyle(item: Version) {
  const size = dimensions.value[item.id] ?? item.media;
  const ratio = size?.width && size.height ? size.width / size.height : 16 / 9;
  return { width: `${Math.min(600, 360 * ratio)}px`, aspectRatio: String(ratio) };
}
function measure(id: string, event: Event) {
  const media = event.target;
  if (media instanceof HTMLImageElement) dimensions.value[id] = { width: media.naturalWidth, height: media.naturalHeight };
  if (media instanceof HTMLVideoElement) dimensions.value[id] = { width: media.videoWidth, height: media.videoHeight };
}
function captureTime() {
  const player = players.get(props.target.id);
  if (!player || !Number.isFinite(player.duration)) { error.value = "视频尚未就绪，请加载后再标记"; return false; }
  player.pause(); time.value = player.currentTime; saved.value = false; error.value = "";
  return true;
}
function startMark() {
  if (!marking.value && props.target.type === "take" && !captureTime()) return;
  marking.value = !marking.value;
}
function markPoint(event: MouseEvent) {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  point.value = event.detail === 0 ? { x: 0.5, y: 0.5 } : { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  marking.value = false; saved.value = false;
}
function showNote(entry: DirectorNote) {
  const player = players.get(entry.targetId);
  if (entry.time !== undefined && player && Number.isFinite(player.duration)) { player.pause(); player.currentTime = Math.min(entry.time, player.duration); }
  selectedNote.value = entry.id;
}
function clearMovedNote(id: string) {
  playheads.value[id] = players.get(id)?.currentTime ?? 0;
  const entry = props.notes.find(item => item.id === selectedNote.value && item.targetId === id);
  if (entry?.time !== undefined && Math.abs((players.get(id)?.currentTime ?? 0) - entry.time) > 0.25) selectedNote.value = "";
}
function clearDraft() { note.value = ""; point.value = undefined; time.value = undefined; marking.value = false; error.value = ""; saved.value = false; pendingContent = ""; requestId = crypto.randomUUID(); }
function assertSaved() { if (saving.value || dirty.value) throw new Error("请先保存或放弃导演批注，再切换镜头、版本或关闭面板"); }
watch(() => props.target.id, () => { clearDraft(); selectedNote.value = ""; if (props.target.localRepairOf && alternatives.value.some(item => item.id === props.target.localRepairOf)) compareId.value = props.target.localRepairOf; else if (!alternatives.value.some(item => item.id === compareId.value)) compareId.value = alternatives.value.find(item => ["当前主帧", "当前采用"].includes(props.label(item)))?.id ?? alternatives.value[0]?.id ?? ""; }, { immediate: true });
async function save() {
  if (saving.value || !note.value.trim() || !props.target.media) return;
  saving.value = true; error.value = ""; saved.value = false;
  try {
    const content = { targetType: props.target.type, targetId: props.target.id, mediaId: props.target.media.id, note: note.value.trim(), point: point.value, time: time.value };
    const signature = JSON.stringify(content);
    if (pendingContent !== signature) { requestId = crypto.randomUUID(); pendingContent = signature; }
    await props.request(`/shots/${props.shotId}/directorNotes`, "POST", { id: requestId, ...content });
    clearDraft(); saved.value = true; emit("saved");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "批注保存失败，请重试核对"; }
  finally { saving.value = false; }
}
defineExpose({ assertSaved });
</script>

<style scoped lang="scss">
.productionCompare {
  label { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
  select, textarea, button { font: inherit; color: var(--studioInk); background: var(--studioSurface); border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); padding: 8px 12px; min-height: 44px; }
  select, textarea { min-width: 0; max-width: 100%; }
  textarea { resize: vertical; }
  button { cursor: pointer; &:disabled { opacity: .5; cursor: not-allowed; } }
  :is(button, select, textarea):focus-visible { outline: 2px solid var(--studioDone); outline-offset: 2px; }
  [role="alert"] { color: var(--el-color-danger); }
  .compareGrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px;
    &.paired { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    article { min-width: 0; }
    .mediaFrame { position: relative; max-width: 100%; background: var(--studioBorder);
      img, video { display: block; width: 100%; height: 100%; object-fit: contain; }
      .markSurface { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; background: transparent; cursor: crosshair; }
      .notePin, .draftPin { position: absolute; transform: translate(-50%, -50%); min-height: 28px; min-width: 28px; padding: 2px; border: 2px solid white; border-radius: 50%; background: var(--studioInk); color: var(--studioSurface); text-align: center; }
      .draftPin { pointer-events: none; }
    }
    .noteList { padding: 0; list-style: none;
      li { padding: 8px; border-bottom: 1px solid var(--studioBorder); p { white-space: pre-wrap; overflow-wrap: anywhere; } }
      .selectedNote { outline: 2px solid var(--studioDone); }
    }
  }
  .noteActions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  @media (max-width: 760px) { .compareGrid.paired { grid-template-columns: minmax(0, 1fr); } }
}
</style>
