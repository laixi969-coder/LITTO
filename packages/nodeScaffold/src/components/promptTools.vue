<template>
  <div class="promptTools nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
    <el-button text :disabled="disabled" :aria-pressed="selecting" aria-label="从画布选择参考" @click="selecting = !selecting"><icon-plus :size="17" /></el-button>
    <el-popover trigger="click" placement="top" :width="320" :disabled="disabled">
      <template #reference><el-button text :disabled="disabled">词库</el-button></template>
      <div class="promptLibrary nodrag nopan nowheel" @pointerdown.stop @wheel.stop>
        <el-input v-model="query" placeholder="搜索创作任务" aria-label="搜索词库" clearable />
        <button v-for="item in filteredPresets" :key="item.name" type="button" @click="append(item.text)"><strong>{{ item.name }}</strong><span>{{ item.text }}</span></button>
      </div>
    </el-popover>
    <el-button text :disabled="disabled" title="镜头、配色与风格" @click="openWorkshop">镜头工坊</el-button>
    <el-button text :disabled="disabled" aria-label="专注编辑提示词" @click="emit('expand')"><icon-maximize :size="17" /></el-button>
    <el-button text :disabled="disabled || !text.trim() || enhancing" :loading="enhancing" aria-label="增强提示词" title="增强提示词，审阅后应用" @click="enhance"><icon-sparkles :size="17" /></el-button>
    <el-button text :disabled="disabled || !speechAvailable" :aria-pressed="listening" :aria-label="listening ? '停止语音输入' : '语音输入'" :title="speechAvailable ? '语音输入' : '当前环境不支持语音识别，请使用系统听写'" @click="toggleSpeech"><icon-microphone :size="17" /></el-button>
  </div>
  <teleport to="body">
    <div v-if="selecting" class="referencePicker" role="status">点击画布中的图片、视频或文本节点添加参考。<el-button @click="stopSelecting">完成</el-button><span>{{ referenceMessage }}</span></div>
  </teleport>
  <el-dialog v-model="workshopVisible" title="镜头工坊" width="min(720px, 94vw)" top="4vh" appendToBody :closeOnClickModal="false" :showClose="!savingWorkshop && !assetBusy" :closeOnPressEscape="!savingWorkshop && !assetBusy">
    <div class="cameraWorkshop nodrag nopan nowheel" :inert="savingWorkshop || assetBusy" @pointerdown.stop>
      <div class="cameraFields"><label v-for="option in cameraOptions" :key="option.key">{{ option.label }}<el-select v-model="camera[option.key]" :aria-label="option.label"><el-option v-for="value in option.values" :key="value" :label="value" :value="value === '自动' ? '' : value" /></el-select></label></div>
      <visualAssetPicker v-model="draft" :active="workshopVisible" :disabled="savingWorkshop || assetBusy" @busy="assetBusy = $event" />
      <label>配色<el-select v-model="color" aria-label="配色"><el-option label="自动" value="" /><el-option v-if="draft.palette" :label="draft.palette.name" :value="draft.color" /><el-option v-for="item in colorPresets" :key="item.name" :label="item.name" :value="item.text" /></el-select></label>
      <div class="colorPalette" aria-label="配色示意"><span v-for="hex in draft.palette?.colors ?? colorPresets.find(item => item.text === color)?.colors" :key="hex" :style="{ background: hex }" :title="hex" /></div>
      <label>风格<el-select v-model="style" aria-label="风格"><el-option label="自动" value="" /><el-option v-if="draft.styleReference" :label="draft.styleReference.name" :value="draft.style" /><el-option v-for="item in stylePresets" :key="item.name" :label="item.name" :value="item.text" /></el-select></label>
      <visualStylePicker v-model="draft" :active="workshopVisible" :disabled="savingWorkshop || assetBusy" />
      <label>生成内容预览<el-input :modelValue="compiledPreview || workshopText" type="textarea" :rows="5" readonly aria-label="镜头工坊提示词预览" /></label>
      <template v-if="mediaType === 'video'"><label>全局运镜（最多 5 项，按列表顺序执行）<el-select modelValue="" aria-label="添加全局运镜" :disabled="draft.motions.length >= 5" @change="addMotion"><el-option v-for="item in motionOptions" :key="item.id" :label="item.label" :value="item.id" :disabled="draft.motions.some(value => value.id === item.id)" /></el-select></label><ol class="motionList"><li v-for="(item, index) in draft.motions" :key="item.id"><span>{{ index + 1 }}. {{ item.label }}</span><el-button :disabled="!index" @click="moveMotion(index, -1)">上移</el-button><el-button :disabled="index === draft.motions.length - 1" @click="moveMotion(index, 1)">下移</el-button><el-button @click="draft.motions.splice(index, 1)">移除</el-button></li></ol></template><p>修饰独立保存，不改写正文。逐镜焦距、光圈和运镜优先，全局对应设置仅用于未指定该字段的分镜。风格和配色作用于整段，沿用人物与资产约束。文字引导效果须看生成结果。</p><p v-if="workshopError" role="alert">{{ workshopError }}</p>
    </div>
    <template #footer><el-button :disabled="savingWorkshop || assetBusy" @click="resetWorkshop">恢复自动</el-button><el-button :disabled="savingWorkshop || assetBusy" @click="workshopVisible = false">关闭</el-button><el-button type="primary" :disabled="disabled || savingWorkshop || assetBusy" :loading="savingWorkshop" @click="saveWorkshop">保存设置并预览</el-button></template>
  </el-dialog>
  <el-dialog v-model="enhanceVisible" title="审阅增强后的提示词" width="min(720px, 94vw)" appendToBody :closeOnClickModal="false" @closed="enhanceController?.abort()">
    <div class="promptEnhancement"><label v-if="models.length > 1">增强模型<el-select v-model="languageModel" aria-label="提示词增强模型"><el-option v-for="model in models" :key="JSON.stringify([model.providerId, model.modelId])" :label="model.label" :value="JSON.stringify([model.providerId, model.modelId])" /></el-select></label><el-button v-if="models.length > 1 && !enhancedText && !enhancing" @click="runEnhancement">开始增强</el-button><p v-if="enhancing" role="status">正在增强，可取消；原提示词保留。</p><el-input v-model="enhancedText" type="textarea" :rows="12" :disabled="enhancing" aria-label="增强后的提示词" /></div>
    <template #footer><el-button @click="enhanceController?.abort(); enhanceVisible = false">取消</el-button><el-button type="primary" :disabled="disabled || enhancing || !enhancedText.trim()" @click="applyEnhanced">应用修改</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import visualAssetPicker from "./visualAssetPicker.vue";
import visualStylePicker from "./visualStylePicker.vue";
import { computed, onScopeDispose, ref, watch } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElDialog, ElInput, ElMessage, ElOption, ElPopover, ElSelect } from "element-plus";
import { IconPlus, IconMaximize, IconSparkles, IconMicrophone } from "@tabler/icons-vue";
import { useNodeAi, type NodeAiModel } from "../nodeAi";
import { useNodeFiles } from "../workspaceFiles";
import { validateConnection } from "../connection";
import { isNodeOutput } from "../values";
import { filmTechniques } from "@toonflow/tool-media-generation/filmTechniques";
import { visualModifiersSchema, compileVisualModifiers, type VisualModifiers, type MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { promptPresets, cameraOptions, colorPresets, stylePresets } from "../promptPresets";

const props = defineProps<{ text: string; mediaType: "image" | "video"; disabled?: boolean; request?: () => Omit<MediaGenerationRequest, "directory">; preview?: string }>();
const emit = defineEmits<{ append: [text: string]; replace: [text: string]; expand: []; busy: [value: boolean] }>();
const { id, node } = useNode();
const flow = useVueFlow();
const ai = useNodeAi(), files = useNodeFiles();
const query = ref("");
const filteredPresets = computed(() => promptPresets.filter(item => item.media === props.mediaType && `${item.name}${item.text}`.includes(query.value.trim())));
function append(value: string) { if (!props.disabled && value.trim()) emit("append", value); }
const selecting = ref(false), referenceMessage = ref("");
function stopSelecting() { selecting.value = false; flow.removeSelectedNodes(flow.nodes.value.filter(item => item.selected)); flow.addSelectedNodes([node]); }
function pickReference(event: MouseEvent) {
  const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".vue-flow__node[data-id]") : null;
  const sourceNode = element?.dataset.id ? flow.findNode(element.dataset.id) : undefined;
  if (!selecting.value || !sourceNode || sourceNode.id === id) return;
  // ACT: 先拦截选中行为，避免底部工具随节点失焦卸载；只处理当前画布内的参考节点。
  if (!flow.vueFlowRef.value?.contains(element)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type !== "click") return;
  const handles = sourceNode.data.handles ?? [];
  const candidates = handles.filter((handle: { type: string }) => handle.type === "source").map((handle: { id: string }) => ({ source: sourceNode.id, sourceHandle: handle.id, target: id, targetHandle: "in" }));
  const connection = candidates.find((candidate: { sourceHandle: string }) => isNodeOutput(sourceNode.data.outputs?.[candidate.sourceHandle]) && validateConnection(candidate as Parameters<typeof validateConnection>[0], { sourceNode, targetNode: node } as Parameters<typeof validateConnection>[1]));
  if (!connection) { referenceMessage.value = "此节点暂无可用的兼容输出"; return; }
  if (flow.edges.value.some(edge => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle && edge.target === id && edge.targetHandle === "in")) { referenceMessage.value = "该参考已经连接"; return; }
  flow.addEdges([{ ...connection, id: crypto.randomUUID() }]);
  referenceMessage.value = `已添加：${sourceNode.data.label || sourceNode.id}`;
}
function escapeSelection(event: KeyboardEvent) { if (event.key === "Escape" && selecting.value) stopSelecting(); }
watch(selecting, value => {
  referenceMessage.value = "";
  if (value) window.addEventListener("keydown", escapeSelection);
  else window.removeEventListener("keydown", escapeSelection);
  for (const event of ["pointerdown", "mousedown", "click"] as const) {
    if (value) window.addEventListener(event, pickReference, true);
    else window.removeEventListener(event, pickReference, true);
  }
});

const workshopVisible = ref(false), assetBusy = ref(false);
const emptyWorkshop = (): VisualModifiers => ({ camera: { camera: "", lens: "", focal: "", aperture: "" }, motions: [], color: "", style: "" });
const draft = ref<VisualModifiers>(emptyWorkshop());
const camera = computed(() => draft.value.camera as Record<string, string>);
const color = computed({ get: () => draft.value.color, set: value => { if (value !== draft.value.color) { draft.value.color = value; delete draft.value.palette; } } });
const style = computed({ get: () => draft.value.style, set: value => { if (value !== draft.value.style) { draft.value.style = value; delete draft.value.styleReference; } } });
const motionOptions = filmTechniques.filter(item => item.category === "camera" && item.stages.includes("video"));
const compiledPreview = ref(""), workshopError = ref(""), savingWorkshop = ref(false);
const workshopText = computed(() => compileVisualModifiers(props.preview ?? props.text, draft.value, node.data.storyboard?.shots));
function resetWorkshop() { draft.value = emptyWorkshop(); }
function openWorkshop() { draft.value = visualModifiersSchema.parse(node.data.visualModifiers ?? emptyWorkshop()); compiledPreview.value = ""; workshopError.value = ""; workshopVisible.value = true; }
function addMotion(id: string) { const item = motionOptions.find(value => value.id === id); if (item && draft.value.motions.length < 5 && !draft.value.motions.some(value => value.id === id)) draft.value.motions.push({ id, label: item.label, instruction: item.instruction }); }
function moveMotion(index: number, offset: number) { const [item] = draft.value.motions.splice(index, 1); draft.value.motions.splice(index + offset, 0, item!); }
watch(draft, () => { compiledPreview.value = ""; }, { deep: true });
async function saveWorkshop() {
  if (props.disabled || savingWorkshop.value || assetBusy.value) return;
  savingWorkshop.value = true; workshopError.value = "";
  try {
    const plan = visualModifiersSchema.parse(draft.value);
    const value = compileVisualModifiers("", plan) ? plan : undefined;
    const request = props.request?.();
    if (!request) throw new Error("当前节点尚未提供生成参数");
    const signature = JSON.stringify(request);
    let compiled: { fingerprint: string; compiled: { prompt: string } } | undefined;
    if (node.data.production) {
      const { directory } = await files.getWorkspaceFiles().list();
      const response = await fetch("/api/ai/media/production", { method: "POST", headers: { "Content-Type": "application/json", "x-milimili-csrf": "1" }, body: JSON.stringify({ directory, shotId: node.data.production.shotId, kind: props.mediaType, request: { ...request, visualModifiers: value, productionFingerprint: undefined } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "镜头编译失败");
      compiled = result.data;
    }
    if (disposed || props.disabled || JSON.stringify(props.request?.()) !== signature) throw new Error("节点配置已变化，请重新保存");
    node.data.visualModifiers = value;
    if (compiled) { node.data.production.productionFingerprint = compiled.fingerprint; compiledPreview.value = compiled.compiled.prompt; }
    else compiledPreview.value = workshopText.value;
    ElMessage.success("设置已保存，生成时采用当前修饰");
  } catch (cause) { workshopError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { savingWorkshop.value = false; }
}

const enhanceVisible = ref(false), enhancing = ref(false), enhancedText = ref("");
const models = ref<NodeAiModel[]>([]), languageModel = ref("");
let originalText = "", enhanceController: AbortController | undefined, disposed = false;
async function enhance() {
  try {
    originalText = props.text;
    enhancedText.value = "";
    models.value = await ai.getModels();
    if (disposed) return;
    if (!models.value.length) throw new Error("请先配置用于增强提示词的文字模型");
    languageModel.value = JSON.stringify([models.value[0]!.providerId, models.value[0]!.modelId]);
    enhanceVisible.value = true;
    if (models.value.length === 1) await runEnhancement();
  } catch (error) { if (!disposed) ElMessage.error(error instanceof Error ? error.message : "读取增强模型失败"); }
}
async function runEnhancement() {
  if (enhancing.value || props.disabled) return;
  enhanceController = new AbortController();
  enhancing.value = true;
  try {
    const model = models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === languageModel.value);
    if (!model) throw new Error("请选择增强模型");
    const workspace = files.getWorkspaceFiles();
    const { directory } = await workspace.list();
    const result = await ai.generate({ providerId: model.providerId, modelId: model.modelId, directory, signal: enhanceController.signal,
      systemPrompt: `你是${props.mediaType === "image" ? "图片" : "视频"}提示词编辑。仅改进表达、可见动作、构图、光线和时空连续性。保留原意、人物、数量、文字、作品形式和全部{{ref N}}引用标记，不擅自改风格或新增剧情。不声称看过未提供的参考图。只返回可直接使用的提示词。`, prompt: originalText });
    if (!enhanceController.signal.aborted && !disposed) enhancedText.value = result.text;
  } catch (error) { if (!enhanceController.signal.aborted && !disposed) ElMessage.error(error instanceof Error ? error.message : "增强失败，原提示词保留"); }
  finally { enhancing.value = false; }
}
function applyEnhanced() {
  if (props.text !== originalText) return void ElMessage.warning("原提示词已修改，请重新增强，避免覆盖新内容");
  const references = (value: string) => [...value.matchAll(/\{\{ref \d+\}\}/g)].map(item => item[0]).sort().join("|");
  if (references(originalText) !== references(enhancedText.value)) return void ElMessage.warning("参考标记发生变化，请保留原有参考后再应用");
  emit("replace", enhancedText.value.trim());
  enhanceVisible.value = false;
}

type SpeechSession = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { resultIndex: number; results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } } }) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null; start(): void; stop(): void; abort(): void };
const speechConstructor = (globalThis as typeof globalThis & { SpeechRecognition?: new () => SpeechSession; webkitSpeechRecognition?: new () => SpeechSession }).SpeechRecognition ?? (globalThis as typeof globalThis & { webkitSpeechRecognition?: new () => SpeechSession }).webkitSpeechRecognition;
const speechAvailable = !!speechConstructor, listening = ref(false);
let speech: SpeechSession | undefined;
function toggleSpeech() {
  if (listening.value) { speech?.stop(); return; }
  if (!speechConstructor || props.disabled) return;
  speech = new speechConstructor();
  speech.lang = "zh-CN"; speech.continuous = true; speech.interimResults = false;
  speech.onresult = event => {
    for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index]!.isFinal && node.selected && !props.disabled && !disposed) append(event.results[index]![0].transcript);
  };
  speech.onerror = event => { listening.value = false; if (!disposed && event.error !== "aborted") ElMessage.error(`语音输入失败：${event.error === "not-allowed" ? "麦克风权限未允许，请使用系统听写或在浏览器设置中允许" : event.error}`); };
  speech.onend = () => { listening.value = false; };
  try { speech.start(); listening.value = true; } catch { ElMessage.error("无法启动语音识别，请使用系统听写"); }
}
watch(() => props.disabled, value => { if (value) { speech?.abort(); selecting.value = false; enhanceController?.abort(); } });
watch(() => node.selected, selected => { if (!selected) speech?.abort(); });
watch([enhancing, listening, workshopVisible], () => emit("busy", enhancing.value || listening.value || workshopVisible.value), { flush: "sync" });
onScopeDispose(() => { disposed = true; window.removeEventListener("keydown", escapeSelection); for (const event of ["pointerdown", "mousedown", "click"] as const) window.removeEventListener(event, pickReference, true); speech?.abort(); enhanceController?.abort(); emit("busy", false); });
</script>

<style scoped lang="scss">
.promptTools { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; :deep(.el-button) { margin-left: 0; padding: 7px; min-height: 32px; } }
.promptLibrary { display: grid; gap: 8px; max-height: 360px; overflow: auto; button { text-align: left; border: 1px solid var(--el-border-color); border-radius: 8px; padding: 10px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); cursor: pointer; strong, span { display: block; } span { margin-top: 5px; font-size: 12px; line-height: 1.5; color: var(--el-text-color-secondary); } &:focus-visible { outline: 2px solid var(--el-color-primary); } } }
.referencePicker { position: fixed; top: 72px; left: 50%; transform: translateX(-50%); z-index: 3000; max-width: 90vw; padding: 12px 20px; border: 1px solid var(--el-border-color); border-radius: 12px; background: var(--el-bg-color-overlay); color: var(--el-text-color-primary); box-shadow: var(--el-box-shadow-light); span { display: block; font-size: 12px; margin-top: 6px; } }
.cameraWorkshop { max-height: 65vh; overflow-y: auto; .motionList { list-style: none; padding: 0; li { display: flex; align-items: center; gap: 8px; margin: 6px 0; span { margin-right: auto; } } } display: grid; gap: 14px; label { display: grid; gap: 7px; } .cameraFields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; } .colorPalette { display: flex; gap: 6px; span { width: 44px; height: 26px; border-radius: 4px; border: 1px solid var(--el-border-color); } } p { color: var(--el-text-color-secondary); margin: 0; } }
.promptEnhancement { label { display: grid; gap: 8px; margin-bottom: 12px; } }
</style>
