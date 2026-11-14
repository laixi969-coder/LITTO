<template>
  <nodeSkeleton v-bind="nodeProps" style="width: 520px" :topVisible="node.selected">
    <div class="worldContent nodrag nopan nowheel" @pointerdown.stop @keydown.stop @wheel.stop>
      <video ref="screen" class="worldScreen" autoplay muted playsinline tabindex="0" aria-label="世界画面，WASD移动，方向键转动镜头" @keydown="keyDown" @keyup="keyUp" @blur="releaseControls" @loadeddata="firstFrame" />
      <p role="status">{{ statusLabel }}{{ pendingUpdate ? ' · 等待世界更新确认' : '' }}</p>
      <p v-if="error" class="worldError" role="alert">{{ error }}</p>
      <label>世界描述<textarea v-model="data.prompt" rows="3" maxlength="2000" :disabled="starting || !!pendingUpdate" /></label>
      <button v-if="textReference" type="button" :disabled="starting || !!pendingUpdate" @click="data.prompt = textReference">采用连接文本</button>
      <label>起点世界<select v-model="data.preset" :disabled="starting || !!pendingUpdate"><option value="">默认世界</option><option v-for="preset in presets" :key="preset.name" :value="preset.name">{{ preset.name }}</option></select></label>
      <label>起点图片<select v-model="data.imageKey" :disabled="active || starting"><option value="">不使用图片</option><option v-for="image in imageReferences" :key="image.key" :value="image.key">{{ image.label }}</option></select></label>
      <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传世界起点图片" :disabled="active || starting || saving" @change="uploadImage" />
      <div class="worldActions">
        <button type="button" :disabled="starting || active || saving || stopping" @click="start().catch(report)">开始世界会话</button>
        <button type="button" :disabled="stopping || (!active && !starting)" @click="stop().catch(report)">结束会话</button>
        <button type="button" :disabled="!ready || !!pendingUpdate || !data.prompt.trim()" @click="updateWorld('prompt').catch(report)">更新世界</button>
        <button type="button" :disabled="!ready || !!pendingUpdate" @click="updateWorld('reset').catch(report)">重置世界</button>
        <button type="button" :disabled="!ready || saving" @click="snapshot().catch(report)">保存当前画面</button>
        <button type="button" :disabled="!ready || saving" @click="(recording ? finishRecording() : startRecording()).catch(report)">{{ recording ? '结束并保存录制' : '录制片段' }}</button>
      </div>
      <div class="worldControls" aria-label="世界移动控制">
        <button v-for="control in controlLabels" :key="control.command" type="button" :disabled="!ready || !!pendingUpdate" @pointerdown.prevent="press(control.command)" @pointerup="releaseControls" @pointercancel="releaseControls" @pointerleave="releaseControls">{{ control.label }}</button>
      </div>
      <p class="worldHint">点击画面后 WASD 移动、方向键转镜头。会话按供应商规则计费；离开画布即关闭，重开须手动开始。</p>
      <img v-if="snapshotUrl" class="savedScreen" :src="snapshotUrl" alt="已保存的世界画面" />
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, ref, inject, watch, onScopeDispose, onMounted, type Ref } from "vue";
import { createFalClient } from "@fal-ai/client";
import { wma, type ManagedRealtimeSession, type WmaRealtimeSession } from "@fal-ai/client/realtime";
import { IconWorld } from "@tabler/icons-vue";
import { nodeSkeleton, useNode, useNodeReferences, nodeTools, showNodeError, uploadNodeFile, z, type NodeHandle, type NodeMediaValue, type WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";

defineOptions({ inheritAttrs: false, icon: IconWorld, handles: [
  { id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "起点图片、世界描述" },
  { id: "image", type: "source", dataType: "IMAGE", label: "世界截图" },
  { id: "video", type: "source", dataType: "VIDEO", label: "世界录制" },
] satisfies NodeHandle[] });
const { id, node, nodeProps, files, outputs, nodeEvent } = useNode({ label: "生成式世界" });
const canvasActive = inject<Readonly<Ref<boolean>>>("canvasActive", ref(true));
type State = { prompt: string; preset: string; imageKey: string; uploadedImage?: NodeMediaValue; lastSession?: { requestId: string; createdAt: string }; recordings?: string[] };
const data = computed(() => node.data as State);
data.value.prompt ??= ""; data.value.preset ??= ""; data.value.imageKey ??= "";
const { refList } = useNodeReferences();
const imageReferences = computed(() => [
  ...refList.value.flatMap((reference, index) => reference.dataType === "IMAGE" && reference.value ? [{ key: `${reference.source}:${reference.sourceHandle}`, label: `连接图片${index + 1}`, image: reference.value }] : []),
  ...(data.value.uploadedImage ? [{ key: "uploaded", label: "上传图片", image: data.value.uploadedImage }] : []),
]);
const textReference = computed(() => refList.value.flatMap(reference => reference.dataType === "STRING" && reference.value ? [reference.value] : []).join("\n"));
const screen = ref<HTMLVideoElement>();
const active = ref(false); const starting = ref(false); const stopping = ref(false); const ready = ref(false); const saving = ref(false); const recording = ref(false);
const error = ref(""); const pendingUpdate = ref(""); const presets = ref<{ name: string; prompt: string }[]>([]);
const statusLabel = computed(() => stopping.value ? "结束并保存中…" : starting.value ? "连接世界中…" : ready.value ? "世界已就绪" : active.value ? "等待世界首帧…" : "会话未连接");
const snapshotFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const snapshotUrl = files.useFileUrl(snapshotFile, report);
let session: ManagedRealtimeSession<WmaRealtimeSession> | undefined;
let controller: AbortController | undefined;
let media: MediaStream | undefined;
let imageUrl: string | undefined;
let recorder: MediaRecorder | undefined;
let recordingDone: Promise<void> | undefined;
let controlsTimer: ReturnType<typeof setInterval> | undefined;
let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let configured = false;
let sessionFiles: WorkspaceFiles | undefined;
let stoppingTask: Promise<void> | undefined;
const held = new Set<string>();
const controlLabels = [{ command: "forward", label: "前进 W" }, { command: "backward", label: "后退 S" }, { command: "left", label: "左移 A" }, { command: "right", label: "右移 D" }, { command: "look_left", label: "左看 ←" }, { command: "look_right", label: "右看 →" }, { command: "look_up", label: "上看 ↑" }, { command: "look_down", label: "下看 ↓" }];
const keyCommands: Record<string, string> = { KeyW: "forward", KeyS: "backward", KeyA: "left", KeyD: "right", ArrowLeft: "look_left", ArrowRight: "look_right", ArrowUp: "look_up", ArrowDown: "look_down" };
function report(cause: unknown) { error.value = cause instanceof Error ? cause.message : "世界操作失败"; showNodeError(cause, "世界操作失败"); }
function send(message: object) { if (!session?.session) throw new Error("世界连接尚未就绪"); session.session.send(message); }
function releaseControls() { held.clear(); if (session?.session && active.value) send({ type: "commands", active: [], activated: [] }); }
function press(command: string) {
  if (!ready.value || pendingUpdate.value || held.has(command)) return;
  held.add(command); send({ type: "commands", active: [...held], activated: [command] });
}
function keyDown(event: KeyboardEvent) { const command = keyCommands[event.code]; if (command) { event.preventDefault(); press(command); } }
function keyUp(event: KeyboardEvent) { if (keyCommands[event.code]) { event.preventDefault(); held.delete(keyCommands[event.code]!); if (ready.value) send({ type: "commands", active: [...held], activated: [] }); } }
function clearAcknowledgement() { if (acknowledgementTimer) clearTimeout(acknowledgementTimer); acknowledgementTimer = undefined; pendingUpdate.value = ""; }
function waitAcknowledgement(expected: string) {
  releaseControls(); pendingUpdate.value = expected;
  acknowledgementTimer = setTimeout(() => { error.value = "世界更新尚未确认，请结束此会话后手动开启新会话；不会自动重发更新"; }, 120000);
}
function receive(raw: unknown) {
  try {
    const message = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!message || typeof message !== "object") return;
    if (message.type === "session_info") presets.value = Array.isArray(message.presets) ? message.presets.filter((item: { name?: unknown; prompt?: unknown }) => typeof item?.name === "string" && typeof item.prompt === "string") : [];
    if (message.type === pendingUpdate.value) clearAcknowledgement();
    if (message.type === "error") error.value = String(message.error || "世界服务报告错误");
    if (message.type === "stream_exhausted") { error.value = "当前世界会话已结束，请手动开始新会话"; void stop().catch(report); }
  } catch { error.value = "无法解析世界服务消息"; }
}
async function firstFrame() {
  if (!screen.value?.videoWidth || !active.value) return;
  ready.value = true;
  if (!configured && (data.value.prompt.trim() || data.value.preset || imageUrl)) {
    configured = true;
    waitAcknowledgement("configured");
    send({ type: "configure", prompt: data.value.prompt.trim() || null, preset: data.value.preset || null, image_url: imageUrl || null });
  }
}
async function start() {
  if (!canvasActive.value) throw new Error("请先打开此世界所在画布");
  if (active.value || starting.value || stopping.value) throw new Error("世界会话已连接或正在切换");
  error.value = ""; starting.value = true; ready.value = false; configured = false; clearAcknowledgement();
  const thisController = controller = new AbortController();
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    const { directory } = await workspaceFiles.list();
    sessionFiles = workspaceFiles;
    const requestId = crypto.randomUUID();
    const image = imageReferences.value.find(item => item.key === data.value.imageKey)?.image;
    if (data.value.imageKey && !image) throw new Error("已选起点图片失效，请重新选择图片");
    imageUrl = undefined;
    if (image) {
      const response = await fetch("/api/creative/worldImage", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory, image: { path: image.url, mimeType: image.mimeType } }), signal: thisController.signal });
      const result = await response.json(); if (!response.ok || result.code !== 200) throw new Error(result.message || "上传世界起点图片失败"); imageUrl = result.data.url;
    }
    thisController.signal.throwIfAborted();
    data.value.lastSession = { requestId, createdAt: new Date().toISOString() };
    const fal = createFalClient({ proxyUrl: `/api/creative/worldProxy?${new URLSearchParams({ directory, requestId })}`, retry: { maxRetries: 0 }, fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, credentials: "same-origin", headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), "x-toonflow-workspace": "1" } })) as typeof fetch });
    session = fal.realtime.open(wma("alibaba/abot-world-0"), {
      receive: ["video"], abortSignal: thisController.signal, negotiationTimeoutMs: 180000,
      onMedia(stream) { media = stream; if (screen.value) { screen.value.srcObject = stream; void screen.value.play().catch(report); } },
      onData: receive,
      onState(state) { active.value = state === "live"; if (state === "failed" || state === "closed") { ready.value = false; held.clear(); clearAcknowledgement(); if (controlsTimer) clearInterval(controlsTimer); controlsTimer = undefined; } },
      onError(cause) { report(cause); },
    });
    await session.ready;
    active.value = true;
    controlsTimer = setInterval(() => { if (held.size && ready.value && !pendingUpdate.value) send({ type: "commands", active: [...held], activated: [] }); }, 100);
    if (screen.value?.readyState && screen.value.readyState >= 2) await firstFrame();
  } catch (cause) { const cancelled = thisController.signal.aborted; await stop(); if (!cancelled) throw cause; }
  finally { starting.value = false; }
}
async function updateWorld(type: "prompt" | "reset") {
  if (!ready.value || pendingUpdate.value) throw new Error("请等待首帧及上一条世界更新确认");
  if (type === "prompt" && !data.value.prompt.trim()) throw new Error("请填写世界描述");
  waitAcknowledgement(type === "prompt" ? "prompt_applied" : "reset_applied");
  send(type === "prompt" ? { type, prompt: data.value.prompt.trim() } : { type, prompt: data.value.prompt.trim() || null, preset: data.value.preset || null, image_url: imageUrl || null });
}
function stop(): Promise<void> {
  if (stoppingTask) return stoppingTask;
  stoppingTask = closeWorld().finally(() => { stoppingTask = undefined; });
  return stoppingTask;
}
async function closeWorld() {
  stopping.value = true;
  releaseControls();
  ready.value = false;
  // 停止录制立即触发最终数据块；先关闭计费连接，再等待已绑定目录的素材上传。
  const recorded = recorder ? finishRecording().then(() => undefined, cause => cause) : Promise.resolve(undefined);
  if (controlsTimer) clearInterval(controlsTimer); controlsTimer = undefined;
  clearAcknowledgement();
  if (session?.session) { try { send({ type: "stop" }); } catch { /* ACT: 连接已断时仍继续释放本地轨道。 */ } }
  let closeError: unknown;
  try { controller?.abort(); await session?.close(); }
  catch (cause) { closeError = cause; }
  finally {
    session = undefined; controller = undefined;
    media?.getTracks().forEach(track => track.stop()); media = undefined; sessionFiles = undefined;
    if (screen.value) screen.value.srcObject = null;
    active.value = false; starting.value = false;
  }
  try { const saveError = await recorded; if (saveError || closeError) throw saveError || closeError; }
  finally { stopping.value = false; }
}
async function snapshot() {
  const video = screen.value; if (!video?.videoWidth || !ready.value) throw new Error("请等待世界画面");
  const workspaceFiles = sessionFiles;
  if (!workspaceFiles) throw new Error("世界会话工作目录未绑定");
  saving.value = true;
  try {
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d"); if (!context) throw new Error("无法读取世界画面"); context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("截图失败")), "image/png"));
    const path = await uploadNodeFile(workspaceFiles, id, new File([blob], "world.png", { type: "image/png" }));
    outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } };
    return { path, mimeType: "image/png" };
  } finally { saving.value = false; }
}
async function startRecording() {
  if (!media || !ready.value || recorder) throw new Error("世界尚未就绪或正在录制");
  const workspaceFiles = sessionFiles;
  if (!workspaceFiles) throw new Error("世界会话工作目录未绑定");
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("当前浏览器不支持录制世界视频");
  const chunks: Blob[] = []; let bytes = 0;
  const current = recorder = new MediaRecorder(media, { mimeType });
  recordingDone = new Promise<void>((resolve, reject) => {
    current.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes >= 90 * 1024 * 1024 && current.state === "recording") current.stop(); } };
    current.onerror = () => reject(new Error("世界录制失败"));
    current.onstop = async () => {
      recording.value = false; saving.value = true;
      try {
        if (!bytes || bytes > 100 * 1024 * 1024) throw new Error("世界录制为空或超过100MB");
        const type = mimeType.split(";")[0]!;
        const path = await uploadNodeFile(workspaceFiles, id, new File(chunks, type === "video/mp4" ? "world.mp4" : "world.webm", { type }));
        outputs.value.video = { dataType: "VIDEO", value: { url: path, mimeType: type } };
        data.value.recordings = [...data.value.recordings ?? [], path]; resolve();
      } catch (cause) { reject(cause); } finally { saving.value = false; recorder = undefined; }
    };
  });
  void recordingDone.catch(report);
  current.start(1000); recording.value = true;
}
async function finishRecording() { if (recorder?.state === "recording") recorder.stop(); await recordingDone; }
async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = "";
  if (!file) return; saving.value = true;
  try { const path = await files.uploadFile(file); data.value.uploadedImage = { url: path, mimeType: file.type }; data.value.imageKey = "uploaded"; } catch (cause) { report(cause); } finally { saving.value = false; }
}
nodeTools.register({ name: "startWorld", description: "显式开启按供应商计费的Abot World实时世界会话，重开画布不会自动开始", parameters: z.strictObject({}), execute: start });
nodeTools.register({ name: "stopWorld", description: "停止世界会话并释放实时连接，保存正在录制的片段", parameters: z.strictObject({}), execute: stop });
nodeTools.register({ name: "updateWorld", description: "更新或重置已连接世界，等待上一条更新确认后才可调用", parameters: z.strictObject({ type: z.enum(["prompt", "reset"]), prompt: z.string().min(1).max(2000) }), execute: async input => { data.value.prompt = input.prompt; await updateWorld(input.type); return { awaitingAcknowledgement: true }; } });
nodeTools.register({ name: "worldStatus", description: "读取实时世界连接和更新确认状态", parameters: z.strictObject({}), execute: () => ({ active: active.value, ready: ready.value, pendingUpdate: pendingUpdate.value, error: error.value }) });
nodeTools.register({ name: "captureWorld", description: "将世界当前帧保存到工作区并连接图片输出", parameters: z.strictObject({}), execute: snapshot });
nodeEvent.on("save", async reason => {
  if (reason === "reload") { await stop(); return; }
  if (recorder) await finishRecording();
  if (saving.value) throw new Error("世界素材正在保存，请稍后操作");
});
nodeEvent.on("delete", async () => { await stop(); await files.removeNodeFiles(); });
nodeEvent.on("copy", () => ({ lastSession: undefined, recordings: undefined }));
watch(canvasActive, value => { if (!value) void stop().catch(report); });
onMounted(() => { window.addEventListener("blur", releaseControls); document.addEventListener("visibilitychange", visibilityChanged); });
function visibilityChanged() { if (document.hidden) releaseControls(); }
onScopeDispose(() => { disposed = true; window.removeEventListener("blur", releaseControls); document.removeEventListener("visibilitychange", visibilityChanged); void stop().catch(cause => { if (!disposed) report(cause); }); });
</script>

<style scoped lang="scss">
.worldContent {
  padding: 12px; display: flex; flex-direction: column; gap: 10px; color: var(--el-text-color-primary);
  .worldScreen, .savedScreen { width: 100%; max-height: 300px; object-fit: contain; background: #090a0c; border-radius: 8px; }
  .worldScreen:focus { outline: 2px solid var(--el-color-primary); }
  label { display: flex; flex-direction: column; gap: 5px; }
  textarea, select { font: inherit; color: inherit; background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 5px; padding: 7px; }
  button { font: inherit; color: inherit; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 5px; padding: 6px 9px; cursor: pointer; &:disabled { opacity: .45; cursor: default; } }
  .worldActions, .worldControls { display: flex; flex-wrap: wrap; gap: 6px; }
  .worldHint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
  .worldError { color: var(--el-color-danger); }
}
</style>
