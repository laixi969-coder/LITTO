<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="660"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }">
    <template #topActions>
      <mediaHistory mediaType="video" :current="outputFile" :disabled="generating || deleting || uploading" @select="outputs.video = { dataType: 'VIDEO', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting" text title="替换视频" aria-label="替换视频" @click.stop="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="video/*" hidden aria-label="选择替换视频" :disabled="generating || deleting || uploading" @change="replaceOutput" />
    </template>
    <div v-loading="generating || uploading" class="videoContent nopan" :aria-busy="generating || uploading">
      <videoPlayer
        v-if="previewUrl"
        ref="player"
        :src="previewUrl"
        label="生成视频"
        @loadedmetadata="resizeVideo" />
      <div v-else class="videoEmpty" role="img" aria-label="暂无生成视频">
        <icon-camera-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <videoReferencePanel v-model="data.videoFrames" :references="refList" :mode="selectedMode" :editing="editing" :production="!!data.production" :disabled="generating || deleting || uploading" :error="referenceError" />
        <p v-if="editing && data.storyboard" class="referenceHint">已保存分镜仍保留；视频编辑模式沿用原片，不应用分镜编排。</p>
        <promptInput ref="promptEditor" v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加视频模型"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:duration="data.duration"
            v-model:resolution="data.resolution"
            v-model:ratio="data.ratio"
            :mode="data.mode"
            @update:mode="value => { data.modeExplicit = true; data.mode = value; }"
            v-model:generateAudio="data.generateAudio"
            :ratios="ratioOptions"
            :resolutions="resolutionOptions"
            :model="selectedModel"
            :disabled="generating || deleting || !selectedModel" />
          <promptTools :text="data.prompt" mediaType="video" :request="generationInput" :preview="workshopBasePrompt" :disabled="generating || deleting || uploading" @append="promptEditor?.appendText($event)" @replace="promptEditor?.replaceText($event)" @expand="promptEditor?.expand()" @busy="toolsBusy = $event" />
          <storyboardEditor :count="data.storyboard?.shots.length" :duration="data.duration" :production="!!data.production" :disabled="editing || generating || deleting || uploading || toolsBusy" :references="storyboard.mentions.value" :load="storyboard.load" :save="saveStoryboard" :clear="!data.production && data.storyboard ? clearStoryboard : undefined" :validate="storyboard.validate" :preview="storyboard.textPreview" @busy="storyboardBusy = $event" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || toolsBusy || storyboardBusy || (!generating && ((!data.production && !generationPrompt) || !selectedModel))"
            :title="generating ? '停止生成' : '生成视频'"
            :aria-label="generating ? '停止生成' : '生成视频'"
            @click="generating ? cancelGeneration().catch((error) => showNodeError(error, '停止生成失败')) : startGeneration(true).catch((error) => showNodeError(error, '视频生成失败'))" />
        </div>
        <p v-if="!editing && data.storyboard" class="referenceHint">已保存 {{ data.storyboard.shots.length }} 镜 · {{ data.storyboard.shots.at(-1)?.end }} 秒，生成时采用当前编排。</p>
        <p v-if="storyboardError" class="storyboardError" role="alert">{{ storyboardError }}</p>
        <details v-if="data.storyboard" class="generationPreview"><summary>查看生成内容{{ data.production ? '（正式镜头编译预览）' : '（包含分镜编排）' }}</summary><pre>{{ data.production ? storyboard.preview.value || '请打开分镜编排，保存后重新编译以查看正式镜头发送内容。' : generationPrompt }}</pre></details>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading } from "element-plus";
import { IconCameraAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer } from "@tabler/icons-vue";
import { compileVisualModifiers, type VisualModifiers, cameraTrajectorySchema, videoDurations, groupNodeModels, nodeSkeleton, nodeTools, showNodeError, useNode, useNodeGeneration, useNodeReferences, z, videoStoryboardSchema, compileVideoStoryboard, storyboardGenerateAudio, type VideoStoryboard, type NodeMediaModel, type NodeVideoRequest, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import promptInput from "@toonflow/nodes-scaffold/promptInput";
import promptTools from "@toonflow/nodes-scaffold/promptTools";
import videoPlayer from "@toonflow/nodes-scaffold/videoPlayer";
import referenceItem from "@toonflow/nodes-scaffold/referenceItem";
import mediaHistory from "@toonflow/nodes-scaffold/mediaHistory";
import generationSettings from "./components/generationSettings.vue";
import storyboardEditor from "./components/storyboardEditor.vue";
import videoReferencePanel from "./components/videoReferencePanel.vue";
import { readVideoFrames, referenceKey, validateVideoReferences, type VideoFrames } from "./videoReferences";
import { useStoryboard } from "./useStoryboard";

defineOptions({
  inheritAttrs: false,
  icon: IconCameraAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const promptEditor = ref<InstanceType<typeof promptInput>>();
const toolsBusy = ref(false);
const storyboardBusy = ref(false);
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "视频生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { videoFrames?: VideoFrames; modeExplicit?: boolean; visualModifiers?: VisualModifiers; storyboard?: VideoStoryboard; storyboardReferences?: { source: string; sourceHandle: string }[]; storyboardTimeline?: string; purpose?: "asset" | "standalone"; production?: { shotId: string; productionFingerprint: string }; cameraTrajectory?: NodeVideoRequest["cameraTrajectory"]; imageAndCameraOnly?: boolean; generationPending?: boolean; generationJobId?: string; generationRequest?: { requestId: string; input: NodeVideoRequest }; prompt: string; promptModel: PromptModel; model: string; duration?: number; durationReason?: string; resolution: string; ratio: string; mode: string; generateAudio: boolean });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.resolution ??= "";
data.value.mode ??= "";
data.value.generateAudio ??= false;
data.value.ratio ??= "";
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
let disposed = false;
const deleting = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const videoWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, () => { void cancelGeneration().catch(error => showNodeError(error, "停止生成失败")); });
const { generating } = generationState;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const ratioOptions = computed(() => getRatios(selectedModel.value));
const resolutionOptions = computed(() => selectedModel.value ? getResolutions(selectedModel.value) : []);
const selectedMode = computed(() => selectedModel.value?.mode?.find((item) => JSON.stringify(item) === data.value.mode) as NodeVideoRequest["mode"]);
const editing = computed(() => selectedModel.value?.videoTask === "edit");
const frameMode = computed(() => ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(selectedMode.value)));
const frames = computed(() => readVideoFrames(refList.value, selectedMode.value, data.value.videoFrames));
// ACT: 首次迁移沿用旧顺序，随后固定素材来源；拖动参考列表不再隐式交换首尾帧。
watch([frameMode, () => refList.value.map(referenceKey).join("|")], () => {
  if (frameMode.value && !data.value.production && !data.value.videoFrames && refList.value.some(item => item.dataType === "IMAGE")) data.value.videoFrames = frames.value.bindings;
}, { immediate: true, flush: "sync" });
const referenceError = computed(() => { if (data.value.production || !selectedModel.value) return ""; try { validateVideoReferences(refList.value, selectedMode.value, data.value.videoFrames); return ""; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } });
const mediaCounts = computed(() => ({
  image: refList.value.filter((item) => item.dataType === "IMAGE").length,
  video: refList.value.filter((item) => item.dataType === "VIDEO").length,
  audio: refList.value.filter((item) => item.dataType === "AUDIO").length,
}));
const matchingModes = computed(() => getMatchingModes(selectedModel.value));

function getMatchingModes(choice?: NodeMediaModel) {
  if (data.value.production) return choice?.mode ?? [];
  return (choice?.mode ?? []).filter((mode) => {
    const { image, video, audio } = mediaCounts.value;
    if (Array.isArray(mode)) return image + video + audio > 0 && Object.entries(mediaCounts.value).every(([type, count]) =>
      count <= Number(mode.find((item) => item.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0)
    );
    if (mode === "text") return image + video + audio === 0;
    if (video || audio) return false;
    if (mode === "singleImage") return image === 1;
    if (mode === "startEndRequired") return image === 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && image >= 1 && image <= 2;
  });
}

function getRatios(choice?: NodeMediaModel) {
  // ACT: 未声明比例时保留原有通用选项，最终仍由供应商核验。
  return choice?.videoRatios?.length ? choice.videoRatios : ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21", "20:11"];
}
function getResolutions(choice: NodeMediaModel, duration?: number) {
  // ACT: 保留供应商档位顺序，不把 2K 当作数字 2 排在 480P 前面。
  return [...new Set((choice.durationResolutionMap ?? []).filter((item) => duration === undefined || item.duration.includes(duration)).flatMap((item) => item.resolution))];
}
// ACT: 引用改变时只替换不适用的模式；普通媒体优先作为参考，避免自动变成首尾帧。
watch([selectedModel, matchingModes, () => data.value.mode], ([choice, matches]) => {
  if (!choice || matches.some((item) => JSON.stringify(item) === data.value.mode) || data.value.modeExplicit && choice.mode?.some(item => JSON.stringify(item) === data.value.mode)) return;
  const modes = choice.mode ?? [];
  const mode = matches.find(Array.isArray) ?? matches.find((item) => item === "singleImage")
    ?? matches.find((item) => item === "endFrameOptional") ?? matches[0]
    ?? modes.find((item) => JSON.stringify(item) === data.value.mode) ?? modes.find(Array.isArray) ?? modes[0];
  data.value.mode = mode === undefined ? "" : JSON.stringify(mode);
}, { flush: "sync" });
// ACT: 参数在节点内归一化，未选中、未挂载底部设置时也可由 Agent 直接生成。
watch([selectedModel, () => data.value.duration, () => data.value.resolution], ([choice]) => {
  if (!choice) return;
  const resolutions = getResolutions(choice);
  if (!resolutions.includes(data.value.resolution)) data.value.resolution = resolutions[0] ?? "";
  if (choice.videoTask === "edit") return;
  const durations = videoDurations(choice, data.value.resolution);
  if (!durations.includes(data.value.duration!)) data.value.duration = durations.at(-1);
}, { flush: "sync" });
const modelGroups = computed(() => groupNodeModels(models.value));
function resolveReferenceText(value: string) {
  return value.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
      const index = Number(number) - 1;
      const reference = refList.value[index];
      if (!reference) return marker;
      const position = refList.value.slice(0, index + 1).filter(item => item.dataType === reference.dataType).length;
      if (reference.dataType === "IMAGE" && frameMode.value) return frames.value.first && referenceKey(reference) === referenceKey(frames.value.first) ? "首帧图片" : frames.value.last && referenceKey(reference) === referenceKey(frames.value.last) ? "尾帧图片" : "未分配图片";
      const labels: Record<string, string> = { IMAGE: "图片", VIDEO: "视频", AUDIO: "音频", STRING: "文字参考" };
      const label = typeof reference.dataType === "string" ? labels[reference.dataType] : undefined;
      return label ? `${label}${position}` : marker;
    });
}
const baseGenerationPrompt = computed(() =>
  [
    resolveReferenceText(data.value.prompt.trim()),
    ...refList.value.filter(item => item.dataType === "STRING").flatMap((item, index) => (typeof item.value === "string" && item.value.trim() ? [`文字参考${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const storyboard = useStoryboard({ data, references: refList, mentions: referenceMentions, model: selectedModel, duration: computed(() => data.value.duration), mode: selectedMode,
  basePrompt: baseGenerationPrompt, resolveText: resolveReferenceText, request: () => generationInput(), directory: async () => (await files.getWorkspaceFiles().list()).directory });
const storyboardError = computed(() => { try { if (!editing.value && data.value.storyboard) storyboard.validate(data.value.storyboard); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); } });
const workshopBasePrompt = computed(() => compileVideoStoryboard(baseGenerationPrompt.value, !editing.value && data.value.storyboard ? storyboard.resolve(data.value.storyboard) : undefined));
const generationPrompt = computed(() => { try { return data.value.production ? storyboard.preview.value || baseGenerationPrompt.value : compileVisualModifiers(workshopBasePrompt.value, data.value.visualModifiers, editing.value ? [] : data.value.storyboard?.shots); } catch { return ""; } });
watch(() => [data.value.model, data.value.duration, data.value.resolution, data.value.ratio, data.value.mode, data.value.generateAudio, data.value.production?.shotId, JSON.stringify(data.value.visualModifiers)], () => { storyboard.preview.value = ""; }, { flush: "sync" });
async function saveStoryboard(plan: VideoStoryboard) {
  await storyboard.save(plan);
  const preview = storyboard.preview.value;
  if (selectedModel.value?.audio === "optional") data.value.generateAudio = storyboardGenerateAudio(plan, "optional", data.value.generateAudio) ?? false;
  storyboard.preview.value = preview;
}
function clearStoryboard() { if (!data.value.production) { data.value.storyboard = undefined; storyboard.preview.value = ""; } }
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, "视频读取失败")
);

onMounted(() => {
  void loadModels().catch((error) => showNodeError(error, "模型读取失败"));
  if (data.value.generationPending) resumeGeneration();
});
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || disposed) return;
  if (!file.type.startsWith("video/")) return void showNodeError("请选择视频文件", "视频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("视频不能为空且不能超过 100 MB", "视频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 保留历史输出文件，避免破坏撤销记录和复制节点的引用。
    outputs.value.video = { dataType: "VIDEO", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "视频替换失败");
  } finally {
    uploading.value = false;
  }
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then(async (items) => {
    if (deleting.value) return;
    if (!data.value.ratio) {
      const workspace = files.getWorkspaceFiles();
      const { entries } = await workspace.list();
      const preferences = entries.some(item => item.name === "mediaPreferences.json") ? z.object({ videoRatio: z.string().regex(/^$|^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional() }).parse(await workspace.readJson("mediaPreferences.json")) : {};
      if (disposed || deleting.value) return;
      if (!data.value.ratio) data.value.ratio = preferences.videoRatio || "9:16";
    }
    models.value = items.filter((item) => item.type === "video");
    // 运行列表只包含用户在设置中授权的默认模型。
    if (!models.value.some(item => JSON.stringify([item.providerId, item.modelId]) === data.value.model)) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration(manual = false) {
  if (toolsBusy.value || storyboardBusy.value) throw new Error("请先结束提示词编辑或分镜保存");
  const choice = selectedModel.value;
  if (generating.value) throw new Error("视频正在生成，请等待完成");
  if (uploading.value) throw new Error("视频正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (!choice) throw new Error("请先选择视频模型");
  if (!editing.value && data.value.storyboard) storyboard.validate(data.value.storyboard);
  if (!data.value.production) validateVideoReferences(refList.value, selectedMode.value, data.value.videoFrames);
  if (!editing.value && data.value.storyboard && selectedModel.value?.audio === "optional" && !data.value.generateAudio && [data.value.storyboard.music, data.value.storyboard.soundEffects].includes("on")) throw new Error("分镜要求生成声音，但模型音频已关闭；请开启音频或修改分镜声音设置");
  if (!editing.value && !data.value.duration) throw new Error("请先按完整剧情段落选择生成时长");
  if (!getResolutions(choice, editing.value ? undefined : data.value.duration).includes(data.value.resolution)) throw new Error("当前模型不支持所选时长与分辨率组合，请重新选择");
  if (!editing.value && !ratioOptions.value.includes(data.value.ratio)) throw new Error(`当前模型不支持比例 ${data.value.ratio}，可选：${ratioOptions.value.join("、")}`);
  if (choice.cameraTrajectory && (!data.value.cameraTrajectory || !data.value.imageAndCameraOnly)) throw new Error("请先通过 setCameraTrajectory 配置并校准轨迹，或在镜头制作面板导入轨迹");
  if (!data.value.production && !generationPrompt.value) throw new Error("请输入生成提示词");
  if (!data.value.production && /\{\{ref \d+\}\}/.test(generationPrompt.value)) throw new Error("提示词含未绑定的参考标记，请重新连接资产并写入提示词");
  if (!data.value.production && refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  if (choice.mode?.length && !matchingModes.value.some(mode => JSON.stringify(mode) === data.value.mode)) throw new Error("当前模式不适用于这些参考素材，请更换模式或调整引用");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  const input = generationInput(manual);
  generationController = controller;
  data.value.generationPending = true;
  data.value.generationJobId = undefined;
  generation = observeGeneration(() => workspace.list().then(({ directory }) => {
    controller.signal.throwIfAborted();
    const pending = { requestId: crypto.randomUUID(), input: { ...input, directory } };
    data.value.generationRequest = pending;
    return ai.generateVideo(pending.input, controller.signal, rememberJob, pending.requestId);
  }), controller);
  return { status: "generating" };
}

function generationInput(manual = false): Omit<NodeVideoRequest, "directory"> {
  const choice = selectedModel.value;
  if (!choice) throw new Error("请先选择视频模型");
  const references = data.value.production ? [] : refList.value;
  const images = references.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const audio = choice.audio === "optional" ? data.value.generateAudio : choice.audio === true ? true : undefined;
  return {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: baseGenerationPrompt.value,
    storyboard: editing.value ? undefined : storyboard.generationPlan(),
    visualModifiers: data.value.visualModifiers,
    ...data.value.production,
    purpose: data.value.purpose,
    mode: selectedMode.value,
    duration: editing.value ? undefined : data.value.duration,
    durationReason: data.value.durationReason || (manual ? `用户按视频节点当前配置明确发起 ${data.value.duration} 秒生成` : undefined),
    resolution: data.value.resolution || undefined,
    ratio: editing.value ? undefined : data.value.ratio,
    generateAudio: !editing.value && data.value.storyboard ? storyboardGenerateAudio(data.value.storyboard, choice.audio, audio) : audio,
    outputDirectory: `assets/${id}`,
    images: frameMode.value || choice.cameraTrajectory ? undefined : images,
    firstFrame: choice.cameraTrajectory ? images[0] : !data.value.production && frameMode.value && frames.value.first?.dataType === "IMAGE" && frames.value.first.value ? { path: frames.value.first.value.url, mimeType: frames.value.first.value.mimeType } : undefined,
    ...(choice.cameraTrajectory ? { cameraTrajectory: data.value.cameraTrajectory, imageAndCameraOnly: data.value.imageAndCameraOnly } : {}),
    lastFrame: !data.value.production && frameMode.value && frames.value.last?.dataType === "IMAGE" && frames.value.last.value ? { path: frames.value.last.value.url, mimeType: frames.value.last.value.mimeType } : undefined,
    videos: references.flatMap((item) => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    audios: references.flatMap((item) => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
  };
}

function rememberJob(jobId: string) {
  data.value.generationJobId = jobId;
  data.value.generationRequest = undefined;
}

function observeGeneration(task: () => Promise<{ path: string; mimeType: string }[]>, controller: AbortController) {
  return generationState.run(async () => {
    const [result] = await task();
    controller.signal.throwIfAborted();
    if (!result) throw new Error("供应商未返回视频");
    outputs.value.video = { dataType: "VIDEO", value: { url: result.path, mimeType: result.mimeType } };
  }).catch(error => { if (!disposed) showNodeError(error, "视频生成失败"); }).finally(() => {
    if (!disposed) { data.value.generationPending = false; data.value.generationRequest = undefined; }
    generationController = undefined;
  });
}

function resumeGeneration() {
  const controller = new AbortController();
  generationController = controller;
  const pending = data.value.generationRequest;
  const jobId = data.value.generationJobId;
  generation = observeGeneration(() => jobId ? ai.waitMediaJob(jobId, controller.signal)
    : pending ? ai.generateVideo(pending.input, controller.signal, rememberJob, pending.requestId)
    : Promise.reject(new Error("未找到已保存的生成任务")), controller);
}

async function cancelGeneration() {
  const pending = data.value.generationRequest;
  // 请求已经发送而 ID 尚未返回时，利用同一幂等键找回任务，再停止。
  if (!data.value.generationJobId && pending) {
    const result = await ai.cancelMediaRequest("video", pending);
    if (result.jobId) rememberJob(result.jobId);
  }
  if (data.value.generationJobId) await ai.cancelMediaJob(data.value.generationJobId);
  generationController?.abort();
}

nodeEvent.on("copy", () => ({ generationPending: false, generationJobId: undefined, generationRequest: undefined }));

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value)) throw new Error("视频处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("视频正在替换，请稍后删除节点");
  deleting.value = true;
  try {
    if (generating.value) await cancelGeneration();
    await generation;
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.min(480, Math.max(220, (240 * video.videoWidth) / video.videoHeight));
  await nextTick();
  updateNodeInternals();
}

function getConfig() {
  storyboard.syncReferences();
  return {
    prompt: data.value.prompt,
    storyboard: data.value.storyboard,
    storyboardReferences: data.value.storyboardReferences,
    storyboardError: storyboardError.value,
    videoFrames: data.value.videoFrames,
    referenceError: referenceError.value,
    generationPrompt: generationPrompt.value,
    references: refList.value.map((item, index) => ({
      marker: `{{ref ${index + 1}}}`,
      source: item.source,
      sourceHandle: item.sourceHandle,
      dataType: item.dataType,
      ready: item.value !== undefined,
    })),
    config: {
      visualModifiers: data.value.visualModifiers,
      production: data.value.production,
      purpose: data.value.purpose,
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      duration: data.value.duration,
      durationReason: data.value.durationReason,
      resolution: data.value.resolution,
      ratio: data.value.ratio,
      mode: selectedMode.value,
      generateAudio: selectedModel.value?.audio === "optional" ? data.value.generateAudio : selectedModel.value?.audio === true ? true : undefined,
      cameraTrajectory: data.value.cameraTrajectory,
      imageAndCameraOnly: data.value.imageAndCameraOnly,
    },
    models: models.value,
    ratios: ratioOptions.value,
    matchingModes: matchingModes.value,
    maxSingleGenerationDuration: selectedModel.value ? videoDurations(selectedModel.value, data.value.resolution).at(-1) : undefined,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取当前提示词、实际连接的参考及其 {{ref N}} 标记、配置和模型能力，不含密钥；先连接资产再按 references 写入引用，回读核对 source 与 ready；时长与分辨率须符合 durationResolutionMap",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此视频生成节点的模型、时长、分辨率、比例、模式或声音；先用 getConfig 查询能力，providerId 与 modelId 必须同时提供。正式镜头同时传 production 绑定和编译返回的配置，模式与参考由服务器核验；独立素材的 mode 须匹配画布引用。不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    duration: z.number().positive().optional(),
    durationReason: z.string().trim().min(3).max(500).optional(),
    resolution: z.string().min(1).optional(),
    ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
    mode: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    generateAudio: z.boolean().optional(),
    production: z.strictObject({ shotId: z.string().min(1), productionFingerprint: z.string().min(1) }).optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效视频模型");
    const ratios = getRatios(choice);
    if (!ratios.includes(args.ratio ?? data.value.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio ?? data.value.ratio}，可选：${ratios.join("、")}`);
    const targetResolution = args.resolution ?? (getResolutions(choice).includes(data.value.resolution) ? data.value.resolution : undefined);
    const durations = videoDurations(choice, targetResolution);
    if (args.duration !== undefined && !durations.includes(args.duration)) throw new Error(`当前模型不支持时长 ${args.duration}，可选：${durations.join("、")}`);
    const duration = args.duration ?? (data.value.durationReason && durations.includes(data.value.duration!) ? data.value.duration : durations.at(-1));
    const durationReason = args.durationReason ?? (duration === data.value.duration ? data.value.durationReason : undefined);
    if (duration !== undefined && duration < (durations.at(-1) ?? 0) && !durationReason) throw new Error("短于模型当前分辨率上限须提供 durationReason：用户指定短样片、段落收尾或必要拆分/修复依据；默认选择最大时长");
    const resolutions = getResolutions(choice, duration);
    if (args.resolution !== undefined && !resolutions.includes(args.resolution)) throw new Error(`当前时长不支持分辨率 ${args.resolution}，可选：${resolutions.join("、")}`);
    const resolution = args.resolution ?? (resolutions.includes(data.value.resolution) ? data.value.resolution : resolutions[0] ?? "");
    const modes = args.production ? choice.mode ?? [] : getMatchingModes(choice);
    if (args.mode !== undefined && !modes.some((item) => JSON.stringify(item) === JSON.stringify(args.mode))) throw new Error("所选模式不受当前模型支持或不适用于当前引用，请根据模型能力及已连接素材选择");
    if (args.generateAudio !== undefined && choice.audio !== "optional" && args.generateAudio !== (choice.audio === true)) throw new Error("当前模型不支持切换声音，请查看 getConfig 返回的 audio 能力");
    if (args.production) { data.value.production = args.production; data.value.purpose = undefined; }
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    data.value.duration = duration;
    data.value.durationReason = durationReason;
    data.value.resolution = resolution;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    if (args.mode !== undefined) data.value.mode = JSON.stringify(args.mode);
    if (args.generateAudio !== undefined) data.value.generateAudio = args.generateAudio;
    return getConfig();
  },
});

nodeTools.register({
  name: "setStoryboard",
  description: "设置独立视频节点的结构化分镜，最多8镜，时间连续且覆盖生成时长。引用标记使用getConfig的storyboardReferences槽位，不能按当前素材顺序猜测。正式镜头请在节点编排器保存到项目时间线，或用productionSpec updateShot和compile。只保存，不生成。",
  parameters: z.strictObject({ storyboard: videoStoryboardSchema }),
  async execute(args) {
    if (generating.value || deleting.value || storyboardBusy.value) throw new Error("节点正在处理，请稍后修改分镜");
    if (data.value.production) throw new Error("正式镜头请更新项目时间线并重新编译");
    storyboardBusy.value = true;
    try { await storyboard.load(); await saveStoryboard(args.storyboard); return getConfig(); }
    finally { storyboardBusy.value = false; }
  },
});

nodeTools.register({
  name: "setCameraTrajectory",
  description: "为支持 cameraTrajectory 的已选模型设置 3D 导演台导出的轨迹。先校准 translationScale 并核对首帧；imageAndCameraOnly 必须明确为 true，表示不支持逐请求文字表演/音频。只配置，不生成。",
  parameters: z.strictObject({ cameraTrajectory: cameraTrajectorySchema, imageAndCameraOnly: z.literal(true) }),
  execute(args) {
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除");
    if (!selectedModel.value?.cameraTrajectory) throw new Error("当前模型不支持数值轨迹");
    data.value.cameraTrajectory = args.cameraTrajectory;
    data.value.imageAndCameraOnly = args.imageAndCameraOnly;
    return getConfig();
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的视频生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    for (const match of value.matchAll(/\{\{ref (\d+)\}\}/g)) {
      const reference = refList.value[Number(match[1]) - 1];
      if (!reference || reference.value === undefined) throw new Error(`参考 ${match[1]} 未连接或暂无内容，请先连接对应资产`);
    }
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    return { prompt: value };
  },
});

nodeTools.register({
  name: "generateVideo",
  description: "正式镜头先 productionSpec compile，传 production:{shotId,productionFingerprint:返回的fingerprint}，节点配置须与编译 request 一致；服务器使用编译的表演、对白与参考，规格变化须重编译。独立定妆传 purpose:asset，独立画面传 purpose:standalone，不关联镜头。启动此节点的后台视频生成，使用当前提示词、模型、模式、时长、分辨率、比例和参考素材；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 停止生成",
  parameters: z.strictObject({ purpose: z.enum(["asset", "standalone"]).optional(), production: z.strictObject({ shotId: z.string().min(1), productionFingerprint: z.string().min(1) }).optional() }),
  execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || uploading.value || deleting.value) throw new Error("节点正在生成、替换或删除，请稍后再试");
    if (args.production && args.purpose) throw new Error("镜头绑定与独立素材用途不能同时指定");
    if (args.production || args.purpose) {
      data.value.production = args.production;
      data.value.purpose = args.purpose;
    }
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.storyboardError { color: var(--el-color-danger); font-size: 13px; }
.generationPreview { margin-top: 10px; summary { cursor: pointer; } pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow: auto; font: inherit; line-height: 1.6; } }
.videoContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .videoEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.promptCard {
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .promptFooter {
    flex-wrap: wrap;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}
</style>
