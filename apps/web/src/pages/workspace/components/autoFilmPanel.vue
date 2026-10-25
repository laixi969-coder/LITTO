<template>
  <el-dialog v-model="visible" title="一键自动成片" width="min(760px, calc(100vw - 24px))" top="6vh" :closeOnClickModal="false" :destroyOnClose="false">
    <div class="autoFilmPanel">
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
  </el-dialog>
</template>

<script setup lang="ts">
import { onScopeDispose, ref, watch } from "vue";
import axios from "axios";
import type { AutoFilmTask } from "@toonflow/server/autoFilm";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { registerApiLanguage } from "@/lib/i18n";

const props = defineProps<{ directory: string }>();
const visible = defineModel<boolean>({ default: false });
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
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let revision = 0;

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
  if (!open) { revision++; return; }
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
    if (!disposed && directory === props.directory) { task.value = data.data; script.value = ""; images.value = []; }
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
    if (!disposed && directory === props.directory) task.value = data.data;
  } catch (cause) { error.value = message(cause); }
  finally { busy.value = false; schedule(); }
}

onScopeDispose(() => { disposed = true; revision++; clearTimeout(timer); });
</script>

<style scoped lang="scss">
.autoFilmPanel {
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
</style>
