<template>
  <aside ref="panel" v-show="visible" class="autoFilmWindow" :class="{ collapsed, dragging: !!drag }" :style="panelStyle" aria-label="一键自动成片">
    <header class="panelHeader" tabindex="0" aria-label="移动成片窗口，可拖动或使用方向键" title="拖动标题栏移动，方向键微调位置" @pointerdown="startMove" @pointermove="moveWindow" @pointerup="stopMove" @pointercancel="stopMove" @lostpointercapture="stopMove" @keydown="moveWithKeyboard">
      <icon-grip-vertical class="dragIcon" :size="16" aria-hidden="true" />
      <div class="windowSummary">
        <strong>一键自动成片</strong>
        <span class="windowStatus" :class="{ needsAttention: !!error || task?.status === 'failed' || task?.status === 'interrupted' }" role="status" :aria-live="collapsed ? 'polite' : 'off'">{{ windowStatus }}</span>
      </div>
      <div class="panelActions">
        <el-button text circle :aria-label="collapsed ? '展开制作详情' : '最小化制作窗口'" :title="collapsed ? '展开制作详情' : '最小化，后台继续制作'" :aria-expanded="!collapsed" aria-controls="autoFilmContent" @click="collapsed = !collapsed">
          <icon-maximize v-if="collapsed" :size="18" aria-hidden="true" />
          <icon-minus v-else :size="18" aria-hidden="true" />
        </el-button>
        <el-button text circle aria-label="关闭一键自动成片面板" title="关闭面板，后台继续制作" @click="visible = false"><icon-x :size="18" aria-hidden="true" /></el-button>
      </div>
    </header>
    <div v-show="!collapsed" id="autoFilmContent" class="autoFilmPanel">
      <p class="intro">提供剧本和可选角色图，启动后由 AI 完成制作选择、生成、剪辑与成片导出。关闭此面板后任务继续运行。</p>
      <p v-if="error" class="errorMessage" role="alert">{{ error }} <el-button text @click="refresh">刷新状态</el-button></p>
      <section v-if="task" class="taskState" aria-label="自动制作进度">
        <div class="taskHeader"><strong>{{ statusLabels[task.status] }}</strong><span>媒体生成 {{ task.generationCount }} / 120 次</span></div>
        <p class="progressText" role="status" aria-live="polite">{{ task.progress }}</p>
        <p v-if="task.error" class="errorMessage">{{ task.error }}</p>
        <video v-if="task.status === 'completed' && task.output" class="filmPreview" :src="task.output.url" controls preload="metadata" aria-label="自动制作的成片" />
        <a v-if="task.status === 'completed' && task.output" :href="task.output.url" target="_blank" rel="noopener">打开成片</a>
        <details v-if="task.decisions.length" class="decisionList">
          <summary>AI 自动选择记录（{{ task.decisions.length }} 项，显示最近 30 项）</summary>
          <ol><li v-for="(decision, index) in task.decisions.slice(-30)" :key="index"><strong>{{ decision.title }}</strong><p>{{ decision.answer }}</p><p>{{ decision.reason }}</p></li></ol>
        </details>
        <div class="taskActions">
          <el-button v-if="task.status === 'running'" :loading="busy" @click="changeTask('stop')">停止制作</el-button>
          <el-button v-else-if="task.status !== 'completed'" :loading="busy" @click="changeTask('resume')">继续制作</el-button>
        </div>
      </section>
      <form v-if="task?.status !== 'running'" class="inputForm" @submit.prevent="start">
        <label for="autoFilmScript">故事 / 剧本</label>
        <el-input id="autoFilmScript" v-model="script" type="textarea" :rows="10" :maxlength="100000" :disabled="busy || loading" aria-label="故事或剧本正文" />
        <div class="inputActions">
          <el-button :disabled="busy || loading" @click="scriptInput?.click()">导入 TXT / MD 剧本</el-button>
          <el-button :disabled="busy || loading" @click="imageInput?.click()">添加角色图（可选）</el-button>
        </div>
        <input ref="scriptInput" class="fileInput" type="file" accept=".txt,.md" @change="loadScript" />
        <input ref="imageInput" class="fileInput" type="file" multiple accept="image/png,image/jpeg,image/webp" @change="addImages" />
        <ul v-if="images.length" class="referenceList"><li v-for="(file, index) in images" :key="index"><span>{{ file.name }}</span><el-button text :disabled="busy" :aria-label="`移除角色图 ${file.name}`" @click="images.splice(index, 1)">移除</el-button></li></ul>
        <p class="limits">按已配置模型计费。AI 自动决定全部制作选项；每个目标最多尝试 3 次，每个任务最多 120 次媒体生成，每次运行最长 6 小时。失败后保留素材，续跑沿用剩余额度。</p>
        <el-button type="primary" nativeType="submit" :disabled="!script.trim() || loading" :loading="busy">{{ task ? '启动新的自动成片' : '启动自动成片' }}</el-button>
      </form>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from "vue";
import { IconGripVertical, IconMaximize, IconMinus, IconX } from "@tabler/icons-vue";
import axios from "axios";
import type { AutoFilmTask } from "@toonflow/server/autoFilm";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { registerApiLanguage } from "@/lib/i18n";

const props = defineProps<{ directory: string }>();
const visible = defineModel<boolean>({ default: false });
const collapsed = ref(false);
const panel = ref<HTMLElement>();
const viewport = reactive({ width: window.innerWidth, height: window.innerHeight });
const windowHeight = ref(560);
const expandedPosition = ref<{ left: number; top: number }>();
const minimizedPosition = ref<{ left: number; top: number }>();
const drag = shallowRef<{ element: HTMLElement; pointerId: number; x: number; y: number; left: number; top: number }>();
const windowWidth = computed(() => Math.min(collapsed.value ? 320 : 440, Math.max(0, viewport.width - 32)));
const maxHeight = computed(() => Math.max(0, Math.min(560, viewport.height - 32)));
const windowPosition = computed(() => {
  const position = collapsed.value ? minimizedPosition.value : expandedPosition.value;
  return boundPosition(position?.left ?? viewport.width - windowWidth.value - 16, position?.top ?? (collapsed.value ? viewport.height - windowHeight.value - 16 : 80));
});
const panelStyle = computed(() => ({ left: `${windowPosition.value.left}px`, top: `${windowPosition.value.top}px`, width: `${windowWidth.value}px`, maxHeight: `${maxHeight.value}px` }));
const client = axios.create({ baseURL: "/api/autoFilm", headers: { "x-toonflow-workspace": "1" } });
registerApiLanguage(client);
const script = ref("");
const images = ref<File[]>([]);
const scriptInput = ref<HTMLInputElement>();
const imageInput = ref<HTMLInputElement>();
const task = ref<AutoFilmTask | null>(null);
const error = ref("");
const busy = ref(false);
const loading = ref(false);
const statusLabels = { running: "正在自动制作", completed: "成片已完成", failed: "制作中断", stopped: "制作已停止", interrupted: "等待恢复制作" };
const windowStatus = computed(() => error.value ? "需要处理，请展开查看" : loading.value ? "正在读取制作状态" : task.value ? `${statusLabels[task.value.status]} · ${task.value.generationCount}/120 次生成` : "等待开始制作");
const resizeObserver = new ResizeObserver(([entry]) => { if (entry && visible.value) windowHeight.value = entry.target.getBoundingClientRect().height; });
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let revision = 0;

function boundPosition(left: number, top: number) {
  return { left: Math.max(16, Math.min(left, viewport.width - windowWidth.value - 16)), top: Math.max(16, Math.min(top, viewport.height - Math.min(windowHeight.value, maxHeight.value) - 16)) };
}

function placeWindow(left: number, top: number) {
  const position = collapsed.value ? minimizedPosition : expandedPosition;
  position.value = boundPosition(left, top);
}

function startMove(event: PointerEvent) {
  if (event.button !== 0 || drag.value || (event.target as HTMLElement).closest("button")) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  drag.value = { element, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ...windowPosition.value };
}

function moveWindow(event: PointerEvent) {
  const current = drag.value;
  if (current?.pointerId === event.pointerId) placeWindow(current.left + event.clientX - current.x, current.top + event.clientY - current.y);
}

function stopMove() {
  const current = drag.value;
  drag.value = undefined;
  if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
}

function moveWithKeyboard(event: KeyboardEvent) {
  if (event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 64 : 16;
  placeWindow(windowPosition.value.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), windowPosition.value.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
}

function resizeViewport() {
  stopMove();
  viewport.width = window.innerWidth;
  viewport.height = window.innerHeight;
}

watch(panel, element => { resizeObserver.disconnect(); if (element) resizeObserver.observe(element); });
watch(collapsed, stopMove);
window.addEventListener("resize", resizeViewport);

function message(cause: unknown) {
  return axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "操作失败";
}

function schedule() {
  clearTimeout(timer);
  if (!disposed && visible.value && task.value?.status === "running") timer = setTimeout(refresh, 5000);
}

async function refresh() {
  const current = ++revision;
  const directory = props.directory;
  try {
    const { data } = await client.get<{ data: AutoFilmTask | null }>("/get", { params: { directory } });
    if (disposed || current !== revision || directory !== props.directory) return;
    task.value = data.data;
    error.value = "";
  } catch (cause) {
    if (!disposed && current === revision) error.value = message(cause);
  } finally { schedule(); }
}

watch(visible, async open => {
  clearTimeout(timer);
  if (!open) { revision++; stopMove(); return; }
  collapsed.value = false;
  loading.value = true;
  await refresh();
  loading.value = false;
}, { immediate: true });

async function loadScript(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 400000) throw new Error("剧本须为不超过400KB的TXT或MD文件");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    if (content.length > 100000) throw new Error("剧本最多支持100000个字符");
    script.value = content;
    error.value = "";
  } catch (cause) { error.value = message(cause); }
}

function addImages(event: Event) {
  const input = event.target as HTMLInputElement, selected = Array.from(input.files ?? []);
  input.value = "";
  if (images.value.length + selected.length > 20) { error.value = "最多提供20张角色图"; return; }
  if (selected.some(file => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024)) { error.value = "角色图须为不超过20MB的PNG、JPEG或WebP图片"; return; }
  images.value.push(...selected);
  error.value = "";
}

async function start() {
  if (busy.value || loading.value || !script.value.trim()) return;
  busy.value = true;
  error.value = "";
  const directory = props.directory, content = script.value, selected = [...images.value];
  try {
    const files = useWorkspaceFiles(directory);
    const references: { name: string; path: string }[] = [];
    if (selected.length) {
      const folder = `autoFilmInputs${crypto.randomUUID().replaceAll("-", "")}`;
      await files.mkdir(folder);
      for (const [index, file] of selected.entries()) {
        const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
        const path = `${folder}/reference${index}.${extension}`;
        await files.write(path, file, true);
        references.push({ name: file.name.slice(0, 200), path });
      }
    }
    const { data } = await client.post<{ data: AutoFilmTask }>("/start", { directory, script: content, references });
    if (!disposed && directory === props.directory) { task.value = data.data; script.value = ""; images.value = []; collapsed.value = true; }
  } catch (cause) {
    await refresh();
    error.value = message(cause);
  } finally { busy.value = false; schedule(); }
}

async function changeTask(operation: "stop" | "resume") {
  if (busy.value || !task.value) return;
  busy.value = true;
  error.value = "";
  revision++;
  clearTimeout(timer);
  const directory = props.directory, taskId = task.value.id;
  try {
    const { data } = await client.post<{ data: AutoFilmTask | null }>(`/${operation}`, { directory, taskId });
    if (!disposed && directory === props.directory) {
      task.value = data.data;
      if (operation === "resume" && data.data?.status === "running") collapsed.value = true;
    }
  } catch (cause) { error.value = message(cause); }
  finally { busy.value = false; schedule(); }
}

onScopeDispose(() => { disposed = true; revision++; clearTimeout(timer); stopMove(); resizeObserver.disconnect(); window.removeEventListener("resize", resizeViewport); });
</script>

<style scoped lang="scss">
.autoFilmWindow {
  position: fixed;
  z-index: 1002;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-light);
  &.dragging { user-select: none; .panelHeader { cursor: grabbing; } }
  .panelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    gap: 8px;
    padding: 8px;
    cursor: grab;
    touch-action: none;
    border-radius: inherit;
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
    .dragIcon { flex-shrink: 0; color: var(--el-text-color-secondary); }
    .windowSummary {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 4px;
      strong { font-size: 14px; }
      .windowStatus { color: var(--el-text-color-regular); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; &.needsAttention { color: var(--el-color-danger); } }
    }
    .panelActions { display: flex; flex-shrink: 0; .el-button { width: 36px; height: 36px; margin: 0; } }
  }
  .autoFilmPanel {
    min-height: 0;
    padding: 0 16px 16px;
    overflow: auto;
    display: grid;
    gap: 20px;
    .intro, .limits { margin: 0; color: var(--el-text-color-secondary); line-height: 1.7; }
    .errorMessage { color: var(--el-color-danger); white-space: pre-wrap; overflow-wrap: anywhere; }
    .taskState {
      padding: 16px;
      border: 1px solid var(--el-border-color);
      border-radius: 12px;
      .taskHeader { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
      .progressText { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }
      .filmPreview { width: 100%; max-height: 420px; background: #111; }
      .decisionList { margin-top: 16px; summary { cursor: pointer; } ol { max-height: 260px; overflow: auto; padding-left: 24px; li { margin-block: 12px; p { margin-block: 4px; white-space: pre-wrap; overflow-wrap: anywhere; } } } }
      .taskActions { margin-top: 12px; }
    }
    .inputForm {
      display: grid;
      gap: 12px;
      .inputActions { display: flex; flex-wrap: wrap; gap: 8px; .el-button { margin: 0; } }
      .fileInput { display: none; }
      .referenceList { padding: 0; list-style: none; li { display: flex; align-items: center; justify-content: space-between; gap: 12px; span { overflow-wrap: anywhere; } } }
      .limits { font-size: 12px; }
    }
  }
  @media (pointer: coarse) { .panelHeader .panelActions .el-button { width: 44px; height: 44px; } }
}
</style>
