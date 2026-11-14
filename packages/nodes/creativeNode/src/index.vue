<template>
  <nodeSkeleton v-bind="nodeProps" style="width: 460px" :topVisible="node.selected" :downloadUrl="previewUrl" :downloadName="previewFile?.url.split('/').at(-1)">
    <div class="creativeContent nodrag nopan nowheel" @pointerdown.stop @keydown.stop @wheel.stop>
      <img v-if="previewFile?.mimeType.startsWith('image/') && previewUrl" class="mediaPreview" :src="previewUrl" alt="处理结果" />
      <video v-else-if="previewFile?.mimeType.startsWith('video/') && previewUrl" class="mediaPreview" :src="previewUrl" controls playsinline />
      <audio v-else-if="previewFile?.mimeType.startsWith('audio/') && previewUrl" :src="previewUrl" controls />
      <modelView v-if="modelContent && data.operation === 'mesh'" ref="modelViewer" :content="modelContent" :saveSnapshot="saveSnapshot" />
      <div class="formRow">
        <label>工具<select v-model="data.operation" :disabled="busy" @change="changeOperation().catch(report)"><option value="runningHub">RH 动态工作流</option><option value="mesh">生成式 3D</option><option value="upscale">专用超分</option><option value="texture">质感增强</option></select></label>
      </div>
      <div class="formRow">
        <label>服务连接<select v-model="data.providerId" :disabled="busy" @change="resetDescription"><option value="">请选择连接</option><option v-for="provider in availableProviders" :key="provider.id" :value="provider.id">{{ provider.label }}{{ provider.configured ? '' : '（未配置）' }}</option></select></label>
        <button type="button" :disabled="busy || !data.providerId" @click="openConfig">配置</button>
      </div>
      <template v-if="data.operation === 'runningHub'">
        <div class="formRow">
          <label>类型<select v-model="data.mode" :disabled="busy" @change="resetDescription"><option value="app">RH 应用</option><option value="workflow">ComfyUI 工作流</option></select></label>
          <label>ID<input v-model.trim="data.workflowId" :disabled="busy" autocomplete="off" @input="resetDescription" /></label>
        </div>
        <button type="button" :disabled="busy || !data.workflowId || !data.providerId" @click="describe().catch(report)">{{ describing ? '读取中…' : '获取动态参数' }}</button>
      </template>
      <template v-else>
        <label class="fieldLabel">输入图片<select v-model="data.imageKey" :disabled="busy"><option value="">请选择图片</option><option v-for="reference in imageReferences" :key="reference.key" :value="reference.key">{{ reference.label }}</option></select></label>
        <input type="file" accept="image/*" aria-label="上传处理图片" :disabled="busy" @change="uploadInput" />
        <button v-if="!data.descriptionKey" type="button" :disabled="busy || !data.providerId" @click="describe().catch(report)">读取工具参数</button>
      </template>
      <fieldset :disabled="busy">
        <fieldset v-for="field in data.fields" :key="fieldKey(field)" class="dynamicField" :disabled="fieldDisabled(field)">
          <label :for="`${id}${fieldKey(field)}`">{{ field.label }}{{ field.required ? ' *' : '' }}</label>
          <template v-if="['image', 'video', 'audio'].includes(field.type)">
            <select :id="`${id}${fieldKey(field)}`" :value="mediaSelection(field)" @change="setMediaField(field, ($event.target as HTMLSelectElement).value)"><option value="">{{ mediaPath(field) || '选择已连接素材' }}</option><option v-for="reference in matchingReferences(field.type)" :key="reference.key" :value="reference.key">{{ reference.label }}</option></select>
            <span v-if="mediaPath(field)" class="filePath">{{ mediaPath(field) }}</span>
            <input type="file" :accept="`${field.type}/*`" :aria-label="`上传${field.label}`" @change="uploadField($event, field)" />
          </template>
          <select v-else-if="field.options?.length" :id="`${id}${fieldKey(field)}`" v-model="data.values[fieldKey(field)]"><option v-for="option in field.options" :key="option" :value="option">{{ option }}</option></select>
          <input v-else-if="field.type === 'boolean'" :id="`${id}${fieldKey(field)}`" v-model="data.values[fieldKey(field)]" type="checkbox" />
          <input v-else-if="field.type === 'number'" :id="`${id}${fieldKey(field)}`" :value="data.values[fieldKey(field)]" type="number" :min="field.min" :max="field.max" :step="field.step ?? 'any'" @input="setNumber(field, $event)" />
          <textarea v-else :id="`${id}${fieldKey(field)}`" :value="String(data.values[fieldKey(field)] ?? '')" rows="2" @input="data.values[fieldKey(field)] = ($event.target as HTMLTextAreaElement).value" />
          <button v-if="field.type === 'string' && textReference" type="button" @click="data.values[fieldKey(field)] = textReference">采用连接文本</button>
        </fieldset>
      </fieldset>
      <p v-if="data.task" class="taskStatus" role="status">{{ statusLabels[data.task.status] }}<span v-if="data.task.handle?.id"> · {{ data.task.handle.id }}</span></p>
      <p v-if="data.task?.error || localError" class="errorText" role="alert">{{ localError || data.task?.error }}</p>
      <div v-if="data.task?.status === 'uncertain'" class="formRow">
        <label>供应商控制台的原任务号<input v-model.trim="originalRemoteId" :disabled="busy" autocomplete="off" /></label>
        <button type="button" :disabled="busy || !originalRemoteId" @click="recover(originalRemoteId).catch(report)">绑定并恢复</button>
      </div>
      <div class="actions">
        <button type="button" :disabled="busy || pending || !data.providerId || !data.descriptionKey" @click="start().catch(report)">开始{{ data.operation === 'runningHub' ? '运行' : '处理' }}</button>
        <button v-if="pending" type="button" :disabled="cancelling" @click="cancel().catch(report)">{{ cancelling ? '停止中…' : '停止任务' }}</button>
        <button v-if="data.request" type="button" :disabled="busy" @click="resume().catch(report)">查询原任务</button>
      </div>
      <ul v-if="data.task?.files?.length" class="resultFiles"><li v-for="file in data.task.files" :key="file.path"><span>{{ file.name || file.path.split('/').at(-1) }}</span><button type="button" :disabled="busy" @click="selectOutput(file).catch(report)">{{ isModel(file) ? '查看 3D' : '设为输出' }}</button><button type="button" @click="download(file).catch(report)">下载</button></li></ul>
      <p v-if="data.operation === 'mesh'" class="hintText">GLB 保留几何与材质；旋转模型后可将当前机位截图输出到下游。</p>
      <p v-if="data.operation === 'mesh' && data.values[JSON.stringify(['options', 'texture'])] === false" class="hintText">已关闭纹理：仅生成几何，PBR 关闭，纹理质量、种子与对齐不参与请求。</p>
      <p v-if="data.operation === 'texture'" class="hintText">专用生成式质感处理可能改变细节；1 倍输出保留原图尺寸。</p>
    </div>
  </nodeSkeleton>
  <el-dialog v-model="configVisible" title="工具服务连接" width="440px" appendToBody :closeOnClickModal="false" @closed="apiKey = ''">
    <form class="connectionForm" @submit.prevent="saveConfig().catch(report)">
      <label>API Key<input v-model="apiKey" type="password" autocomplete="new-password" required aria-label="服务 API Key" /></label>
      <label v-if="data.operation === 'runningHub'">服务地址<select v-model="baseUrl"><option value="https://www.runninghub.ai">海外 .ai</option><option value="https://www.runninghub.cn">国内 .cn</option></select></label>
      <button type="submit" :disabled="savingConfig || !apiKey.trim()">{{ savingConfig ? '保存中…' : '保存连接' }}</button>
    </form>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from "vue";
import { IconWand } from "@tabler/icons-vue";
import { ElDialog } from "element-plus";
import { nodeSkeleton, nodeTools, showNodeError, useNode, useNodeGeneration, useNodeReferences, z, type NodeHandle, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import modelView from "./modelView.vue";

type Operation = "runningHub" | "mesh" | "upscale" | "texture";
type Media = { path: string; mimeType: string };
type Field = { nodeId: string; fieldName: string; label: string; type: "string" | "number" | "boolean" | "image" | "video" | "audio"; value?: unknown; options?: string[]; required?: boolean; min?: number; max?: number; step?: number };
type TaskFile = Media & { name?: string };
type Task = { requestId: string; status: "submitting" | "pending" | "completed" | "failed" | "cancelled" | "uncertain"; handle?: { id: string }; files?: TaskFile[]; error?: string };
type Provider = { id: string; label: string; operations: string[]; configured: boolean };
type State = { operation: Operation; providerId: string; mode: "app" | "workflow"; workflowId: string; fields: Field[]; values: Record<string, unknown>; descriptionKey?: string; imageKey: string; uploadedImage?: Media; request?: { directory: string; requestId: string }; task?: Task; modelPath?: string; previewType?: string };
defineOptions({
  inheritAttrs: false,
  icon: IconWand,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "素材与文本输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片 / 3D 机位输出" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
    { id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" },
    { id: "model", type: "source", dataType: "STRING", label: "模型工作区路径" },
  ] satisfies NodeHandle[],
});
const { id, node, nodeProps, nodeEvent, outputs, files } = useNode({ label: "工作流 · 3D · 画质" });
const data = computed(() => node.data as typeof node.data & State);
for (const [key, value] of Object.entries({ operation: "runningHub", providerId: "runningHub", mode: "app", workflowId: "", fields: [], values: {}, imageKey: "" })) if ((node.data as Record<string, unknown>)[key] === undefined) (node.data as Record<string, unknown>)[key] = value;
const providers = ref<Provider[]>([]);
const describing = ref(false);
const preparing = ref(false);
const uploading = ref(false);
const cancelling = ref(false);
const configVisible = ref(false);
const savingConfig = ref(false);
const apiKey = ref("");
const baseUrl = ref("https://www.runninghub.ai");
const localError = ref("");
const originalRemoteId = ref("");
const modelContent = shallowRef<ArrayBuffer>();
const modelViewer = ref<InstanceType<typeof modelView>>();
const { refList } = useNodeReferences();
let disposed = false;
let controller: AbortController | undefined;
let polling: Promise<void> | undefined;
const generationState = useNodeGeneration(outputs, () => { void cancel().catch(report); });
const { generating } = generationState;
const pending = computed(() => !!data.value.request && ["submitting", "pending", "uncertain"].includes(data.value.task?.status ?? "submitting"));
const busy = computed(() => generating.value || preparing.value || describing.value || uploading.value || savingConfig.value);
const availableProviders = computed(() => providers.value.filter(provider => provider.operations.includes(data.value.operation)));
const statusLabels = { submitting: "正在提交", pending: "远端处理中", completed: "已保存到工作区", failed: "任务失败", cancelled: "已停止", uncertain: "提交状态待确认，请查询原任务" };
const previewFile = computed<NodeMediaValue | undefined>(() => {
  for (const key of [data.value.previewType, "image", "video", "audio"].filter((key): key is string => !!key)) {
    const output = outputs.value[key];
    if (output && ["IMAGE", "VIDEO", "AUDIO"].includes(output.dataType)) return output.value as NodeMediaValue;
  }
});
const previewUrl = files.useFileUrl(previewFile, report);
const textReference = computed(() => refList.value.find(item => item.dataType === "STRING" && typeof item.value === "string")?.value as string | undefined);
const mediaReferences = computed(() => refList.value.flatMap((item, index) => {
  if (!["IMAGE", "VIDEO", "AUDIO"].includes(String(item.dataType)) || !item.value || typeof item.value !== "object" || !("url" in item.value)) return [];
  return [{ key: JSON.stringify([item.source, item.sourceHandle]), type: String(item.dataType).toLowerCase(), label: `参考 ${index + 1} · ${item.value.url.split('/').at(-1)}`, media: { path: item.value.url, mimeType: item.value.mimeType } }];
}));
const imageReferences = computed(() => [...mediaReferences.value.filter(item => item.type === "image"), ...(data.value.uploadedImage ? [{ key: "uploaded", type: "image", label: data.value.uploadedImage.path.split('/').at(-1) || "已上传图片", media: data.value.uploadedImage }] : [])]);
const fieldKey = (field: Field) => JSON.stringify([field.nodeId, field.fieldName]);
const fieldDisabled = (field: Field) => data.value.operation === "mesh" && data.value.values[JSON.stringify(["options", "texture"])] === false && ["pbr", "textureQuality", "textureAlignment", "textureSeed"].includes(field.fieldName);
watch(() => data.value.values[JSON.stringify(["options", "texture"])], value => {
  if (value === false) syncMeshOptions();
});
function syncMeshOptions() {
  if (data.value.operation !== "mesh" || data.value.values[JSON.stringify(["options", "texture"])] !== false) return;
  data.value.values[JSON.stringify(["options", "pbr"])] = false;
  for (const key of ["textureQuality", "textureAlignment", "textureSeed"]) delete data.value.values[JSON.stringify(["options", key])];
}
const descriptionKey = () => JSON.stringify([data.value.operation, data.value.providerId, data.value.mode, data.value.workflowId]);
const matchingReferences = (type: string) => mediaReferences.value.filter(reference => reference.type === type);
const mediaPath = (field: Field) => { const value = data.value.values[fieldKey(field)]; return value && typeof value === "object" && "path" in value ? String(value.path) : ""; };
const mediaSelection = (field: Field) => matchingReferences(field.type).find(reference => reference.media.path === mediaPath(field))?.key ?? "";

async function request<T>(path: string, body?: unknown, method = body ? "POST" : "GET", signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/creative/${path}`, { method, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw Object.assign(new Error(result.message || `请求失败（${response.status}）`), { status: response.status });
  return result.data;
}

async function loadProviders() { providers.value = await request<Provider[]>("providers"); }
function resetDescription() { data.value.fields = []; data.value.values = {}; data.value.descriptionKey = undefined; }
async function changeOperation() {
  resetDescription();
  data.value.providerId = availableProviders.value[0]?.id ?? (data.value.operation === "runningHub" ? "runningHub" : "falCreative");
  if (data.value.operation !== "runningHub") await describe();
}

async function describe() {
  if (busy.value) throw new Error("请等待当前操作完成");
  describing.value = true;
  localError.value = "";
  const key = descriptionKey();
  try {
    const { directory } = await files.getWorkspaceFiles().list();
    const description = await request<{ fields: Field[] }>("describe", { directory, providerId: data.value.providerId, operation: data.value.operation, ...(data.value.operation === "runningHub" ? { mode: data.value.mode, workflowId: data.value.workflowId } : {}) });
    if (disposed || key !== descriptionKey()) return;
    data.value.fields = description.fields;
    data.value.values = Object.fromEntries(description.fields.map(field => [fieldKey(field), field.value ?? (field.type === "boolean" ? false : field.type === "number" ? undefined : field.options?.[0] ?? "")]));
    data.value.descriptionKey = key;
  } finally { describing.value = false; }
}

function setNumber(field: Field, event: Event) { const value = (event.target as HTMLInputElement).value; data.value.values[fieldKey(field)] = value === "" ? undefined : Number(value); }
function setMediaField(field: Field, key: string) { data.value.values[fieldKey(field)] = matchingReferences(field.type).find(reference => reference.key === key)?.media; }
async function upload(event: Event, type: string) {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  element.value = "";
  if (!file) return;
  if (busy.value) throw new Error("请等待当前操作完成");
  if (!file.type.startsWith(`${type}/`) || !file.size || file.size > 100 * 1024 * 1024) throw new Error("请选择对应类型的非空文件，最大 100 MB");
  uploading.value = true;
  try { return { path: await files.uploadFile(file), mimeType: file.type }; }
  finally { uploading.value = false; }
}
async function uploadInput(event: Event) { try { const image = await upload(event, "image"); if (image && !disposed) { data.value.uploadedImage = image; data.value.imageKey = "uploaded"; } } catch (error) { report(error); } }
async function uploadField(event: Event, field: Field) { try { const media = await upload(event, field.type); if (media && !disposed) data.value.values[fieldKey(field)] = media; } catch (error) { report(error); } }

function buildInput() {
  if (data.value.descriptionKey !== descriptionKey()) throw new Error("服务或工具已变化，请重新读取参数");
  syncMeshOptions();
  for (const field of data.value.fields) {
    const value = data.value.values[fieldKey(field)];
    if (field.required && (value === undefined || value === null || value === "")) throw new Error(`请填写${field.label}`);
    if (field.type === "number" && value !== undefined && !Number.isFinite(value)) throw new Error(`${field.label}必须是有效数字`);
  }
  if (data.value.operation === "runningHub") return { operation: "runningHub", mode: data.value.mode, workflowId: data.value.workflowId, fields: data.value.fields.flatMap(field => {
    const value = data.value.values[fieldKey(field)];
    return value === undefined || value === "" && !field.required ? [] : [{ nodeId: field.nodeId, fieldName: field.fieldName, value }];
  }) };
  const image = imageReferences.value.find(reference => reference.key === data.value.imageKey)?.media;
  if (!image) throw new Error("请选择输入图片");
  return { operation: data.value.operation, image, options: Object.fromEntries(data.value.fields.flatMap(field => {
    const value = data.value.values[fieldKey(field)];
    return value === undefined || value === "" ? [] : [[field.fieldName, value]];
  })) };
}

async function start() {
  if (busy.value || pending.value) throw new Error("当前任务尚未结束，请先查询或停止原任务");
  const input = buildInput();
  const providerId = data.value.providerId;
  preparing.value = true;
  let directory: string;
  try { directory = (await files.getWorkspaceFiles().list()).directory; }
  finally { preparing.value = false; }
  if (disposed) throw new Error("节点已关闭");
  const snapshot = { directory, requestId: crypto.randomUUID() };
  data.value.request = snapshot;
  data.value.task = { requestId: snapshot.requestId, status: "submitting" };
  localError.value = "";
  observe(async signal => {
    let task: Task;
    try { task = await request<Task>("start", { ...snapshot, providerId, input }, "POST", signal); }
    catch (failure) {
      if (!disposed && data.value.request?.requestId === snapshot.requestId && !signal.aborted) {
        // ACT: 明确拒绝的前置校验可更正后新建请求；回执丢失只查原号，避免重复计费。
        const status = (failure as { status?: number }).status;
        data.value.task = { requestId: snapshot.requestId, status: status && [400, 401, 403, 404, 422].includes(status) ? "failed" : "uncertain", error: failure instanceof Error ? failure.message : "提交未完成" };
      }
      throw failure;
    }
    return poll(task, snapshot, signal);
  });
  return { requestId: snapshot.requestId, status: "submitting" };
}

function observe(run: (signal: AbortSignal) => Promise<void>) {
  controller = new AbortController();
  const activeController = controller;
  polling = generationState.run(() => run(activeController.signal)).catch(error => { if (!disposed && !activeController.signal.aborted) report(error); }).finally(() => { if (controller === activeController) controller = undefined; });
}

async function poll(initial: Task | undefined, snapshot: { directory: string; requestId: string }, signal: AbortSignal) {
  let task = initial;
  while (!signal.aborted && !disposed) {
    if (!task) task = await request<Task>(`status?${new URLSearchParams(snapshot)}`, undefined, "GET", signal);
    if (disposed || signal.aborted || data.value.request?.requestId !== snapshot.requestId) return;
    data.value.task = task;
    if (task.status === "completed") {
      await taskWorkspace();
      if (disposed || signal.aborted) return;
      for (const key of ["image", "video", "audio", "model"]) outputs.value[key] = undefined;
      modelContent.value = undefined;
      const model = task.files?.find(isModel);
      if (model) { data.value.modelPath = model.path; outputs.value.model = { dataType: "STRING", value: model.path }; }
      for (const kind of ["audio", "video", "image"]) {
        const media = task.files?.find(file => file.mimeType.startsWith(`${kind}/`));
        if (media) await selectOutput(media);
      }
      return;
    }
    if (["failed", "cancelled", "uncertain"].includes(task.status)) throw new Error(task.error || statusLabels[task.status]);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
      signal.addEventListener("abort", abort, { once: true });
    });
    task = undefined;
  }
}

async function resume() {
  if (busy.value) throw new Error("请等待当前操作完成");
  if (!data.value.request) throw new Error("没有已保存的任务");
  const snapshot = { ...data.value.request };
  localError.value = "";
  observe(signal => poll(undefined, snapshot, signal));
  return { requestId: snapshot.requestId, status: "querying" };
}

async function cancel() {
  const snapshot = data.value.request;
  if (!snapshot || cancelling.value) return;
  cancelling.value = true;
  try {
    const result = await request<Task>("cancel", { ...snapshot });
    controller?.abort();
    await polling;
    if (!disposed && data.value.request?.requestId === snapshot.requestId) data.value.task = result;
  } finally { cancelling.value = false; }
}

async function recover(remoteId: string) {
  if (busy.value || !data.value.request) throw new Error("请先等待当前查询结束");
  if (data.value.task?.status !== "uncertain") throw new Error("仅提交回执未知的任务需要绑定原号");
  preparing.value = true;
  try {
    const task = await request<Task>("recover", { ...data.value.request, remoteId });
    if (disposed) return;
    data.value.task = task;
    originalRemoteId.value = "";
  } finally { preparing.value = false; }
  return resume();
}

const isModel = (file: TaskFile) => file.mimeType === "model/gltf-binary" || /\.glb$/i.test(file.path);
async function selectOutput(file: TaskFile) {
  if (isModel(file)) {
    const workspace = await taskWorkspace();
    const content = await workspace.read(file.path);
    if (disposed) return;
    data.value.modelPath = file.path;
    outputs.value.model = { dataType: "STRING", value: file.path };
    modelContent.value = content;
    return;
  }
  const media = { url: file.path, mimeType: file.mimeType };
  if (file.mimeType.startsWith("image/")) { outputs.value.image = { dataType: "IMAGE", value: media }; data.value.previewType = "image"; }
  else if (file.mimeType.startsWith("video/")) { outputs.value.video = { dataType: "VIDEO", value: media }; data.value.previewType = "video"; }
  else if (file.mimeType.startsWith("audio/")) { outputs.value.audio = { dataType: "AUDIO", value: media }; data.value.previewType = "audio"; }
  else throw new Error("该文件仅支持下载");
}

async function taskWorkspace() {
  const workspace = files.getWorkspaceFiles();
  if (data.value.request && (await workspace.list()).directory !== data.value.request.directory) throw new Error("任务属于另一个工作目录，请回到原项目查看结果");
  return workspace;
}

async function download(file: TaskFile) {
  const content = await (await taskWorkspace()).read(file.path);
  const url = URL.createObjectURL(new Blob([content], { type: file.mimeType }));
  try { const link = document.createElement("a"); link.href = url; link.download = file.name || file.path.split('/').at(-1) || "结果"; link.click(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

async function saveSnapshot(file: File) {
  if (uploading.value) throw new Error("截图正在保存");
  uploading.value = true;
  try {
    await taskWorkspace();
    const path = await files.uploadFile(file);
    if (!disposed) { outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType: file.type } }; data.value.previewType = "image"; }
  }
  finally { uploading.value = false; }
}

function openConfig() { apiKey.value = ""; configVisible.value = true; }
async function saveConfig() {
  savingConfig.value = true;
  try {
    await request("config", { providerId: data.value.providerId, apiKey: apiKey.value.trim(), ...(data.value.operation === "runningHub" ? { baseUrl: baseUrl.value } : {}) }, "PUT");
    apiKey.value = "";
    configVisible.value = false;
    await loadProviders();
  } finally { savingConfig.value = false; }
}
function report(error: unknown) { localError.value = error instanceof Error ? error.message : "操作失败"; showNodeError(error, "创作工具操作失败"); }
nodeEvent.on("copy", () => ({ request: undefined, task: undefined }));
nodeEvent.on("save", reason => { if (uploading.value || reason === "reload" && busy.value) throw new Error("请等待当前文件操作完成"); });
nodeEvent.on("delete", async () => { if (uploading.value || describing.value) throw new Error("工具处理中，请稍后删除节点"); if (pending.value) await cancel(); });
onScopeDispose(() => { disposed = true; controller?.abort(); apiKey.value = ""; });
onMounted(() => { void loadProviders().catch(report); if (pending.value) void resume().catch(report); });

nodeTools.register({ name: "describeCreativeTool", description: "读取当前RH应用、ComfyUI工作流或专用工具的实际参数；先使用setCreativeConfig选择工具与连接", parameters: z.strictObject({}), execute: describe });
nodeTools.register({ name: "getCreativeConfig", description: "读取当前创作工具的动态参数、输入与持久任务，不返回服务密钥", parameters: z.strictObject({}), execute: () => ({ ...data.value, references: mediaReferences.value, textReference: textReference.value }) });
nodeTools.register({ name: "setCreativeConfig", description: "设置创作工具、服务、RH类型及ID、输入图片和动态参数；fieldValues按describeCreativeTool返回字段的nodeId/fieldName键填写，先读取再设置字段", parameters: z.strictObject({ operation: z.enum(["runningHub", "mesh", "upscale", "texture"]).optional(), providerId: z.string().min(1).optional(), mode: z.enum(["app", "workflow"]).optional(), workflowId: z.string().max(200).optional(), image: z.strictObject({ path: z.string().min(1), mimeType: z.string().startsWith("image/") }).optional(), fieldValues: z.array(z.strictObject({ nodeId: z.string(), fieldName: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.strictObject({ path: z.string(), mimeType: z.string() })]) })).optional() }), execute(input) {
  if (busy.value || pending.value) throw new Error("请等待原任务结束");
  const previous = descriptionKey();
  for (const key of ["operation", "providerId", "mode", "workflowId"] as const) if (input[key] !== undefined) Object.assign(data.value, { [key]: input[key] });
  if (descriptionKey() !== previous) resetDescription();
  if (input.image) { data.value.uploadedImage = input.image; data.value.imageKey = "uploaded"; }
  for (const field of input.fieldValues ?? []) {
    if (!data.value.fields.some(item => item.nodeId === field.nodeId && item.fieldName === field.fieldName)) throw new Error("未找到动态字段，请先读取工具参数");
    data.value.values[fieldKey(field as Field)] = field.value;
  }
  syncMeshOptions();
  return { operation: data.value.operation, providerId: data.value.providerId };
} });
nodeTools.register({ name: "runCreativeTool", description: "以当前实际参数启动创作工具；工作区任务持久化，可用getCreativeConfig查询，刷新只恢复原任务", parameters: z.strictObject({}), execute: start });
nodeTools.register({ name: "resumeCreativeTask", description: "仅查询节点保存的原任务，不重新提交生成", parameters: z.strictObject({}), execute: resume });
nodeTools.register({ name: "recoverCreativeTask", description: "仅在提交回执未知时，把供应商控制台查到的原任务号绑定到原请求并查询，绝不重新提交生成", parameters: z.strictObject({ remoteId: z.string().min(1).max(200) }), execute: ({ remoteId }) => recover(remoteId) });
nodeTools.register({ name: "selectCreativeOutput", description: "从本次任务已落盘文件中选择媒体输出或打开GLB模型", parameters: z.strictObject({ path: z.string().min(1) }), async execute({ path }) { const file = data.value.task?.files?.find(item => item.path === path); if (!file) throw new Error("文件不属于此任务"); await selectOutput(file); return file; } });
nodeTools.register({ name: "captureCreativeModel", description: "保存已打开GLB的当前机位截图，输出图片可连接下游生成节点", parameters: z.strictObject({}), async execute() { if (!modelViewer.value) throw new Error("请先打开模型预览"); await modelViewer.value.capture(); return outputs.value.image; } });
</script>

<style scoped lang="scss">
.creativeContent {
  padding: 14px;
  max-height: min(660px, 70vh);
  overflow: auto;
  overscroll-behavior: contain;
  font-size: 12px;
  .mediaPreview { display: block; width: 100%; max-height: 280px; object-fit: contain; margin-bottom: 12px; }
  .formRow { display: flex; align-items: end; gap: 8px; margin-bottom: 10px; label { flex: 1; min-width: 0; } }
  label, .fieldLabel { display: block; margin-bottom: 5px; }
  input:not([type="checkbox"]), textarea, select { box-sizing: border-box; width: 100%; margin-top: 5px; padding: 7px; color: var(--el-text-color-primary); background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 5px; }
  textarea { resize: vertical; }
  button { padding: 6px 9px; border: 1px solid var(--el-border-color); border-radius: 5px; color: var(--el-text-color-primary); background: var(--el-fill-color-light); cursor: pointer; &:disabled { opacity: .5; cursor: default; } }
  fieldset { border: 0; margin: 10px 0; padding: 0; .dynamicField { margin: 10px 0; } }
  .filePath, .hintText { color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
  .taskStatus { overflow-wrap: anywhere; }
  .errorText { color: var(--el-color-danger); white-space: pre-wrap; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .resultFiles { padding: 0; list-style: none; li { display: flex; align-items: center; gap: 6px; margin-top: 9px; span { flex: 1; min-width: 0; overflow-wrap: anywhere; } } }
}
.connectionForm { label { display: block; margin-bottom: 16px; } input, select { display: block; box-sizing: border-box; width: 100%; padding: 9px; margin-top: 7px; } }
</style>
