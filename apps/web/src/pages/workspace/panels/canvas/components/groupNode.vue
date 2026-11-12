<template>
  <div class="groupNode" :class="{ selected, resizing: !!resize }">
    <input
      v-if="editingLabel"
      ref="labelInput"
      v-model="labelDraft"
      class="groupLabelInput nodrag nopan"
      aria-label="分组名称"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @dblclick.stop
      @keydown.stop
      @keydown.enter="confirmLabel"
      @keydown.esc.prevent="editingLabel = false"
      @blur="saveLabel" />
    <span v-else class="groupLabel" tabindex="0" :title="`${data.label || '分组'}（双击编辑名称）`" @dblclick.stop="editLabel" @keydown.enter.stop.prevent="editLabel">
      {{ data.label || "分组" }}
    </span>
    <div class="groupActions nodrag nopan" @dblclick.stop @pointerdown.stop>
      <button v-if="shotId" type="button" @click.stop="openProduction?.(shotId)">镜头制作</button>
      <button type="button" :aria-expanded="!data.collapsed" @click.stop="toggleCollapsed">{{ data.collapsed ? '展开' : '折叠' }}</button>
    </div>
    <div v-if="data.collapsed" class="groupSummary">
      <template v-if="shot">
        <img v-if="shot.hero?.media" :src="'/cloud' + shot.hero.media.url" alt="当前主帧" />
        <strong>{{ shot.order + 1 }} · {{ shot.title }}</strong>
        <span>{{ shot.reviewStale ? '采用版本待复核' : shot.approvedTake ? 'Take 已批准' : shot.hero ? '主帧已选定' : '待选主帧' }}</span>
        <span v-if="shot.activeJobs">{{ shot.activeJobs }} 项生成中</span>
        <span v-if="shot.failedJobs">{{ shot.failedJobs }} 项生成失败 · 到镜头制作查看</span>
      </template>
      <span v-else>{{ childCount }} 个节点</span>
      <span v-if="summary?.error" role="status">{{ summary.error }}</span>
    </div>
    <button
      v-for="corner in data.collapsed ? [] : resizeCorners"
      :key="corner.name"
      class="resizeCorner nodrag nopan"
      :class="corner.name"
      type="button"
      :aria-label="`调整分组${corner.label}`"
      @pointerdown.stop.prevent="startResize($event, corner)"
      @pointermove.stop="moveResize"
      @pointerup.stop="finishResize"
      @pointercancel="finishResize"
      @lostpointercapture="finishResize"
      @mousedown.stop
      @click.stop
      @dblclick.stop />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch, type ShallowRef } from "vue";
import { productionShotId, type ProductionSummary } from "@/lib/productionShots";
import { fitGroupBounds, getSelectionTree } from "../selectionNodes";
import { useVueFlow, type GraphNode, type NodeProps } from "@vue-flow/core";
import { ElMessage } from "element-plus";

const props = defineProps<NodeProps>();
const shotId = computed(() => productionShotId(props));
const openProduction = inject<(id: string) => void>("openProductionShot");
const flow = useVueFlow();
const summary = inject<ShallowRef<ProductionSummary>>("productionSummary");
const shot = computed(() => summary?.value.shots.find(item => item.shotId === shotId.value));
const childCount = computed(() => flow.getNodes.value.filter(node => node.parentNode === props.id).length);
async function toggleCollapsed() {
  const action = async () => {
    const node = flow.findNode(props.id);
    if (!node) return;
    if (!node.dimensions.width || !node.dimensions.height) throw new Error("分组尺寸尚未就绪，请稍后再试");
    const collapsed = !node.data.collapsed;
    const size = collapsed ? { width: 300, height: 280 } : node.data.expandedSize ?? { width: 520, height: 360 };
    if (collapsed) {
      node.data.expandedSize = { ...node.dimensions };
      flow.removeSelectedNodes(getSelectionTree([node], flow.getNodes.value).filter(child => child.id !== node.id));
    }
    node.data.collapsed = collapsed;
    node.style = { ...(typeof node.style === "object" ? node.style : {}), width: `${size.width}px`, height: `${size.height}px` };
    node.dimensions = { ...size };
    if (!collapsed && flow.getNodes.value.some(child => child.parentNode === node.id && (child.position.x < 0 || child.position.y < 0 || child.position.x + child.dimensions.width > size.width || child.position.y + child.dimensions.height > size.height))) fitGroupBounds(flow.getNodes.value, new Set([node]));
    await nextTick();
    flow.updateNodeInternals([props.id]);
  };
  try { await (batchHistory ? batchHistory(action) : action()); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "折叠失败"); }
}
const batchHistory = inject<((action: () => Promise<void>) => Promise<void>) | undefined>("batchCanvasHistory", undefined);
const editingLabel = ref(false);
const labelDraft = ref("");
const labelInput = ref<HTMLInputElement>();
const resizeCorners = [
  { name: "topLeft", label: "左上角", x: -1, y: -1 },
  { name: "topRight", label: "右上角", x: 1, y: -1 },
  { name: "bottomLeft", label: "左下角", x: -1, y: 1 },
  { name: "bottomRight", label: "右下角", x: 1, y: 1 },
] as const;
type ResizeCorner = typeof resizeCorners[number];
const resize = shallowRef<{
  node: GraphNode;
  corner: ResizeCorner;
  element: HTMLElement;
  pointerId: number;
  point: { x: number; y: number };
  position: { x: number; y: number };
  width: number;
  height: number;
  resolve: () => void;
}>();

async function editLabel() {
  labelDraft.value = props.data.label || "分组";
  editingLabel.value = true;
  await nextTick();
  labelInput.value?.select();
}

function saveLabel() {
  if (!editingLabel.value) return;
  const label = labelDraft.value.trim();
  if (label) flow.updateNodeData(props.id, { label });
  editingLabel.value = false;
}

function confirmLabel(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  saveLabel();
}

function startResize(event: PointerEvent, corner: ResizeCorner) {
  if (event.button !== 0 || resize.value) return;
  const node = flow.findNode(props.id);
  if (!node) return;
  const action = () => new Promise<void>(resolve => {
    const element = event.currentTarget as HTMLElement;
    resize.value = {
      node, corner, element, pointerId: event.pointerId,
      point: flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY }),
      position: { ...node.position }, width: node.dimensions.width, height: node.dimensions.height, resolve,
    };
    node.resizing = true;
    element.setPointerCapture(event.pointerId);
  });
  void (batchHistory ? batchHistory(action) : action()).catch(error => {
    finishResize();
    ElMessage.error(error instanceof Error ? error.message : "分组缩放失败");
  });
}

function moveResize(event: PointerEvent) {
  const state = resize.value;
  if (!state || event.pointerId !== state.pointerId) return;
  if (flow.findNode(props.id) !== state.node) return finishResize();
  const point = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  const width = Math.max(120, state.width + (point.x - state.point.x) * state.corner.x);
  const height = Math.max(80, state.height + (point.y - state.point.y) * state.corner.y);
  const position = {
    x: state.position.x + (state.corner.x < 0 ? state.width - width : 0),
    y: state.position.y + (state.corner.y < 0 ? state.height - height : 0),
  };
  const dx = position.x - state.node.position.x;
  const dy = position.y - state.node.position.y;
  for (const child of flow.getNodes.value) {
    if (child.parentNode === props.id) flow.updateNode(child.id, { position: { x: child.position.x - dx, y: child.position.y - dy } });
  }
  flow.updateNode(props.id, {
    position,
    style: { ...(typeof state.node.style === "object" ? state.node.style : {}), width: `${width}px`, height: `${height}px` },
  });
  state.node.dimensions = { width, height };
}

function finishResize(event?: PointerEvent) {
  const state = resize.value;
  if (!state || (event && event.pointerId !== state.pointerId)) return;
  resize.value = undefined;
  state.node.resizing = false;
  if (state.element.hasPointerCapture(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
  state.resolve();
}

onBeforeUnmount(() => finishResize());

watch(
  () => flow.getNodes.value.filter(node => node.parentNode === props.id),
  children => {
    // ACT: 拖动期间保持分组框不变，松手后由画布统一贴合内容。
    children.forEach(node => { node.expandParent = false; });
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.groupNode {
  .groupActions { position: absolute; top: 6px; right: 16px; display: flex; gap: 6px;
    button { padding: 4px 8px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-bg-color); color: var(--el-text-color-primary); cursor: pointer; }
  }
  .groupSummary { display: flex; flex-direction: column; gap: 6px; padding: 44px 16px 12px; font-size: 12px;
    img { width: 100%; height: 104px; object-fit: contain; }
    strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: color-mix(in srgb, var(--el-fill-color-light) 25%, transparent);

  &.selected {
    border-color: color-mix(in srgb, var(--el-color-primary) 50%, var(--el-border-color));
  }

  &:hover,
  &.selected,
  &.resizing {
    .resizeCorner { opacity: 1; }
  }

  .groupLabel,
  .groupLabelInput {
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    height: 22px;
    max-width: 100%;
    line-height: 20px;
  }

  .groupLabel {
    color: var(--el-text-color-secondary);
    font-size: 12px;
    user-select: none;
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .groupLabelInput {
    box-sizing: border-box;
    width: 100%;
    padding: 0 3px;
    border: 1px solid var(--el-color-primary);
    border-radius: var(--el-border-radius-small);
    outline: none;
    background: var(--el-bg-color);
    color: var(--el-text-color-primary);
    font-family: inherit;
    font-size: 12px;
  }

  .resizeCorner {
    position: absolute;
    width: 9px;
    height: 9px;
    padding: 0;
    border: 1px solid var(--el-color-primary);
    border-radius: 2px;
    background: var(--el-bg-color);
    opacity: 0;
    touch-action: none;

    &:focus-visible { opacity: 1; }
    &.topLeft { top: -5px; left: -5px; cursor: nwse-resize; }
    &.topRight { top: -5px; right: -5px; cursor: nesw-resize; }
    &.bottomLeft { bottom: -5px; left: -5px; cursor: nesw-resize; }
    &.bottomRight { bottom: -5px; right: -5px; cursor: nwse-resize; }
  }
}
</style>
