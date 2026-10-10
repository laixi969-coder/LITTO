<template>
  <el-drawer v-model="visible" title="配音与口型" size="min(1000px, 100vw)" :beforeClose="closePanel">
    <div class="voicePanel" :aria-busy="busy">
      <p v-if="error" class="errorMessage" role="alert">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>
      <div class="toolbar">
        <el-button :disabled="busy" @click="run(refreshModels)">刷新模型</el-button>
        <el-button :disabled="busy" @click="emit('settings')">配置语音 / 口型模型</el-button>
        <el-button :disabled="busy || !loaded || !dirty" @click="run(save)">保存配音方案</el-button>
        <el-button :disabled="busy || !loaded" @click="run(importStory)">同步已采用剧本台词（保留旧方案）</el-button>
        <el-button v-if="operation" :disabled="stopping" @click="stop">停止处理</el-button>
      </div>
      <p class="hint">先为角色选定音色，再逐句配音和试听。对白可用已确定的配音驱动人物视频，旁白无需对口型。开源模型需先部署并在媒体模型设置中添加 Qwen3-TTS / MuseTalk。</p>
      <fieldset :disabled="busy || !loaded">
        <h3>角色与音色</h3>
        <div v-for="role in project.roles" :key="role.id" class="roleRow">
          <label>角色名称<input v-model="role.name" maxlength="100" /></label>
          <label>配音模型<select :value="modelKey(role)" @change="selectRoleModel(role, ($event.target as HTMLSelectElement).value)"><option value="">选择模型</option><option v-for="model in speechModels" :key="modelKey(model)" :value="modelKey(model)">{{ model.providerLabel }} · {{ model.label }}</option></select></label>
          <label>固定音色<select v-if="roleModel(role)?.voices?.length" v-model="role.voice"><option value="">选择音色</option><option v-for="voice in roleModel(role)?.voices" :key="voice.voice" :value="voice.voice">{{ voice.title }}</option></select><input v-else v-model="role.voice" maxlength="256" aria-label="供应商音色 ID" /></label>
          <el-button :disabled="project.lines.some(line => line.roleId === role.id)" @click="project.roles.splice(project.roles.indexOf(role), 1)">删除角色</el-button>
        </div>
        <el-button :disabled="project.roles.length >= 50" @click="addRole">添加角色 / 旁白音色</el-button>
        <h3>对白与旁白</h3>
        <article v-for="(line, index) in project.lines" :key="line.id" class="speechLine">
          <div class="lineHeader">
            <strong>第 {{ index + 1 }} 句</strong>
            <span v-if="line.storySource">来源场次 {{ line.storySource.sceneId }}</span>
            <el-button :disabled="index === 0" @click="moveLine(index, -1)">上移</el-button>
            <el-button :disabled="index === project.lines.length - 1" @click="moveLine(index, 1)">下移</el-button>
            <el-button @click="project.lines.splice(index, 1)">移除台词</el-button>
          </div>
          <div class="fieldGrid">
            <label>类型<select v-model="line.kind"><option value="dialogue">画内对白</option><option value="narration">旁白 / 画外音</option></select></label>
            <label>说话人<select v-model="line.roleId"><option value="">选择角色</option><option v-for="role in project.roles" :key="role.id" :value="role.id">{{ role.name || '未命名角色' }}</option></select></label>
            <label class="fullField">台词<textarea v-model="line.text" rows="3" maxlength="10000" /></label>
            <label>情绪<select v-model="line.emotion"><option value="">自然</option><option v-for="emotion in emotions" :key="emotion" :value="emotion">{{ emotion }}</option></select></label>
            <label>语速<input v-model.number="line.speed" type="number" min="0.25" max="4" step="0.05" /></label>
            <label class="fullField">语气与表演说明<textarea v-model="line.delivery" rows="2" maxlength="1800" /></label>
            <label>句后停顿（秒，合成配音时使用）<input v-model.number="line.pauseAfter" type="number" min="0" max="10" step="0.1" /></label>
          </div>
          <p v-if="lineModel(line) && !lineModel(line)?.speechInstructions" class="hint">此模型未声明支持情绪指令，可生成自然语音；需要表演语气时请选择 Qwen3-TTS 1.7B。</p>
          <div class="toolbar">
            <el-button :disabled="!line.text.trim() || !line.roleId || line.takes.length >= 100" @click="run(() => generateSpeech(line), true)">生成此句配音</el-button>
            <label v-if="line.takes.length">采用配音版本<select v-model="line.takeId"><option v-for="(take, takeIndex) in line.takes" :key="take.id" :value="take.id">版本 {{ takeIndex + 1 }}</option></select></label>
            <attachmentPreview v-if="selectedTake(line)" :attachment="{ ...selectedTake(line)!.audio, name: '试听配音' }" :directory="directory" />
          </div>
          <p v-if="selectedTake(line) && stale(line)" class="errorMessage">台词、音色或语气已修改，当前配音是旧版本。请重新生成后再对口型或合成。</p>
          <p v-if="storySourceStale(line)" class="errorMessage">此句来源的剧本场次已改变或移除，请同步已采用剧本后核对台词、表演及人物视频。</p>
          <template v-if="line.kind === 'dialogue'">
            <div class="toolbar">
              <label class="fileLabel">上传此句人物视频<input type="file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" @change="uploadVideo(line, $event)" /></label>
              <attachmentPreview v-if="line.video" :attachment="{ ...line.video, name: '人物原视频' }" :directory="directory" />
              <el-button v-if="line.video" @click="line.video = undefined">移除人物视频</el-button>
              <el-button :disabled="!line.video || !selectedTake(line) || stale(line) || !lipSyncModel" @click="run(() => syncLine(line), true)">为此句对口型</el-button>
            </div>
            <div v-if="selectedTake(line)?.videos.length" class="toolbar">
              <span>口型视频：</span>
              <attachmentPreview v-for="(result, resultIndex) in selectedTake(line)?.videos" :key="result.id" :attachment="{ ...result.video, name: `口型版本 ${resultIndex + 1}${result.sourceVideo.path === line.video?.path ? '' : '（旧原片）'}` }" :directory="directory" />
            </div>
          </template>
        </article>
        <el-button :disabled="project.lines.length >= 500" @click="addLine">添加一句台词</el-button>
        <h3>对口型模型</h3>
        <label>模型<select :value="modelKey({ providerId: project.lipSyncProviderId, modelId: project.lipSyncModelId })" @change="selectLipSyncModel(($event.target as HTMLSelectElement).value)"><option value="">选择模型</option><option v-for="model in lipSyncModels" :key="modelKey(model)" :value="modelKey(model)">{{ model.providerLabel }} · {{ model.label }}</option></select></label>
        <p class="hint">每句使用一个清晰可见的说话人镜头；多人同框请先拆分。MuseTalk 会按音频长度生成，原片过短可能往返重复，请先裁好镜头并检查完整输出。停止本地等待后，远端推理可能仍需在服务端停止。</p>
        <h3>合成配音</h3>
        <el-button :disabled="!canMix || project.mixes.length >= 100" @click="run(mixSpeech, true)">按台词顺序合成 WAV</el-button>
        <p class="hint">合并每句选定版本并保留句后停顿，原始配音与口型视频均保留。需要已配置的 FFmpeg。</p>
        <div class="toolbar"><attachmentPreview v-for="(mix, index) in project.mixes" :key="mix.id" :attachment="{ ...mix.audio, name: `合成配音 ${index + 1}${mix.sourceKey === mixSourceKey ? '' : '（旧方案）'}` }" :directory="directory" /></div>
      </fieldset>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import axios from "axios";
import { useNodeAi, invalidateNodeModels, type NodeMediaModel, type NodeVideoRequest } from "@toonflow/nodes-scaffold/nodeAi";
import { createBrowserFfmpeg } from "@toonflow/ffmpeg/browser";
import { speechSourceKey, voiceProjectSchema, type VoiceProject, type VoiceLine, type VoiceRole } from "@toonflow/tool-media-generation/voiceProject";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import attachmentPreview from "@/components/agent/attachmentPreview.vue";
import { readStory } from "@/lib/storyClient";
import { storyStale, type StoryRevision } from "@toonflow/tool-scene-list/storyProject";

const props = defineProps<{ directory: string }>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ settings: [] }>();
// 组件以工作区路径为 key；所有跨 await 操作固定到打开时的目录。
const directory = props.directory;
const files = useWorkspaceFiles(directory);
const ai = useNodeAi();
const project = ref<VoiceProject>({ littoVoice: 1, roles: [], lines: [], lipSyncProviderId: "", lipSyncModelId: "", mixes: [] });
const models = ref<NodeMediaModel[]>([]);
const storyRevision = ref<StoryRevision>();
const loaded = ref(false);
const busy = ref(false);
const stopping = ref(false);
const error = ref("");
const message = ref("");
const operation = ref<AbortController>();
const lifetime = new AbortController();
let activeJob = "";
let pendingVideo: { input: NodeVideoRequest; requestId: string } | undefined;
let savedContent: string | null = null;
const savedSnapshot = ref(JSON.stringify(project.value));
const emotions = ["开心", "悲伤", "愤怒", "紧张", "惊讶", "克制", "低声耳语", "激动喊叫"];
const dirty = computed(() => JSON.stringify(project.value) !== savedSnapshot.value);
const speechModels = computed(() => models.value.filter(model => model.type === "audio"));
const lipSyncModels = computed(() => models.value.filter(model => model.type === "video" && model.lipSync));
const lipSyncModel = computed(() => lipSyncModels.value.find(model => model.providerId === project.value.lipSyncProviderId && model.modelId === project.value.lipSyncModelId));
const canMix = computed(() => project.value.lines.length > 0 && project.value.lines.every(line => selectedTake(line) && !stale(line)));
const mixSourceKey = computed(() => JSON.stringify(project.value.lines.map(line => [line.id, line.takeId, line.pauseAfter, stale(line)])));
const modelKey = (model: { providerId: string; modelId: string }) => model.providerId && model.modelId ? JSON.stringify([model.providerId, model.modelId]) : "";
const roleModel = (role: VoiceRole) => speechModels.value.find(model => model.providerId === role.providerId && model.modelId === role.modelId);
const lineRole = (line: VoiceLine) => project.value.roles.find(role => role.id === line.roleId);
const lineModel = (line: VoiceLine) => { const role = lineRole(line); return role && roleModel(role); };
const selectedTake = (line: VoiceLine) => line.takes.find(take => take.id === line.takeId);
const stale = (line: VoiceLine) => storySourceStale(line) || selectedTake(line)?.sourceKey !== speechSourceKey(line, lineRole(line));
function storySourceStale(line: VoiceLine) {
  const source = line.storySource;
  if (!source) return false;
  const scene = storyRevision.value?.scenes.find(item => item.sceneId === source.sceneId);
  return !scene || source.sceneText !== scene.text || source.speech !== scene.speech;
}
async function refreshStory() {
  const story = await readStory(directory);
  const approved = story.revisions.find(item => item.id === story.approvedId);
  storyRevision.value = approved && !storyStale(story, approved) ? approved : undefined;
}
async function importStory() {
  await refreshStory();
  const revision = storyRevision.value;
  if (!revision) throw new Error("请先采用当前有效剧本，可直接在聊天中确认");
  const lines = revision.scenes.flatMap(scene => {
    const previous = project.value.lines.filter(line => line.storySource?.sceneId === scene.sceneId);
    if (previous.length && previous.every(line => !storySourceStale(line))) return previous;
    return scene.speech.split(/\n+/).map(text => text.trim()).filter(Boolean).map(text => ({ id: crypto.randomUUID(), roleId: "", kind: "dialogue" as const, text, emotion: "", delivery: "", speed: 1, pauseAfter: 0.3, takes: [], takeId: "", storySource: { revisionId: revision.id, sceneId: scene.sceneId, sceneText: scene.text, speech: scene.speech } }));
  });
  const next = voiceProjectSchema.parse({ ...project.value, lines: [...lines, ...project.value.lines.filter(line => !line.storySource)] });
  await save(); await ensureSpeechDirectory();
  const historyPath = `assets/speech/voiceHistory${crypto.randomUUID().replaceAll("-", "")}.json`;
  await files.writeJson(historyPath, project.value, true);
  project.value = next; await save();
  message.value = `已同步。按行导入，须核对对白 / 旁白并分配说话人；未变场次保留配音，旧方案保存在 ${historyPath}`;
}

function addRole() { project.value.roles.push({ id: crypto.randomUUID(), name: "", providerId: "", modelId: "", voice: "" }); }
function addLine() { project.value.lines.push({ id: crypto.randomUUID(), roleId: "", kind: "dialogue", text: "", emotion: "", delivery: "", speed: 1, pauseAfter: 0.3, takes: [], takeId: "" }); }
function moveLine(index: number, offset: number) { const [line] = project.value.lines.splice(index, 1); if (line) project.value.lines.splice(index + offset, 0, line); }
function selectRoleModel(role: VoiceRole, key: string) {
  const model = speechModels.value.find(item => modelKey(item) === key);
  role.providerId = model?.providerId ?? ""; role.modelId = model?.modelId ?? ""; role.voice = "";
}
function selectLipSyncModel(key: string) {
  const model = lipSyncModels.value.find(item => modelKey(item) === key);
  project.value.lipSyncProviderId = model?.providerId ?? ""; project.value.lipSyncModelId = model?.modelId ?? "";
}

async function refreshModels() { invalidateNodeModels("media"); models.value = await ai.getMediaModels(lifetime.signal); }
async function load() {
  try {
    const content = await files.readText("voiceProject.json");
    const result = voiceProjectSchema.safeParse(JSON.parse(content));
    if (!result.success) throw new Error(`配音方案格式不正确，原文件未修改：${result.error.issues[0]?.message}`);
    project.value = result.data; savedContent = content;
  } catch (cause) {
    if (!axios.isAxiosError(cause) || cause.response?.status !== 404) throw cause;
  }
  savedSnapshot.value = JSON.stringify(project.value); loaded.value = true;
  await refreshModels();
  await refreshStory();
}

async function save() {
  if (!loaded.value || !dirty.value) return;
  const snapshot = voiceProjectSchema.parse(JSON.parse(JSON.stringify(project.value)));
  if (savedContent !== null && await files.readText("voiceProject.json") !== savedContent) throw new Error("配音方案已在别处修改，请保留当前编辑并重新打开项目后核对，未覆盖磁盘文件");
  const content = JSON.stringify(snapshot, null, 2);
  await files.write("voiceProject.json", content, savedContent === null);
  savedContent = content; savedSnapshot.value = JSON.stringify(snapshot);
  message.value = "配音方案已保存";
}

async function run(action: () => Promise<void>, cancellable = false) {
  if (busy.value) return;
  busy.value = true; error.value = ""; message.value = "";
  if (cancellable) operation.value = new AbortController();
  try { await action(); }
  catch (cause) {
    error.value = operation.value?.signal.aborted ? "处理已停止，已保存的素材保留" : axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "处理失败，请重试";
  } finally { busy.value = false; operation.value = undefined; activeJob = ""; pendingVideo = undefined; }
}
function signal() { return operation.value ? AbortSignal.any([lifetime.signal, operation.value.signal]) : lifetime.signal; }

async function generateSpeech(line: VoiceLine) {
  await refreshStory();
  if (storySourceStale(line)) throw new Error("剧本来源已变化，请先同步采用版本");
  const role = lineRole(line);
  const model = lineModel(line);
  if (!role || !role.name.trim() || !model || !role.voice.trim()) throw new Error("请先填写角色名称并选择可用模型与音色");
  if (line.takes.length >= 100) throw new Error("每句最多保留 100 个配音版本");
  await save();
  const sourceKey = speechSourceKey(line, role);
  const instructions = [line.emotion.trim(), line.delivery.trim()].filter(Boolean).join("；");
  const [audio] = await ai.generateAudio({ directory, providerId: role.providerId, modelId: role.modelId, prompt: line.text.trim(), voice: role.voice, speed: line.speed, instructions, format: "wav", outputDirectory: "assets/speech" }, signal());
  if (!audio || audio.mediaType !== "audio") throw new Error("供应商没有返回配音文件");
  const take = { id: crypto.randomUUID(), audio: { path: audio.path, mimeType: audio.mimeType }, sourceKey, videos: [] };
  line.takes.push(take); line.takeId = take.id;
  await save(); message.value = "配音已生成，请试听后再对口型";
}

async function ensureSpeechDirectory() {
  for (const path of ["assets", "assets/speech"]) await files.mkdir(path).catch(cause => { if (cause?.response?.data?.data?.code !== "EEXIST") throw cause; });
}
async function uploadVideo(line: VoiceLine, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = "";
  if (!file) return;
  await run(async () => {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const types: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
    if (!types[extension] || !file.size || file.size > 100 * 1024 * 1024) throw new Error("请选择不超过 100 MB 的非空 MP4、MOV 或 WebM");
    await ensureSpeechDirectory();
    const path = `assets/speech/${crypto.randomUUID()}.${extension}`;
    await files.write(path, file, true);
    line.video = { path, mimeType: types[extension]! };
    await save();
  });
}

async function syncLine(line: VoiceLine) {
  await refreshStory();
  const take = selectedTake(line);
  const model = lipSyncModel.value;
  if (line.kind !== "dialogue" || !take || stale(line) || !line.video || !model) throw new Error("请先确定当前对白配音、人物视频和对口型模型");
  if (take.videos.length >= 100) throw new Error("此配音最多保留 100 个口型版本");
  await save();
  const sourceVideo = { ...line.video };
  pendingVideo = { requestId: crypto.randomUUID(), input: { directory, providerId: model.providerId, modelId: model.modelId, prompt: "使用输入配音同步人物口型，保留人物身份和原有镜头", videos: [sourceVideo], audios: [take.audio], mode: ["videoReference:1", "audioReference:1"], outputDirectory: "assets/speech" } };
  const [video] = await ai.generateVideo(pendingVideo.input, signal(), id => { activeJob = id; }, pendingVideo.requestId);
  if (!video || video.mediaType !== "video") throw new Error("供应商没有返回口型视频");
  take.videos.push({ id: crypto.randomUUID(), video: { path: video.path, mimeType: video.mimeType }, sourceVideo, providerId: model.providerId, modelId: model.modelId });
  await save(); message.value = "口型视频已生成，请完整播放检查同步与人物表情";
}

async function mixSpeech() {
  await refreshStory();
  if (!canMix.value || project.value.mixes.length >= 100) throw new Error("请先为每句生成并选定当前配音版本");
  await save();
  const sourceKey = mixSourceKey.value;
  const ffmpeg = await createBrowserFfmpeg(directory, signal());
  const command = ffmpeg();
  const filters = project.value.lines.map((line, index) => {
    command.input(selectedTake(line)!.audio.path);
    return `[${index}:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,asetpts=PTS-STARTPTS,apad=pad_dur=${line.pauseAfter}[voice${index}]`;
  });
  filters.push(`${project.value.lines.map((_line, index) => `[voice${index}]`).join("")}concat=n=${project.value.lines.length}:v=0:a=1[voiceMix]`);
  await ensureSpeechDirectory();
  // fluent-ffmpeg 自动加 -y；先独占创建本次输出目录，避免覆盖已有素材，也不混用互斥的 -n。
  const outputDirectory = `assets/speech/mix${crypto.randomUUID().replaceAll("-", "")}`;
  await files.mkdir(outputDirectory);
  const path = `${outputDirectory}/voice.wav`;
  await new Promise<void>((resolve, reject) => command.complexFilter(filters).outputOptions(["-map [voiceMix]"]).audioCodec("pcm_s16le").format("wav").on("end", () => resolve()).on("error", reject).save(path));
  project.value.mixes.push({ id: crypto.randomUUID(), audio: { path, mimeType: "audio/wav" }, sourceKey });
  await save(); message.value = "整段配音已合成，可试听并从项目素材中使用";
}

async function stop() {
  if (stopping.value || !operation.value) return;
  stopping.value = true;
  try {
    if (!activeJob && pendingVideo) activeJob = (await ai.cancelMediaRequest("video", pendingVideo)).jobId ?? "";
    if (activeJob) await ai.cancelMediaJob(activeJob);
    operation.value?.abort();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "停止失败，请重试"; }
  finally { stopping.value = false; }
}
async function flushSave() { if (busy.value) throw new Error("配音正在处理，请完成或停止后离开"); await save(); }
async function closePanel(done: () => void) { try { await flushSave(); done(); } catch (cause) { error.value = cause instanceof Error ? cause.message : "保存失败"; } }
watch(visible, value => { if (value) void run(loaded.value ? refreshStory : load); });
onScopeDispose(() => { lifetime.abort(); operation.value?.abort(); });
defineExpose({ flushSave });
</script>

<style scoped lang="scss">
.voicePanel {
  color: var(--studioInk);
  .toolbar, .lineHeader { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 12px 0; }
  .lineHeader strong { margin-right: auto; }
  h3 { font-size: 16px; margin: 28px 0 16px; }
  fieldset { border: 0; padding: 0; min-width: 0; }
  label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  input, select, textarea { width: 100%; min-height: 44px; box-sizing: border-box; padding: 10px; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); background: var(--studioSurface); color: var(--studioInk); font: inherit; }
  textarea { resize: vertical; }
  :is(input, select, textarea):focus-visible { outline: 2px solid var(--studioDone); outline-offset: 2px; }
  .roleRow { display: grid; grid-template-columns: 1fr 2fr 1fr auto; align-items: end; gap: 12px; margin-bottom: 16px; }
  .speechLine { border-top: 1px solid var(--studioBorder); padding: 12px 0 24px; .fieldGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; .fullField { grid-column: 1 / -1; } } }
  .hint { color: var(--studioMuted); font-size: 13px; line-height: 1.7; }
  .errorMessage { color: var(--studioAttention); overflow-wrap: anywhere; }
  .fileLabel { max-width: 320px; }
  :deep(.el-button) { min-height: 40px; margin-left: 0; }
  :deep(.thumbnailItem) { min-width: 80px; min-height: 44px; }
  @media (max-width: 680px) { .roleRow, .speechLine .fieldGrid { grid-template-columns: 1fr; } }
}
</style>
