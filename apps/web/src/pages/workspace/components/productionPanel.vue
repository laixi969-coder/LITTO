<template>
  <el-drawer v-model="visible" title="镜头制作" size="min(1180px, 100vw)" :beforeClose="closePanel" :destroyOnClose="false">
    <div class="productionPanel" :aria-busy="busy">
      <p v-if="error" class="errorMessage" role="alert">{{ error }}</p>
      <p v-if="message" class="statusMessage" role="status">{{ message }}</p>
      <nav class="productionTabs" aria-label="制作步骤">
        <button v-for="item in tabs" :key="item.id" type="button" :aria-pressed="section === item.id" @click="section = item.id">{{ item.label }}</button>
      </nav>
      <fieldset :disabled="busy || !projectId">
        <template v-if="section === 'world'">
          <h3>世界与影调</h3>
          <div class="fieldGrid">
            <label v-for="field in worldFields" :key="field[0]">{{ field[1] }}<textarea v-model="world[field[0]]" rows="2" @input="worldDirty = true" /></label>
            <label v-for="field in lookFields" :key="field[0]">{{ field[1] }}<textarea v-model="look[field[0]]" rows="2" @input="worldDirty = true" /></label>
          </div>
          <button type="button" @click="run(saveWorld)">保存世界与影调</button>
          <h3>项目资产</h3>
          <div class="fieldGrid">
            <label>类型<select v-model="asset.type"><option v-for="item in assetTypes" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
            <label>名称<input v-model="asset.name" /></label>
            <label>几何、肤质、材质与空间说明<textarea v-model="asset.description" /></label>
            <label>不可改变的特征（每行一项）<textarea v-model="asset.invariants" /></label>
          </div>
          <button type="button" :disabled="!asset.name.trim()" @click="run(createAsset)">{{ editingAsset ? '保存为新版本' : '建立资产' }}</button><button v-if="editingAsset" type="button" @click="clearAsset">取消编辑</button>
          <ul class="assetList"><li v-for="item in assets" :key="item.id"><button type="button" @click="run(() => editAsset(item))">编辑与历史</button><span>{{ item.name }} · v{{ item.version }} · {{ item.approvalStatus === 'approved' ? '已批准' : '草稿' }}</span><button v-if="item.approvalStatus !== 'approved'" type="button" @click="run(() => approveAsset(item.id))">批准此资产</button></li></ul><ul v-if="editingAsset"><li v-for="version in assetVersions" :key="version.version">v{{ version.version }} · {{ version.approvalStatus }} <button v-if="version.approvalStatus === 'approved'" type="button" @click="run(() => rollbackAsset(version.version))">恢复此版本</button></li></ul>
        </template>
        <template v-else>
          <div class="shotNavigation">
            <label>当前镜头<select :value="shotId" @change="run(() => selectShot(($event.target as HTMLSelectElement).value))"><option value="">选择镜头</option><option v-for="item in shots" :key="item.id" :value="item.id">{{ item.ord + 1 }} · {{ item.title }}</option></select></label>
            <button type="button" @click="run(createShot)">新建镜头</button>
          </div>
          <template v-if="draft && section === 'shot'">
            <div class="fieldGrid" @input="dirty = true" @change="dirty = true">
              <label>镜头名称<input v-model="draft.title" /></label>
              <label>镜头职责<select v-model="draft.narrativeFunction"><option v-for="item in functions" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
              <label>动作与起止<textarea v-model="draft.action" /></label>
              <label>时长（秒）<input v-model.number="draft.duration" type="number" min="1" max="3600" /></label>
              <label v-for="field in cameraFields" :key="field[0]">{{ field[1] }}<input v-model="draft.camera[field[0]]" /></label>
              <label>焦段（mm）<input v-model.number="draft.camera.lensMm" type="number" min="1" max="2000" /></label>
              <label v-for="field in lightingFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.lighting[field[0]]" rows="2" /></label>
              <label v-for="field in performanceFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.performance[field[0]]" rows="2" /></label>
              <label v-for="field in blockingFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.blocking[field[0]]" rows="2" /></label>
            </div>
            <h3>真实感规格</h3>
            <div class="fieldGrid"><label v-for="field in realismFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.realism[field[0]]" rows="3" @input="dirty = true" /><small>{{ field[2] }}</small></label></div>
            <h3>出场资产</h3>
            <div class="checkList"><label v-for="item in assets" :key="item.id"><input v-model="draft.assetIds" type="checkbox" :value="item.id" @change="dirty = true" />{{ item.name }} · {{ item.approvalStatus === 'approved' ? '已批准' : '草稿' }}</label></div>
            <div class="fieldGrid" @change="dirty = true"><label>轴线侧<select v-model="draft.camera.side"><option value="none">未指定</option><option value="A">A 侧</option><option value="B">B 侧</option></select></label><label>画面运动方向<select v-model="draft.camera.screenDirection"><option value="none">无</option><option value="left">向左</option><option value="right">向右</option></select></label><label>主光方向<select v-model="draft.lighting.keyDirection"><option v-for="value in ['none', 'left', 'right', 'front', 'back', 'top']" :key="value">{{ value }}</option></select></label></div>
            <button type="button" @click="run(saveShot)">{{ dirty ? '保存镜头规格' : '镜头规格已保存' }}</button>
            <h3>参考用途</h3>
            <div class="fieldGrid">
              <label>上传参考媒体<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav" @change="run(() => uploadReference($event))" /></label>
              <label>项目参考<select v-model="binding.referenceId"><option value="">选择参考</option><option v-for="item in references" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
              <label>用于控制什么<select v-model="binding.role"><option v-for="item in roles" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
              <label>约束级别<select v-model="binding.lockLevel"><option value="LOCK">锁定</option><option value="CONTROL">受控</option><option value="ALLOW">允许变化</option><option value="RANDOM">随机</option></select></label>
              <label>意图权重<input v-model.number="binding.weight" type="number" min="0" max="1" step="0.1" /></label>
            </div>
            <button type="button" :disabled="!binding.referenceId" @click="run(bindReference)">绑定到镜头</button>
            <ul><li v-for="item in detail?.bindings" :key="item.id">{{ references.find(ref => ref.id === item.referenceId)?.name }} · {{ item.role }} · {{ item.lockLevel }} <button type="button" @click="run(() => removeBinding(item))">解除绑定</button></li></ul>
          </template>
          <template v-if="draft && section === 'generate'">
            <h3>按已保存的镜头规格生成</h3>
            <p>关键帧经检查选为主帧后，再生成视频。每次提交创建一个持久任务，保留全部候选。</p>
            <div class="fieldGrid">
              <label>生成类型<select v-model="kind"><option value="image">图片关键帧</option><option value="video">视频 Take</option></select></label>
              <label>模型<select v-model="modelKey"><option value="">选择已接入的模型</option><option v-for="item in availableModels" :key="keyOf(item)" :value="keyOf(item)">{{ item.providerLabel }} · {{ item.label }}</option></select></label>
              <label v-if="kind === 'video'">模式<select v-model="modeKey"><option value="">选择模式</option><option v-for="mode in modes" :key="JSON.stringify(mode)" :value="JSON.stringify(mode)">{{ modeLabel(mode) }}</option></select></label>
              <label v-if="kind === 'video'">分辨率<select v-model="resolution"><option value="">选择分辨率</option><option v-for="value in resolutions" :key="value">{{ value }}</option></select></label>
              <label v-if="kind === 'video'">时长<select v-model.number="duration"><option v-for="value in durations" :key="value" :value="value">{{ value }} 秒</option></select></label>
              <label v-if="kind === 'image' && selectedModel?.imageSizes?.length">尺寸<select v-model="size"><option v-for="value in selectedModel.imageSizes" :key="value">{{ value }}</option></select></label>
              <label>画幅<select v-model="ratio"><option v-for="value in selectedModel?.imageRatios?.length ? selectedModel.imageRatios : ['16:9', '9:16', '1:1']" :key="value">{{ value }}</option></select></label>
            </div>
            <button type="button" :disabled="!modelKey" @click="run(compile)">检查并预览生成内容</button>
            <div v-if="preview" class="generationPreview">
              <p v-for="warning in preview.compiled.warnings" :key="warning" class="attention">{{ warning }}</p>
              <p v-for="item in preview.compiled.degradations" :key="item.role" class="attention">{{ item.role }}：{{ item.strategy }}</p>
              <details><summary>查看实际发送的镜头规格与参考</summary><pre>{{ preview.compiled.prompt }}</pre></details>
              <p>供应商费用未知，按你接入的模型实际计费。提交后可在下方停止。</p>
              <button type="button" @click="run(generate)">提交一次生成</button>
            </div>
            <ul class="jobList"><li v-for="job in jobs" :key="job.id"><span>{{ job.kind === 'image' ? '关键帧' : '视频' }} · {{ job.status }}<small v-if="job.error">{{ job.error }}</small></span><button v-if="['QUEUED', 'RUNNING'].includes(job.status)" type="button" @click="run(() => cancelJob(job.id))">停止</button></li></ul>
          </template>
          <template v-if="detail && section === 'review'">
            <h3>实际输出与版本</h3>
            <div class="versionList"><button v-for="item in versions" :key="item.id" type="button" :aria-pressed="targetId === item.id" @click="selectVersion(item)">{{ item.type === 'keyframe' ? '关键帧' : 'Take' }} · {{ item.status }} · {{ item.id.slice(-5) }}</button></div>
            <template v-if="target">
              <img v-if="target.media?.mime.startsWith('image/')" class="outputPreview" :src="mediaUrl(target.media.url)" alt="当前关键帧候选" />
              <video v-else-if="target.media?.mime.startsWith('video/')" class="outputPreview" :src="mediaUrl(target.media.url)" controls preload="metadata" />
              <label>检查模型<select v-model="visionModelKey"><option value="">选择支持图片输入的模型</option><option v-for="item in visualModels" :key="keyOf(item)" :value="keyOf(item)">{{ item.providerLabel }} · {{ item.label }}</option></select></label><button type="button" :disabled="!visionModelKey" @click="run(autoReview)">视觉模型辅助检查</button>
              <p>辅助检查可能产生模型费用。视频按时间抽帧，只覆盖采样画面；请完整播放后记录运动和表演检查。</p>
              <div class="checkList"><label v-for="field in reviewFields" :key="field[0]"><input v-model="reviewed" type="checkbox" :value="field[0]" />已查看：{{ field[1] }}</label></div>
              <label class="fullField">实际观察说明<textarea v-model="reviewNote" rows="3" /></label>
              <div class="fieldGrid"><label>发现的问题<select v-model="observation"><option value="">本次未观察到下列缺陷</option><option v-for="item in observationKinds" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label></div>
              <template v-if="target.type === 'take'">
                <h3>片段结束时的实际状态</h3>
                <div class="fieldGrid"><label v-for="item in shotAssets" :key="item.id">{{ item.name }} · 实际位置、持物或服装状态<textarea v-model="stateNotes[item.id]" rows="2" /></label></div>
                <label class="checkList"><input v-model="stateConfirmed" type="checkbox" />已核对结束状态，下一镜继承这些实际记录</label>
              </template>
              <button type="button" :disabled="!reviewNote.trim()" @click="run(saveReview)">保存人工检查记录</button>
              <button type="button" @click="run(approveVersion)">{{ target.type === 'keyframe' ? '选为主关键帧' : '批准此 Take' }}</button>
              <article v-for="report in targetReports" :key="report.id" class="reviewReport"><strong>{{ report.score === null ? '检查未完成' : '已记录检查' }}</strong><p>{{ report.evidence?.note }}</p><p v-if="report.evidence?.vision?.reason">{{ report.evidence.vision.reason }}</p><p v-for="finding in report.findings" :key="finding.kind">{{ finding.cause }}：{{ finding.note }}<br />修复：{{ finding.detail }}</p></article>
            </template>
          </template>
        </template>
      </fieldset>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, toRaw, watch } from "vue";
import { ElMessageBox } from "element-plus";
import type { MediaModel } from "@toonflow/tools-scaffold/runtime";
const visible = defineModel<boolean>({ default: false });
const props = defineProps<{ projectId?: string; directory: string }>();
const projectId = props.projectId;
const section = ref("world"), busy = ref(false), error = ref(""), message = ref("");
const controller = new AbortController();
let pollTimer: ReturnType<typeof setTimeout> | undefined;
onScopeDispose(() => { controller.abort(); clearTimeout(pollTimer); });
const tabs = [{ id: "world", label: "世界与资产" }, { id: "shot", label: "镜头规格" }, { id: "generate", label: "生成" }, { id: "review", label: "检查与采用" }];
const worldFields = [["era", "年代"], ["locationLogic", "地点与空间逻辑"], ["architecture", "建筑"], ["weather", "天气"], ["time", "时间"], ["material", "环境材质"], ["physics", "物理规则"]];
const lookFields = [["contrast", "对比"], ["saturation", "饱和度"], ["skinTone", "肤色"], ["highlightRolloff", "高光滚降"], ["shadowBehavior", "暗部表现"], ["lensCharacter", "镜头特性"], ["texture", "纹理"], ["sharpnessPhilosophy", "锐度策略"]];
const cameraFields = [["shotSize", "景别"], ["position", "机位"], ["focus", "焦点"], ["depth", "景深"], ["motion", "摄影机运动"], ["motivation", "运镜动机"]];
const lightingFields = [["motivatedLight", "光源依据"], ["key", "主光方向与软硬"], ["fill", "补光"], ["negativeFill", "负补光"], ["exposure", "曝光主体与策略"], ["colorTemp", "色温"]];
const performanceFields = [["emotion", "情绪"], ["eyeline", "视线"], ["gesture", "表演动作"], ["timing", "表演节拍"]];
const blockingFields = [["foreground", "前景"], ["midground", "人物走位与中景"], ["background", "背景"]];
const realismFields = [["surface", "表面材质", "逐项说明皮肤、头发、布料或物体的纹理与反光，避免统一磨皮。"], ["imaging", "成像", "曝光、高光、暗部、焦平面与光学表现。"], ["world", "空间与物理", "比例、接触、遮挡与物体恒常。"], ["motion", "运动", "动作起止、重心、受力、惯性与次级运动；视频必填。"], ["cinematic", "电影语言", "表演、调度、镜头职责与剪辑衔接。"]];
const functions = [["Establish", "建立"], ["Reveal", "揭示"], ["Reaction", "反应"], ["Contrast", "对比"], ["Transition", "过渡"], ["Match", "匹配"], ["Rhythm", "节奏"]];
const assetTypes = [["Character", "人物"], ["Environment", "场景"], ["Wardrobe", "服装"], ["Prop", "道具"], ["Product", "产品"], ["Vehicle", "车辆"]];
const roles = [["IDENTITY", "身份"], ["GEOMETRY", "几何"], ["WARDROBE", "服装"], ["ENVIRONMENT", "场景"], ["COMPOSITION", "构图"], ["LIGHTING", "光线"], ["LOOK", "影调"], ["END_FRAME", "尾帧"], ["PERFORMANCE", "表演视频"], ["CAMERA_MOTION", "运镜视频"], ["AUDIO", "音频"]];
const observationKinds = [["plastic_surface", "塑料材质或磨皮"], ["imaging_failure", "曝光或光学不可信"], ["temporal_drift", "视频身份或材质漂移"], ["performance_failure", "表演或运镜不可信"], ["motion_physics", "动作受力或接触错误"], ["scene_structure", "场景结构错误"], ["identity_drift", "身份漂移"], ["hand_artifact", "手部错误"], ["face_artifact", "面部错误"], ["color_shift", "色差"]];
const world = ref<Record<string, any>>({}), look = ref<Record<string, any>>({}), worldDirty = ref(false);
const assets = ref<any[]>([]), shots = ref<any[]>([]), sequences = ref<any[]>([]), references = ref<any[]>([]);
const editingAsset = ref(""), assetVersions = ref<any[]>([]);
const asset = ref({ type: "Character", name: "", description: "", invariants: "" });
let savedAsset = JSON.stringify(asset.value);
let pendingRequestId = "";
const binding = ref({ referenceId: "", role: "IDENTITY", lockLevel: "LOCK", weight: 1 });
let baseUpdatedAt: string | undefined;
const shotId = ref(""), draft = ref<any>(null), detail = ref<any>(null), dirty = ref(false);
const kind = ref("image"), modelKey = ref(""), modeKey = ref(""), resolution = ref(""), duration = ref(4), size = ref(""), ratio = ref("16:9");
const visualModels = ref<any[]>([]), visionModelKey = ref("");
const models = ref<MediaModel[]>([]), preview = ref<any>(null), jobs = ref<any[]>([]);
const stateNotes = ref<Record<string, string>>({}), stateConfirmed = ref(false);
const shotAssets = computed(() => assets.value.filter(item => detail.value?.assetIds?.includes(item.id)));
const targetId = ref(""), reviewed = ref<string[]>([]), reviewNote = ref(""), observation = ref("");
const keyOf = (model: MediaModel) => JSON.stringify([model.providerId, model.modelId]);
const availableModels = computed(() => models.value.filter(model => model.type === kind.value));
const selectedModel = computed(() => availableModels.value.find(model => keyOf(model) === modelKey.value));
const modes = computed(() => Array.isArray(selectedModel.value?.mode) ? selectedModel.value!.mode as unknown[] : []);
const resolutions = computed(() => [...new Set(selectedModel.value?.durationResolutionMap?.flatMap(rule => rule.resolution) ?? [])]);
const durations = computed(() => [...new Set(selectedModel.value?.durationResolutionMap?.filter(rule => rule.resolution.includes(resolution.value)).flatMap(rule => rule.duration) ?? [])]);
const versions = computed(() => [...(detail.value?.keyframes ?? []).map((item: any) => ({ ...item, type: "keyframe" })), ...(detail.value?.takes ?? []).map((item: any) => ({ ...item, type: "take" }))]);
const target = computed(() => versions.value.find(item => item.id === targetId.value));
const targetReports = computed(() => (detail.value?.qc ?? []).filter((report: any) => report.targetId === targetId.value).reverse());
const reviewFields = computed(() => realismFields.filter(field => target.value?.type === "take" || field[0] !== "motion"));
const mediaUrl = (url: string) => url.startsWith("/") ? `/cloud${url}` : url;
const modeLabel = (mode: unknown) => Array.isArray(mode) ? `多参考 (${mode.join(" / ")})` : ({ singleImage: "首帧", startFrameOptional: "首帧可选", startEndRequired: "首尾帧", endFrameOptional: "首帧与可选尾帧", text: "纯文本" }[String(mode)] ?? String(mode));
watch([kind, modelKey, modeKey, resolution, duration, size, ratio, shotId], () => { preview.value = null; pendingRequestId = ""; });
watch(selectedModel, model => { modeKey.value = ""; resolution.value = ""; size.value = model?.imageSizes?.[0] ?? ""; ratio.value = model?.imageRatios?.[0] ?? "16:9"; });
watch(durations, values => { if (!values.includes(duration.value)) duration.value = values[0] ?? 4; });
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/cloud${path}`, { method, signal: controller.signal, headers: { "Content-Type": "application/json", "x-litto-csrf": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error([typeof result.error === "string" ? result.error : result.error?.message || result.message || `请求失败 ${response.status}`, ...(Array.isArray(result.details) ? result.details.map((item: any) => `${item.path}: ${item.message}`) : [])].join("；"));
  if (method !== "GET") window.dispatchEvent(new Event("littoProductionUpdated"));
  return result;
}
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true; error.value = ""; message.value = "";
  try { await action(); } catch (cause) { if (!controller.signal.aborted && cause !== "cancel" && cause !== "close") error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
async function load() {
  if (!projectId) throw new Error("当前工作区尚未关联项目，请重新打开工作区");
  const path = `/projects/${projectId}`;
  const values = await Promise.all([request(`${path}/world`), request(`${path}/looks`), request(`${path}/assets`), request(`${path}/shots`), request(`${path}/sequences`), request(`${path}/references`)]);
  [world.value, , assets.value, shots.value, sequences.value, references.value] = values;
  look.value = values[1].find((item: any) => item.scope === "project") ?? {};
  const response = await fetch("/api/ai/media/models", { signal: controller.signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "模型加载失败");
  models.value = result.data;
  const languageResponse = await fetch("/api/ai/models", { signal: controller.signal });
  if (!languageResponse.ok) throw new Error("检查模型列表读取失败");
  visualModels.value = (await languageResponse.json()).data;
  await refreshJobs();
}
let loaded = false;
watch(visible, open => { if (open && !loaded) void run(async () => { await load(); loaded = true; }); }, { immediate: true });
async function saveWorld() {
  await request(`/projects/${projectId}/world`, "PUT", world.value);
  await request(`/projects/${projectId}/looks/project`, "PUT", look.value);
  worldDirty.value = false; preview.value = null; message.value = "世界与影调已保存";
}
function clearAsset() { editingAsset.value = ""; assetVersions.value = []; asset.value = { type: "Character", name: "", description: "", invariants: "" }; savedAsset = JSON.stringify(asset.value); }
async function editAsset(item: any) {
  if (JSON.stringify(asset.value) !== savedAsset) throw new Error("请先保存当前资产，再切换编辑对象");
  const value = await request(`/assets/${item.id}`); editingAsset.value = item.id; assetVersions.value = value.versions;
  asset.value = { type: value.type, name: value.name, description: value.description, invariants: value.invariants.join("\n") };
  savedAsset = JSON.stringify(asset.value);
}
async function createAsset() {
  if (editingAsset.value) await ElMessageBox.confirm("将建立新的资产版本，已采用镜头需重新检查。历史版本保留。", "建立版本", { confirmButtonText: "建立", cancelButtonText: "取消" });
  const item = await request(editingAsset.value ? `/assets/${editingAsset.value}/versions` : `/projects/${projectId}/assets`, "POST", { ...asset.value, invariants: asset.value.invariants.split(/\n/).map(value => value.trim()).filter(Boolean) });
  assets.value = editingAsset.value ? assets.value.map(value => value.id === item.id ? item : value) : [...assets.value, item]; clearAsset();
}
async function rollbackAsset(version: number) {
  await ElMessageBox.confirm("恢复将建立一个新版本，并影响后续镜头。现有版本保留。", "恢复资产", { confirmButtonText: "恢复", cancelButtonText: "取消" });
  const item = await request(`/assets/${editingAsset.value}/rollback`, "POST", { version }); assets.value = assets.value.map(value => value.id === item.id ? item : value); await editAsset(item);
}
async function approveAsset(id: string) {
  await ElMessageBox.confirm("批准后这些特征将作为生成约束。请确认资产说明已核对。", "批准资产", { confirmButtonText: "批准", cancelButtonText: "取消" });
  const item = await request(`/assets/${id}/approve`, "POST", {});
  assets.value = assets.value.map(asset => asset.id === id ? item : asset);
}
async function saveShot() {
  if (!draft.value || !dirty.value) return;
  let confirm = false;
  if (detail.value.heroKeyframeId || detail.value.approvedTakeId) {
    await ElMessageBox.confirm("修改规格会使当前输出的检查记录过期，须重新检查后才能采用。原有版本保留。", "修改已采用镜头", { confirmButtonText: "保存修改", cancelButtonText: "取消" }); confirm = true;
  }
  const item = await request(`/shots/${shotId.value}`, "PATCH", { ...draft.value, sceneId: draft.value.sceneId ?? undefined, confirm, expectedUpdatedAt: baseUpdatedAt });
  dirty.value = false; baseUpdatedAt = item.updatedAt ?? undefined; detail.value.updatedAt = item.updatedAt; preview.value = null; message.value = "镜头规格已保存";
  shots.value = shots.value.map(shot => shot.id === item.id ? item : shot);
}
async function selectShot(id: string) {
  await saveShot(); shotId.value = id; preview.value = null; targetId.value = "";
  if (!id) { detail.value = null; draft.value = null; return; }
  detail.value = await request(`/shots/${id}`);
  baseUpdatedAt = detail.value.updatedAt ?? detail.value.createdAt;
  draft.value = structuredClone(toRaw(detail.value));
  draft.value.realism ??= Object.fromEntries(realismFields.map(field => [field[0], ""]));
  duration.value = draft.value.duration;
}
async function createShot() {
  await saveShot();
  let sequence = sequences.value[0];
  if (!sequence) { sequence = await request(`/projects/${projectId}/sequences`, "POST", { name: "主序列" }); sequences.value.push(sequence); }
  let scene = sequence.scenes?.[0];
  if (!scene) { scene = await request(`/projects/${projectId}/scenes`, "POST", { sequenceId: sequence.id, name: "场景 1" }); sequence.scenes = [scene]; }
  const item = await request(`/projects/${projectId}/shots`, "POST", { sequenceId: sequence.id, sceneId: scene.id, title: `镜头 ${shots.value.length + 1}` });
  shots.value.push(item); await selectShot(item.id); section.value = "shot";
}
async function uploadReference(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; if (!file) return;
  const response = await fetch(`/cloud/media?projectId=${encodeURIComponent(projectId!)}`, { method: "POST", headers: { "x-litto-csrf": "1", "Content-Type": file.type }, body: file, signal: controller.signal });
  const media = await response.json();
  if (!response.ok) throw new Error(media.error?.message || "上传失败");
  const reference = await request(`/projects/${projectId}/references`, "POST", { kind: media.mime.split("/")[0], name: file.name, mediaId: media.id });
  references.value.push(reference); binding.value.referenceId = reference.id; input.value = "";
}
async function bindReference() { await saveShot(); await request(`/shots/${shotId.value}/bindings`, "POST", binding.value); detail.value = await request(`/shots/${shotId.value}`); preview.value = null; }
async function removeBinding(item: any) {
  await ElMessageBox.confirm("解除此参考将改变镜头约束，已有输出需重新检查。", "解除参考", { confirmButtonText: "解除", cancelButtonText: "取消" });
  await request(`/bindings/${item.id}?confirm=1`, "DELETE"); detail.value = await request(`/shots/${shotId.value}`); preview.value = null;
}
function generationRequest() {
  const model = selectedModel.value; if (!model) throw new Error("请选择模型");
  return { providerId: model.providerId, modelId: model.modelId, ratio: ratio.value, ...(kind.value === "image" ? (size.value ? { size: size.value } : {}) : { mode: modeKey.value ? JSON.parse(modeKey.value) : undefined, resolution: resolution.value, duration: duration.value }) };
}
async function production(requestId?: string) {
  const response = await fetch("/api/ai/media/production", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory: props.directory, shotId: shotId.value, kind: kind.value, request: generationRequest(), requestId, fingerprint: preview.value?.fingerprint }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.message || "镜头生成失败"); return result.data;
}
async function compile() { if (kind.value === "video" && draft.value.duration !== duration.value) { draft.value.duration = duration.value; dirty.value = true; } await saveShot(); if (worldDirty.value) await saveWorld(); preview.value = await production(); pendingRequestId = ""; }
async function generate() { pendingRequestId ||= crypto.randomUUID(); await production(pendingRequestId); pendingRequestId = ""; preview.value = null; message.value = "生成任务已提交"; await refreshJobs(); }
async function refreshJobs() {
  const result = await request(`/generations?projectId=${encodeURIComponent(projectId!)}`);
  jobs.value = (Array.isArray(result) ? result : result.items ?? []).filter((job: any) => job.targetType === "shot");
  clearTimeout(pollTimer);
  if (jobs.value.some(job => ["QUEUED", "RUNNING"].includes(job.status))) pollTimer = setTimeout(() => void refreshJobs().then(refreshResults).catch(cause => { if (!controller.signal.aborted) error.value = cause.message; }), 1800);
}
async function refreshResults() { if (shotId.value) detail.value = await request(`/shots/${shotId.value}`); window.dispatchEvent(new Event("littoProductionUpdated")); }
async function cancelJob(id: string) { await request(`/generations/${id}/cancel`, "POST", {}); await refreshJobs(); }
function selectVersion(item: any) { targetId.value = item.id; reviewed.value = []; reviewNote.value = ""; observation.value = ""; stateNotes.value = {}; stateConfirmed.value = false; }
async function autoReview() { const item = target.value; await request(`/shots/${shotId.value}/qc`, "POST", { targetType: item.type, targetId: item.id, auto: true, visionModel: { providerId: JSON.parse(visionModelKey.value)[0], modelId: JSON.parse(visionModelKey.value)[1] } }); await refreshResults(); }
async function saveReview() {
  const item = target.value;
  const observedStateDelta: Record<string, Record<string, unknown>> = {};
  if (item.type === "take" && stateConfirmed.value) {
    for (const asset of shotAssets.value) {
      if (!stateNotes.value[asset.id]?.trim()) throw new Error(`请填写 ${asset.name} 的实际结束状态`);
      const key = ({ Character: "characters", Wardrobe: "wardrobe", Environment: "environment" } as Record<string, string>)[asset.type] ?? "props";
      (observedStateDelta[key] ??= {})[asset.id] = { note: stateNotes.value[asset.id] };
    }
  }
  await request(`/shots/${shotId.value}/qc`, "POST", { targetType: item.type, targetId: item.id, reviewed: reviewed.value, note: reviewNote.value, ...(stateConfirmed.value ? { observedStateDelta } : {}), observations: observation.value ? [{ kind: observation.value, note: reviewNote.value }] : [] });
  await refreshResults(); message.value = "检查记录已保存";
}
async function approveVersion() { const item = target.value; await request(`/${item.type === 'keyframe' ? 'keyframes' : 'takes'}/${item.id}/${item.type === 'keyframe' ? 'promote' : 'approve'}`, "POST", {}); await refreshResults(); message.value = item.type === "keyframe" ? "主关键帧已选定" : "Take 已批准"; }
async function flushSave() { if (JSON.stringify(asset.value) !== savedAsset) throw new Error("资产修改尚未保存，请先建立或保存资产版本"); if (worldDirty.value) await saveWorld(); await saveShot(); }
async function closePanel(done: () => void) { try { await flushSave(); done(); } catch (cause) { error.value = cause instanceof Error ? cause.message : "未保存，面板保持打开"; } }
async function openShot(id: string) {
  await run(async () => { if (!loaded) { await load(); loaded = true; } await selectShot(id); section.value = "review"; visible.value = true; });
}
defineExpose({ flushSave, openShot });
</script>

<style scoped lang="scss">
.productionPanel {
  color: var(--studioInk); font-size: 14px;
  .productionTabs, .shotNavigation, .versionList { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; align-items: end; }
  .productionTabs { position: sticky; top: 0; z-index: 1; background: var(--studioSurface); padding: 8px 0; }
  fieldset { border: 0; padding: 0; min-width: 0; }
  h3 { font-size: 16px; margin: 24px 0 16px; }
  label { display: flex; flex-direction: column; gap: 8px; line-height: 1.5; }
  input, select, textarea { box-sizing: border-box; width: 100%; min-height: 44px; padding: 10px; color: var(--studioInk); background: var(--studioSurface); border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); font: inherit; }
  textarea { resize: vertical; }
  button { min-height: 44px; padding: 8px 16px; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); background: var(--studioSurface); color: var(--studioInk); cursor: pointer; }
  button[aria-pressed="true"] { background: var(--studioInk); color: var(--studioSurface); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  :is(button, input, select, textarea):focus-visible { outline: 2px solid var(--studioDone); outline-offset: 2px; }
  .fieldGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
  .checkList { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; label { flex-direction: row; align-items: center; } input { width: 20px; min-height: 20px; } }
  .assetList, .jobList { padding: 0; list-style: none; li { padding: 12px 0; border-bottom: 1px solid var(--studioBorder); display: flex; justify-content: space-between; gap: 16px; } small { display: block; } }
  .outputPreview { display: block; width: 100%; max-height: 420px; object-fit: contain; background: var(--studioRail); margin: 16px 0; }
  .generationPreview, .reviewReport { padding: 16px 0; border-top: 1px solid var(--studioBorder); margin-top: 16px; }
  .errorMessage, .attention { color: var(--studioAttention); }
  .statusMessage { color: var(--studioDone); }
  .fullField { margin: 16px 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
  small { color: var(--studioMuted); }
  @media (max-width: 640px) { .fieldGrid { grid-template-columns: 1fr; } }
}
</style>
