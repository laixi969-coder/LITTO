<template>
  <section class="productionBatch" :aria-busy="working">
    <h3>批量制作与结果核对</h3>
    <p>使用上方模型设置，逐镜保留已保存的规格、参考与视频时长。系列变体仅改变随机种子；实际差异取决于模型是否支持种子控制。</p>
    <p v-if="error" class="attention" role="alert">{{ error }}</p>
    <fieldset :disabled="working || disabled">
      <div class="batchChoices">
        <label v-for="shot in shots" :key="shot.id"><input v-model="selectedIds" type="checkbox" :value="shot.id" />{{ shot.ord + 1 }} · {{ shot.title }}</label>
      </div>
      <label>每镜变体数<input v-model.number="count" type="number" min="1" max="8" /></label>
      <button type="button" @click="run(compile)">预览选定镜头</button>
      <div v-if="plan.length" class="batchPreview">
        <p>选定 {{ plan.length }} 个镜头，共 {{ total }} 次提交</p>
        <article v-for="item in plan" :key="item.shotId">
          <strong>{{ item.title }} · {{ plannedKind === 'video' ? item.request.duration + ' 秒' : '关键帧' }} · {{ plannedCount }} 个变体</strong>
          <label v-if="plannedKind === 'image' && item.assetIds?.length">关联出场资产（可选）<select v-model="item.assetId" @change="costAccepted = false"><option value="">仅回到镜头候选</option><option v-for="asset in assets.filter(asset => item.assetIds?.includes(asset.id))" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select></label>
          <p v-if="item.error" class="attention">无法提交：{{ item.error }}</p>
          <template v-else>
            <p>{{ item.preview.request.providerId }} / {{ item.preview.request.modelId }} · {{ item.preview.request.ratio }} · {{ item.preview.request.size || item.preview.request.resolution }}</p>
            <p v-for="warning in item.preview.compiled.warnings" :key="warning" class="attention">{{ warning }}</p>
            <p v-for="change in item.preview.compiled.degradations" :key="change.role" class="attention">{{ change.role }}：{{ change.strategy }}</p>
            <details><summary>实际提示词、约束与参考</summary><pre>{{ item.preview.compiled.prompt }}</pre>
              <ul><li v-for="(input, index) in item.preview.compiled.inputs" :key="index">{{ input.role }} · {{ input.mediaId || input.referenceId }} · {{ input.sent ? '实际发送' : '未发送' }} · {{ input.lockLevel || '' }}</li></ul>
            </details>
          </template>
        </article>
        <label><input v-model="costAccepted" type="checkbox" />确认以上 {{ total }} 次提交。供应商费用未知，按接入模型实际计费。</label>
        <button type="button" :disabled="!costAccepted || plan.some(item => item.error)" @click="run(submit)">按预览提交 {{ total }} 次生成</button>
      </div>
      <button type="button" @click="run(loadHistory)">刷新批量记录</button>
      <label v-if="history.length">批量记录<select v-model="recordId" @change="run(refreshResults)"><option v-for="entry in history" :key="entry.id" :value="entry.id">{{ entry.createdAt }} · {{ entry.rows.length }} 次 · {{ entry.kind === 'image' ? '关键帧' : '视频' }}</option></select></label>
      <template v-if="record">
        <p>{{ counts }}。输出自动进入对应镜头的候选版本；失败与中断项不会自动重试。</p>
        <div class="resultGrid"><article v-for="row in record.rows" :key="row.requestId">
          <strong>{{ row.title }} · 变体 {{ row.variant }}</strong><span>{{ rowState(row) }}</span>
          <small>种子 {{ row.seed }}</small>
          <p v-if="jobFor(row)?.error || (!jobFor(row) && row.error)" class="attention">{{ jobFor(row)?.error || row.error }}</p>
          <template v-for="mediaId in jobFor(row)?.outputs ?? []" :key="mediaId">
            <img v-if="media[mediaId]?.mime.startsWith('image/')" :src="'/cloud' + media[mediaId].url" alt="生成候选" loading="lazy" />
            <video v-else-if="media[mediaId]?.mime.startsWith('video/')" :src="'/cloud' + media[mediaId].url" controls preload="metadata" />
          </template>
          <button type="button" @click="emit('review', row.shotId)">查看镜头版本与采用</button>
          <button v-if="['QUEUED', 'RUNNING'].includes(jobFor(row)?.status)" type="button" @click="run(() => cancel(row))">停止此任务</button>
        </article></div>
      </template>
    </fieldset>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, toRaw, watch } from "vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";

type BatchRow = { requestId: string; shotId: string; title: string; variant: number; seed: number; state: "ready" | "submitting" | "submitted" | "failed"; jobId?: string; error?: string };
type BatchRecord = { productionBatch: 1; id: string; projectId: string; createdAt: string; kind: "image" | "video"; rows: BatchRow[] };
type PlanItem = { shotId: string; title: string; request: Record<string, any>; assetIds?: string[]; assetId?: string; preview?: any; error?: string };
const props = defineProps<{ directory: string; projectId: string; shots: any[]; assets: any[]; active: boolean; disabled: boolean; settingsKey: string; prepare: () => Promise<{ kind: "image" | "video"; request: Record<string, any> }>; request: (path: string, method?: string, body?: unknown) => Promise<any> }>();
const emit = defineEmits<{ working: [value: boolean]; review: [shotId: string] }>();
// 固定工作目录；提交与保存跨 await 时不读取当前项目。
const files = useWorkspaceFiles(props.directory);
const controller = new AbortController();
const selectedIds = ref<string[]>([]), count = ref(2), working = ref(false), error = ref(""), costAccepted = ref(false);
const plan = ref<PlanItem[]>([]), plannedCount = ref(0), plannedKind = ref<"image" | "video">("image");
const history = ref<BatchRecord[]>([]), recordId = ref(""), jobMap = ref<Record<string, any>>({}), media = ref<Record<string, any>>({});
const record = computed(() => history.value.find(item => item.id === recordId.value));
const total = computed(() => plan.value.length * plannedCount.value);
let refreshing = false;
const jobFor = (row: BatchRow) => jobMap.value[row.jobId || row.requestId];
const rowState = (row: BatchRow) => {
  const job = jobFor(row), status = job?.status;
  if (status === "SUCCEEDED" && !job.outputs?.length) return "完成但缺少输出";
  return status ? ({ QUEUED: "排队中", RUNNING: "生成中", SUCCEEDED: "已回流", FAILED: "失败", CANCELLED: "已停止" }[status as string] ?? status)
    : ({ ready: "未提交", submitting: "提交回执待核对", submitted: "任务状态待读取", failed: "提交失败" }[row.state]);
};
const counts = computed(() => {
  const result = new Map<string, number>();
  for (const row of record.value?.rows ?? []) result.set(rowState(row), (result.get(rowState(row)) ?? 0) + 1);
  return [...result].map(([state, number]) => `${number} 项${state}`).join(" · ");
});
watch([selectedIds, count, () => props.settingsKey], () => { plan.value = []; costAccepted.value = false; }, { deep: true });
watch(() => props.shots.map(shot => shot.id), ids => {
  const selected = selectedIds.value.filter(id => ids.includes(id));
  if (selected.length !== selectedIds.value.length) selectedIds.value = selected;
});
async function run(action: () => Promise<void>) {
  if (working.value || props.disabled) return;
  working.value = true; emit("working", true); error.value = "";
  try { await action(); }
  catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { working.value = false; emit("working", false); }
}
async function production(shotId: string, kind: string, request: Record<string, any>, submission?: { requestId: string; fingerprint: string; candidateBatchId: string }) {
  controller.signal.throwIfAborted();
  const response = await fetch("/api/ai/media/production", { method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]), headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory: props.directory, shotId, kind, request, ...submission }) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message || "镜头生成请求失败"), { status: response.status });
  return result.data;
}
async function compile() {
  plan.value = []; costAccepted.value = false;
  const selected = props.shots.filter(shot => selectedIds.value.includes(shot.id));
  if (!selected.length || !Number.isInteger(count.value) || count.value < 1 || count.value > 8 || selected.length * count.value > 32) throw new Error("请选择镜头，每镜 1–8 个变体，每批最多 32 次提交");
  const options = await props.prepare();
  controller.signal.throwIfAborted();
  plannedKind.value = options.kind; plannedCount.value = count.value;
  const items: PlanItem[] = [];
  for (const shot of selected) {
    const item: PlanItem = { shotId: shot.id, title: `${shot.ord + 1} · ${shot.title}`, request: { ...options.request } };
    try {
      const current = await props.request(`/shots/${shot.id}`);
      if (current.projectId !== props.projectId) throw new Error("镜头不属于当前项目");
      item.assetIds = current.assetIds; item.assetId = "";
      if (options.kind === "video") item.request.duration = current.generationDuration ?? current.duration;
      item.preview = await production(item.shotId, options.kind, item.request);
    }
    catch (cause) { controller.signal.throwIfAborted(); item.error = cause instanceof Error ? cause.message : String(cause); }
    items.push(item);
  }
  plan.value = items;
}
async function submit() {
  if (!costAccepted.value || !plan.value.length || plan.value.some(item => item.error)) return;
  const items = structuredClone(toRaw(plan.value)), kind = plannedKind.value, copies = plannedCount.value;
  costAccepted.value = false;
  // 提交前全量重验：只要有一个镜头规格变化，本批尚未产生任何付费任务。
  for (const item of items) {
    const current = await production(item.shotId, kind, item.request);
    if (current.fingerprint !== item.preview.fingerprint) { plan.value = []; throw new Error(`${item.title} 的规格或参考已变化，请重新预览整批`); }
  }
  const entry = reactive<BatchRecord>({ productionBatch: 1, id: crypto.randomUUID().replaceAll("-", ""), projectId: props.projectId, kind, createdAt: new Date().toISOString(), rows: items.flatMap(item => Array.from({ length: copies }, (_, index) => ({ requestId: crypto.randomUUID(), shotId: item.shotId, title: item.title, variant: index + 1, seed: crypto.getRandomValues(new Uint32Array(1))[0]! % 2147483647, state: "ready" as const }))) });
  const path = `productionBatch${entry.id}.json`;
  await files.writeJson(path, entry, true);
  history.value.unshift(entry); recordId.value = entry.id;
  plan.value = [];
  const batches = new Map<string, string>();
  for (const row of entry.rows) {
    controller.signal.throwIfAborted();
    const item = items.find(item => item.shotId === row.shotId)!;
    let batchId = batches.get(row.shotId);
    if (!batchId) {
      const batch = await props.request(`/projects/${props.projectId}/candidateBatches`, "POST", { kind, shotId: row.shotId, promptFingerprint: item.preview.fingerprint, ...(item.assetId ? { assetId: item.assetId } : {}) });
      batchId = batch.id as string; batches.set(row.shotId, batchId);
    }
    row.state = "submitting";
    await files.writeJson(path, entry);
    try {
      const result = await production(row.shotId, kind, { ...item.request, seed: row.seed }, { requestId: row.requestId, fingerprint: item.preview.fingerprint, candidateBatchId: batchId });
      row.jobId = result.jobId; row.state = "submitted";
    } catch (cause) {
      const status = cause instanceof Error ? Reflect.get(cause, "status") : undefined;
      if (typeof status === "number" && status >= 400 && status < 500) row.state = "failed";
      row.error = `${row.state === "failed" ? "提交被拒绝" : "提交未确认"}：${cause instanceof Error ? cause.message : String(cause)}。请刷新核对，不会自动重发。`;
      await files.writeJson(path, entry);
      throw cause;
    }
    await files.writeJson(path, entry);
    window.dispatchEvent(new Event("milimiliProductionUpdated"));
  }
  await refreshResults();
}
async function loadHistory() {
  const { entries } = await files.list();
  const records: BatchRecord[] = [];
  for (const file of entries.filter(entry => entry.type === "file" && /^productionBatch[a-f0-9]{32}\.json$/.test(entry.name))) {
    const value = await files.readJson<any>(file.path);
    if (!value || value.productionBatch !== 1 || value.projectId !== props.projectId || file.name !== `productionBatch${value.id}.json` || !["image", "video"].includes(value.kind) || typeof value.createdAt !== "string" || !Array.isArray(value.rows) || value.rows.length > 32 || value.rows.some((row: any) => !row || ["requestId", "shotId", "title"].some(key => typeof row[key] !== "string") || !Number.isInteger(row.variant) || !Number.isInteger(row.seed) || !["ready", "submitting", "submitted", "failed"].includes(row.state) || (row.jobId !== undefined && typeof row.jobId !== "string") || (row.error !== undefined && typeof row.error !== "string"))) throw new Error(`批量记录格式无效：${file.name}`);
    records.push(value);
  }
  history.value = records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!records.some(item => item.id === recordId.value)) recordId.value = history.value[0]?.id ?? "";
  await refreshResults();
}
async function refreshResults() {
  const entry = record.value;
  if (!entry || refreshing) return;
  refreshing = true;
  try {
    for (const row of entry.rows) {
      controller.signal.throwIfAborted();
      const job = row.jobId ? await props.request(`/generations/${encodeURIComponent(row.jobId)}`) : row.state === "submitting" ? await props.request(`/projects/${props.projectId}/generationReceipt/${encodeURIComponent(row.requestId)}`) : null;
      if (!job) continue;
      if (job.projectId !== props.projectId || job.targetType !== "shot" || job.targetId !== row.shotId || job.kind !== entry.kind) throw new Error("批量记录与任务归属不一致，请核对原记录");
      jobMap.value[row.jobId || row.requestId] = job;
      for (const id of job.outputs ?? []) if (!media.value[id]) media.value[id] = await props.request(`/media/${encodeURIComponent(id)}`);
    }
  } finally { refreshing = false; }
}
async function cancel(row: BatchRow) {
  const job = jobFor(row);
  if (!job) return;
  await props.request(`/generations/${job.id}/cancel`, "POST");
  await refreshResults();
}
watch([() => props.active, () => props.disabled], ([active, disabled]) => { if (active && !disabled && !working.value) void run(loadHistory); }, { immediate: true });
const timer = setInterval(() => {
  if (props.active && !working.value && record.value?.rows.some(row => ["QUEUED", "RUNNING"].includes(jobFor(row)?.status) || (["submitting", "submitted"].includes(row.state) && !jobFor(row)))) void refreshResults().catch(cause => { if (!controller.signal.aborted) error.value = cause.message; });
}, 3000);
onScopeDispose(() => { controller.abort(); clearInterval(timer); });
</script>

<style scoped lang="scss">
.productionBatch {
  fieldset { border: 0; padding: 0; min-width: 0; }
  button, select, input { font: inherit; margin: 4px; }
  button, select, input[type="number"] { min-height: 40px; padding: 8px 12px; color: var(--studioInk); background: var(--studioSurface); border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); }
  button { cursor: pointer; &:disabled { opacity: 0.5; cursor: not-allowed; } }
  select { max-width: 100%; }
  input[type="number"] { width: 64px; }
  p { line-height: 1.6; }
  .attention { color: var(--el-color-warning); }
  .batchChoices { display: flex; flex-wrap: wrap; gap: 8px; }
  .batchPreview article { margin: 12px 0; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px;
    pre { white-space: pre-wrap; max-height: 240px; overflow: auto; }
  }
  .resultGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;
    article { display: flex; flex-direction: column; gap: 6px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; }
    img, video { width: 100%; max-height: 180px; object-fit: contain; }
  }
}
</style>
