<template>
  <section class="storyPreview">
    <fieldset :disabled="busy">
    <p>先用草图、参考图与临时配音看完整节奏。未配图的场次使用明确标注的文字分镜卡；这份预演不代表正式成片。</p>
    <div class="toolbar">
      <label>草图模型<select v-model="imageKey"><option value="">选择已配置模型</option><option v-for="model in imageModels" :key="key(model)" :value="key(model)">{{ model.providerLabel }} · {{ model.label }}</option></select></label>
      <label>临时配音模型<select v-model="speechKey"><option value="">选择已配置模型</option><option v-for="model in speechModels" :key="key(model)" :value="key(model)">{{ model.providerLabel }} · {{ model.label }}</option></select></label>
      <label>音色<select v-if="speechModel?.voices?.length" v-model="voice"><option value="">选择音色</option><option v-for="item in speechModel.voices" :key="item.voice" :value="item.voice">{{ item.title }}</option></select><input v-else v-model="voice" /></label>
    </div>
    <p>生成草图和临时配音会调用所选服务并计费。每次生成一场、一张草图；每场可上传混好的对白音轨，台词不为空时须有音轨才导出。</p>
    <article v-for="(scene, index) in revision.scenes" :key="scene.sceneId">
      <h4>{{ scene.sceneId }} · {{ scene.title }}</h4>
      <p>{{ scene.speech || '此场无对白 / 旁白' }}</p>
      <label>时长（秒）<input v-model.number="boards[index]!.duration" type="number" min="1" max="180" step="0.1" /></label>
      <div class="toolbar">
        <label>分镜图片<input type="file" accept="image/png,image/jpeg,image/webp" @change="upload(index, 'image', $event)" /></label>
        <label>配音音轨<input type="file" accept="audio/wav,audio/mpeg,audio/mp4,audio/flac" @change="upload(index, 'audio', $event)" /></label>
        <el-button :disabled="busy || !scene.speech || !speechModel || !voice" @click="run(() => generateSpeech(index))">生成此场临时配音</el-button>
        <el-button :disabled="busy || !imageModel" @click="run(() => generateImage(index))">生成此场草图</el-button>
        <attachmentPreview v-for="kind in (['image', 'audio'] as const)" v-show="boards[index]?.[kind]" :key="kind" :directory="directory" :attachment="{ ...(boards[index]?.[kind] ?? { path: '', mimeType: 'text/plain' }), name: kind === 'image' ? '分镜图' : '临时音轨' }" />
        <el-button v-if="boards[index]?.image" :disabled="busy" @click="delete boards[index]!.image">移除图</el-button>
        <el-button v-if="boards[index]?.audio" :disabled="busy" @click="delete boards[index]!.audio">移除音轨</el-button>
      </div>
    </article>
    <div class="toolbar"><el-button @click="run(save)">保存预演方案</el-button><el-button @click="run(render)">合成带声音的预演 MP4</el-button></div>
    </fieldset>
    <el-button v-if="busy" @click="controller?.abort()">停止</el-button>
    <p role="status">{{ status }}</p><p v-if="error" role="alert">{{ error }}</p>
    <div class="toolbar"><attachmentPreview v-for="preview in previews" :key="preview.id" :directory="directory" :attachment="{ ...preview.media, name: `预演 ${preview.createdAt}${preview.sourceKey === storyPreviewKey(project, revision.id) ? '' : '（旧方案）'}` }" /></div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import axios from "axios";
import { useNodeAi, type NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";
import { createBrowserFfmpeg } from "@toonflow/ffmpeg/browser";
import { storyBoard, storyPreviewKey, type StoryAction, type StoryProject, type StoryRevision } from "@toonflow/tool-scene-list/storyProject";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import attachmentPreview from "@/components/agent/attachmentPreview.vue";

const props = defineProps<{ directory: string; project: StoryProject; revision: StoryRevision; apply: (action: StoryAction) => Promise<void> }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const directory = props.directory, files = useWorkspaceFiles(directory), ai = useNodeAi();
const boards = ref<typeof props.project.boards[string]>(JSON.parse(JSON.stringify(storyBoard(props.project, props.revision.id))));
const saved = ref(JSON.stringify(boards.value));
const busy = ref(false), status = ref(""), error = ref("");
const models = ref<NodeMediaModel[]>([]), speechKey = ref(""), voice = ref("");
const imageKey = ref("");
const key = (model: NodeMediaModel) => JSON.stringify([model.providerId, model.modelId]);
const speechModels = computed(() => models.value.filter(item => item.type === "audio"));
const speechModel = computed(() => speechModels.value.find(item => key(item) === speechKey.value));
const imageModels = computed(() => models.value.filter(item => item.type === "image"));
const imageModel = computed(() => imageModels.value.find(item => key(item) === imageKey.value));
const previews = computed(() => props.project.previews.filter(item => item.revisionId === props.revision.id));
let controller: AbortController | undefined;
watch(speechKey, () => { voice.value = ""; });
void ai.getMediaModels().then(value => { models.value = value; }).catch(cause => { error.value = cause.message; });
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; emit("busy", true); controller = new AbortController(); error.value = "";
  try { await action(); } catch (cause) { error.value = controller.signal.aborted ? "已停止，已保存的素材保留" : axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "预演失败"; }
  finally { busy.value = false; emit("busy", false); controller = undefined; }
}
async function folder() {
  for (const path of ["assets", "assets/story"]) await files.mkdir(path).catch(cause => { if (cause?.response?.data?.data?.code !== "EEXIST") throw cause; });
  const path = `assets/story/preview${crypto.randomUUID().replaceAll("-", "")}`;
  await files.mkdir(path); return path;
}
async function save() {
  await props.apply({ type: "board", revisionId: props.revision.id, values: boards.value });
  await nextTick();
  saved.value = JSON.stringify(boards.value); status.value = "预演方案已保存";
}
async function upload(index: number, kind: "image" | "audio", event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = "";
  if (!file) return;
  await run(async () => {
    const allowed: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/flac": "flac" };
    if (!allowed[file.type] || !file.type.startsWith(`${kind}/`) || !file.size || file.size > 100 * 1024 * 1024) throw new Error("请选择不超过 100 MB 的受支持图片或音频");
    const path = `${await folder()}/source.${allowed[file.type]}`;
    await files.write(path, file, true);
    boards.value[index]![kind] = { path, mimeType: file.type }; await save();
  });
}
async function generateSpeech(index: number) {
  const model = speechModel.value;
  if (!model || !voice.value) throw new Error("请选择配音模型和音色");
  const [audio] = await ai.generateAudio({ directory, providerId: model.providerId, modelId: model.modelId, voice: voice.value, prompt: props.revision.scenes[index]!.speech, format: "wav", outputDirectory: "assets/story" }, controller?.signal);
  if (!audio || audio.mediaType !== "audio") throw new Error("未返回音频");
  boards.value[index]!.audio = { path: audio.path, mimeType: audio.mimeType }; await save();
}
async function generateImage(index: number) {
  const model = imageModel.value, scene = props.revision.scenes[index]!;
  if (!model) throw new Error("请选择草图模型");
  const [image] = await ai.generateImage({ directory, providerId: model.providerId, modelId: model.modelId, outputDirectory: "assets/story", prompt: `绘制单张电影分镜草图，表现这一场最有代表性的可见行动。用于节奏预演，保持构图清晰，不添加标题、字幕、水印。作品风格：${props.revision.brief.tone}。场景：${scene.title}\n${scene.text}` }, controller?.signal);
  if (!image) throw new Error("没有返回草图");
  boards.value[index]!.image = { path: image.path, mimeType: image.mimeType }; await save();
}
function silence(seconds: number) {
  const bytes = new ArrayBuffer(44 + Math.ceil(seconds * 24000) * 2), view = new DataView(bytes);
  const write = (offset: number, value: string) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); write(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, bytes.byteLength - 44, true); return bytes;
}
async function render() {
  await save();
  const sourceKey = storyPreviewKey(props.project, props.revision.id), plan: typeof boards.value = JSON.parse(JSON.stringify(boards.value));
  if (plan.some((board, index) => props.revision.scenes[index]!.speech && !board.audio)) throw new Error("有台词的场次尚未配音，请生成或上传音轨");
  const ffmpeg = await createBrowserFfmpeg(directory, controller?.signal), output = await folder();
  const segments: string[] = [];
  for (const [index, board] of plan.entries()) {
    controller?.signal.throwIfAborted(); status.value = `正在合成第 ${index + 1} / ${plan.length} 场`;
    const scene = props.revision.scenes[index]!;
    if (board.audio) {
      const duration = await new Promise<number>((resolve, reject) => ffmpeg.ffprobe(board.audio!.path, (cause, data) => cause ? reject(cause) : resolve(Number(data.format.duration))));
      if (!Number.isFinite(duration) || duration > board.duration + 0.05) throw new Error(`${scene.sceneId} 音轨长于场次，请把时长调整到至少 ${Number.isFinite(duration) ? duration.toFixed(1) : "有效音轨时长"} 秒，避免截断台词`);
    }
    const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext("2d")!; context.fillStyle = "#171b21"; context.fillRect(0, 0, 1280, 720);
    if (board.image) {
      const url = files.acquireUrl(board.image.path, board.image.mimeType);
      try { const image = new Image(); image.src = await url.url; await image.decode(); const scale = Math.min(1280 / image.width, 560 / image.height); context.drawImage(image, (1280 - image.width * scale) / 2, 0, image.width * scale, image.height * scale); }
      finally { url.release(); }
    }
    const draw = (content: string, y: number, maxLines: number) => {
      const lines: string[] = []; let line = "";
      for (const char of content) { if (char === "\n" || context.measureText(line + char).width > 1160) { lines.push(line); line = char === "\n" ? "" : char; } else line += char; }
      if (line) lines.push(line);
      lines.slice(0, maxLines).forEach((line, index) => context.fillText(line + (index === maxLines - 1 && lines.length > maxLines ? "…" : ""), 60, y + index * 42));
    };
    context.fillStyle = "#fff"; context.font = "28px sans-serif";
    if (!board.image) draw(`文字分镜预演 · ${scene.title}\n${scene.text}`, 70, 10);
    context.fillStyle = "#171b21"; context.fillRect(0, 560, 1280, 160); context.fillStyle = "#fff";
    draw(`${scene.sceneId} · ${scene.title}\n${scene.speech}`, 600, 3);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("无法创建分镜卡")), "image/png"));
    const imagePath = `${output}/frame${index}.png`, audioPath = board.audio?.path ?? `${output}/silence${index}.wav`, videoPath = `${output}/scene${index}.mp4`;
    await files.write(imagePath, png, true);
    if (!board.audio) await files.write(audioPath, silence(board.duration), true);
    await new Promise<void>((resolve, reject) => ffmpeg().input(imagePath).inputOptions(["-loop 1", "-framerate 24"]).input(audioPath).videoCodec("libx264").audioCodec("aac").audioFrequency(24000).audioChannels(1).audioFilters(`apad=whole_dur=${board.duration}`).outputOptions([`-t ${board.duration}`, "-pix_fmt yuv420p", "-movflags +faststart"]).on("end", () => resolve()).on("error", reject).save(videoPath));
    segments.push(videoPath);
  }
  const command = ffmpeg(); segments.forEach(path => command.input(path));
  const path = `${output}/animatic.mp4`;
  await new Promise<void>((resolve, reject) => command.complexFilter(`${segments.map((_path, index) => `[${index}:v][${index}:a]`).join("")}concat=n=${segments.length}:v=1:a=1[v][a]`).outputOptions(["-map [v]", "-map [a]", "-pix_fmt yuv420p", "-movflags +faststart"]).videoCodec("libx264").audioCodec("aac").on("end", () => resolve()).on("error", reject).save(path));
  await props.apply({ type: "preview", revisionId: props.revision.id, sourceKey, media: { path, mimeType: "video/mp4" } });
  status.value = "预演已生成，请完整播放检查节奏、理解与声音；长台词在分镜卡中仅显示摘要，完整声音保留。";
}
async function flushSave() { if (busy.value) throw new Error("预演正在处理，请完成或停止后离开"); if (JSON.stringify(boards.value) !== saved.value) await save(); }
onScopeDispose(() => controller?.abort());
defineExpose({ flushSave });
</script>

<style scoped lang="scss">
.storyPreview { fieldset { border: 0; padding: 0; min-width: 0; } }
.storyPreview { p { line-height: 1.7; } .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin: 16px 0; } article { border-top: 1px solid var(--studioBorder); padding: 16px 0; } label { display: flex; flex-direction: column; gap: 8px; } input, select { min-height: 40px; max-width: 100%; color: var(--studioInk); background: var(--studioSurface); border: 1px solid var(--studioBorder); border-radius: 8px; padding: 8px; } [role="alert"] { color: var(--studioAttention); } }
</style>
