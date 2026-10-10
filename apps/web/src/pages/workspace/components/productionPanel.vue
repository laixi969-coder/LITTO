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
            <label v-for="axis in personaAxes" :key="axis.key">{{ axis.label }}<select v-model="asset.personaTags[axis.key]"><option value="">未指定</option><option v-for="pole in axis.poles" :key="pole[0]" :value="pole[0]">{{ pole[1] }}</option></select></label>
          </div>
          <p class="reviewHint">气质标签仅用于角色库检索与去重，不参与生成；不凭性别、年龄或职业预设脸型。</p>
          <button type="button" :disabled="!asset.name.trim()" @click="run(createAsset)">{{ editingAsset ? '保存为新版本' : '建立资产' }}</button><button v-if="editingAsset" type="button" @click="clearAsset">取消编辑</button>
          <ul class="assetList"><li v-for="item in assets" :key="item.id"><button type="button" @click="run(() => editAsset(item))">编辑与历史</button><span>{{ item.name }} · v{{ item.version }} · {{ item.approvalStatus === 'approved' ? '已批准' : '草稿' }}<template v-if="hasPersonaTags(item.personaTags)"> · {{ personaSummary(item.personaTags) }}</template></span><button v-if="item.approvalStatus !== 'approved'" type="button" @click="run(() => approveAsset(item.id))">批准此资产</button><button v-else-if="!librarySourceIds.has(item.id)" type="button" @click="run(() => publishAsset(item.id))">入池角色库</button></li></ul><ul v-if="editingAsset"><li v-for="version in assetVersions" :key="version.version">v{{ version.version }} · {{ version.approvalStatus }} <button v-if="version.approvalStatus === 'approved'" type="button" @click="run(() => rollbackAsset(version.version))">恢复此版本</button></li></ul>
          <h3>角色库（跨项目复用）</h3>
          <p class="reviewHint">已采用且选出定妆参考图的资产可入池；新项目导入后继承同一张脸，避免跨项目崩脸。</p>
          <div class="fieldGrid">
            <label>类型<select v-model="libraryFilter.type"><option value="">全部</option><option v-for="item in assetTypes" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
            <label v-for="axis in personaAxes" :key="axis.key">{{ axis.label }}<select v-model="libraryFilter[axis.key]"><option value="">不限</option><option v-for="pole in axis.poles" :key="pole[0]" :value="pole[0]">{{ pole[1] }}</option></select></label>
          </div>
          <button type="button" @click="run(searchLibraryAssets)">检索角色库</button>
          <ul class="libraryList"><li v-for="entry in libraryAssets" :key="entry.id">
            <figure v-if="entry.media"><img :src="mediaUrl(entry.media.url)" :alt="entry.name" /></figure>
            <div class="libraryMeta"><strong>{{ entry.name }}</strong><span>{{ assetTypeLabel(entry.type) }} · 复用 {{ entry.reuseCount }} 次<template v-if="hasPersonaTags(entry.personaTags)"> · {{ personaSummary(entry.personaTags) }}</template></span><small>{{ entry.description }}</small></div>
            <button type="button" @click="run(() => importLibraryAsset(entry))">导入本项目</button>
          </li></ul>
          <p v-if="librarySearched && !libraryAssets.length" class="reviewHint">角色库暂无匹配资产。</p>
        </template>
        <template v-else-if="section !== 'edit'">
          <div class="shotNavigation">
            <label>当前镜头<select :value="shotId" @change="run(() => selectShot(($event.target as HTMLSelectElement).value))"><option value="">选择镜头</option><option v-for="item in shots" :key="item.id" :value="item.id">{{ item.ord + 1 }} · {{ item.title }}</option></select></label>
            <button type="button" @click="run(createShot)">新建镜头</button>
          </div>
          <template v-if="draft && section === 'shot'">
            <div class="fieldGrid" @input="dirty = true" @change="dirty = true">
              <label>镜头名称<input v-model="draft.title" /></label>
              <label>镜头职责<select v-model="draft.narrativeFunction"><option v-for="item in functions" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
              <label>动作与起止<textarea v-model="draft.action" /></label>
              <label>计划使用时长（秒）<input v-model.number="draft.duration" type="number" min="1" max="3600" /></label>
              <label v-for="field in cameraFields" :key="field[0]">{{ field[1] }}<input v-model="draft.camera[field[0]]" /></label>
              <label>焦段（mm）<input v-model.number="draft.camera.lensMm" type="number" min="1" max="2000" /></label>
              <label v-for="field in lightingFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.lighting[field[0]]" rows="2" /></label>
              <label v-for="field in performanceFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.performance[field[0]]" rows="2" /></label>
              <label v-for="field in blockingFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.blocking[field[0]]" rows="2" /></label>
            </div>
            <h3>镜头设计卡</h3>
            <button v-if="!draft.camera.design" type="button" @click="draft.camera.design = Object.fromEntries([...designFields.map(field => [field[0], '']), ['invariants', []], ['acceptance', []]]); dirty = true">添加镜头设计</button>
            <div v-else class="fieldGrid">
              <label v-for="field in designFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.camera.design[field[0]]" @input="dirty = true" /></label>
              <label v-for="field in [['invariants', '保持不变（每行一项）'], ['acceptance', '观看验收（每行一项）']]" :key="field[0]">{{ field[1] }}<textarea :value="draft.camera.design[field[0]].join('\n')" @input="draft.camera.design[field[0]] = ($event.target as HTMLTextAreaElement).value.split('\n'); dirty = true" /></label>
            </div>
            <h3>真实感规格</h3>
            <div class="fieldGrid"><label v-for="field in realismFields" :key="field[0]">{{ field[1] }}<textarea v-model="draft.realism[field[0]]" rows="3" @input="dirty = true" /><small>{{ field[2] }}</small></label></div>
            <h3>原尺寸材质检查区域</h3>
            <label><input :checked="!!draft.inspectionRegion" type="checkbox" @change="draft.inspectionRegion = ($event.target as HTMLInputElement).checked ? { x: 0.25, y: 0.25, width: 0.5, height: 0.5, unit: 'normalized' } : null; dirty = true" />指定脸部或材质区域（0–1），辅助检查会附加原尺寸局部图</label>
            <div v-if="draft.inspectionRegion" class="fieldGrid"><label v-for="field in ['x', 'y', 'width', 'height']" :key="field">{{ field }}<input v-model.number="draft.inspectionRegion[field]" type="number" min="0" max="1" step="0.01" @input="dirty = true" /></label></div>
            <h3>出场资产</h3>
            <div class="checkList"><label v-for="item in assets" :key="item.id"><input v-model="draft.assetIds" type="checkbox" :value="item.id" @change="dirty = true" />{{ item.name }} · {{ item.approvalStatus === 'approved' ? '已批准' : '草稿' }}</label></div>
            <div class="fieldGrid" @change="dirty = true"><label>轴线侧<select v-model="draft.camera.side"><option value="none">未指定</option><option value="A">A 侧</option><option value="B">B 侧</option></select></label><label>画面运动方向<select v-model="draft.camera.screenDirection"><option value="none">无</option><option value="left">向左</option><option value="right">向右</option></select></label><label>光向坐标<select v-model="draft.lighting.directionSpace"><option value="screen">画面坐标</option><option value="world">场景固定坐标</option></select></label><label>主光方向<select v-model="draft.lighting.keyDirection"><option v-for="value in ['none', 'left', 'right', 'front', 'back', 'top']" :key="value">{{ value }}</option></select></label></div>
            <button type="button" @click="run(saveShot)">{{ dirty ? '保存镜头规格' : '镜头规格已保存' }}</button>
            <h3>参考用途</h3>
            <div class="fieldGrid">
              <label>上传参考媒体<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav" @change="run(() => uploadReference($event))" /></label>
              <label>项目参考<select v-model="binding.referenceId"><option value="">选择参考</option><option v-for="item in references" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
              <label>用于控制什么<select v-model="binding.role"><option v-for="item in roles" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
              <label>约束级别<select v-model="binding.lockLevel"><option value="LOCK">锁定</option><option value="CONTROL">受控</option><option value="ALLOW">允许变化</option><option value="RANDOM">随机</option></select></label>
              <label>意图权重<input v-model.number="binding.weight" type="number" min="0" max="1" step="0.1" /></label>
            </div>
            <label><input v-model="cropEnabled" type="checkbox" />裁切图像参考（原图归一化坐标 0–1）</label>
            <div v-if="cropEnabled" class="fieldGrid"><label v-for="field in ['x', 'y', 'width', 'height'] as const" :key="field">{{ field }}<input v-model.number="referenceCrop[field]" type="number" min="0" max="1" step="0.01" /></label></div>
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
              <label v-if="kind === 'video'">生成时长（含剪辑余量）<select v-model.number="duration"><option v-for="value in durations" :key="value" :value="value">{{ value }} 秒</option></select></label>
              <label v-if="kind === 'video' && draft.musicVideo && selectedModel?.audio === 'optional'"><input v-model="generateAudio" type="checkbox" />生成声音</label>
              <label v-if="kind === 'image' && selectedModel?.imageSizes?.length">尺寸<select v-model="size"><option v-for="value in selectedModel.imageSizes" :key="value">{{ value }}</option></select></label>
              <label>画幅<select v-model="ratio"><option v-for="value in selectedModel?.cameraTrajectory ? ['20:11'] : selectedModel?.imageRatios?.length ? selectedModel.imageRatios : ['16:9', '9:16', '1:1']" :key="value">{{ value }}</option></select></label>
              <template v-if="kind === 'video' && selectedModel?.cameraTrajectory">
                <label>3D 导演台导出的轨迹<input type="file" accept="application/json,.json" @change="run(() => loadTrajectory($event))" /></label>
                <label v-if="cameraTrajectory">平移尺度<input v-model.number="cameraTrajectory.translationScale" type="number" min="0.0001" max="100" step="0.01" /></label>
                <label><input v-model="imageAndCameraOnly" type="checkbox" />使用图像与相机轨迹生成；已校准尺度，逐请求文字表演指令和音频不受支持</label>
              </template>
            </div>
            <button type="button" :disabled="!modelKey" @click="run(compile)">检查并预览生成内容</button>
            <div v-if="preview" class="generationPreview">
              <p v-for="warning in preview.compiled.warnings" :key="warning" class="attention">{{ warning }}</p>
              <p v-for="item in preview.compiled.degradations" :key="item.role" class="attention">{{ item.role }}：{{ item.strategy }}</p>
              <div class="sentReferences"><figure v-for="item in compiledMedia" :key="item.id"><img v-if="item.mime.startsWith('image/')" :src="mediaUrl(item.url)" :alt="item.role + ' 实际发送参考'" /><video v-else-if="item.mime.startsWith('video/')" :src="mediaUrl(item.url)" controls preload="metadata" /><audio v-else :src="mediaUrl(item.url)" controls /><figcaption>{{ item.role }} · {{ item.id }}</figcaption></figure></div>
              <details><summary>查看实际发送的镜头规格与参考</summary><pre>{{ preview.compiled.prompt }}</pre></details>
              <label><input v-model="asBatch" type="checkbox" />本次生成登记为抽卡批次，完成后在「检查与采用」页对比并选出定妆图</label>
              <label v-if="asBatch && candidateBatches.length">加入已有批次<select v-model="batchId"><option value="">新建批次</option><option v-for="item in candidateBatches" :key="item.id" :value="item.id">{{ item.kind === 'image' ? '关键帧' : '视频' }}批次 · {{ item.count }} 张 · {{ item.id.slice(-5) }}</option></select></label>
              <label v-if="asBatch && draft.assetIds?.length && !batchId">绑定资产（选出后成为该资产定妆参考）<select v-model="batchAssetId"><option value="">不绑定</option><option v-for="item in shotAssets" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
              <p>供应商费用未知，按你接入的模型实际计费。提交后可在下方停止。</p>
              <button type="button" @click="run(generate)">提交一次生成</button>
            </div>
            <ul class="jobList"><li v-for="job in jobs" :key="job.id"><span>{{ job.kind === 'image' ? '关键帧' : '视频' }} · {{ job.status }}<small v-if="job.error">{{ job.error }}</small></span><button v-if="['QUEUED', 'RUNNING'].includes(job.status)" type="button" @click="run(() => cancelJob(job.id))">停止</button></li></ul>
          </template>
          <template v-if="detail && section === 'review'">
            <h3>实际输出与版本</h3>
            <p v-if="!versions.length" class="reviewHint">这个镜头还没有生成结果，先到「生成」页生成关键帧。</p>
            <p v-else-if="detail.approvedTakeId && !target" class="statusMessage">这个镜头的 Take 已批准。</p>
            <button v-if="detail.approvedTakeId && nextPendingShot" type="button" @click="run(() => selectShot(nextPendingShot!.id))">下一个待处理镜头：{{ nextPendingShot.ord + 1 }} · {{ nextPendingShot.title }}</button>
            <div class="versionList"><button v-for="item in versions" :key="item.id" type="button" :aria-pressed="targetId === item.id" @click="selectVersion(item)">{{ item.type === 'keyframe' ? '关键帧' : 'Take' }} · {{ item.status }} · {{ item.id.slice(-5) }}</button></div>
            <template v-if="target">
              <img v-if="target.media?.mime.startsWith('image/')" class="outputPreview" :src="mediaUrl(target.media.url)" alt="当前关键帧候选" />
              <video v-else-if="target.media?.mime.startsWith('video/')" class="outputPreview" :src="mediaUrl(target.media.url)" controls preload="metadata" />
              <label>检查模型<select v-model="visionModelKey"><option value="">选择支持图片输入的模型</option><option v-for="item in visualModels" :key="keyOf(item)" :value="keyOf(item)">{{ item.providerLabel }} · {{ item.label }}</option></select></label><button type="button" :disabled="!visionModelKey" @click="run(autoReview)">视觉模型辅助检查</button>
              <p>辅助检查可能产生模型费用。视频最多抽取 48 个全帧，较密采样可能增加费用，只覆盖采样画面；请完整播放后记录运动和表演检查。</p>
              <p class="reviewHint">确认前请对照画面看：{{ reviewFields.map(field => field[1]).join("、") }}{{ target.type === "take" ? "；视频请完整播放一遍" : "" }}。</p>
              <label v-for="field in reviewFields" :key="field[0]"><input v-model="reviewedFields" type="checkbox" :value="field[0]" />已检查 {{ field[1] }}</label>
              <label v-if="target.type === 'take'"><input v-model="fullPlayback" type="checkbox" />已完整播放，检查肢体增减、遮挡、手物接触及动作收势</label>
              <label v-for="finding in priorFindings" :key="finding.kind"><input v-model="dismissedKinds" type="checkbox" :value="finding.kind" />复核后排除此告警：{{ finding.cause }}（须在说明中记录依据）</label>
              <div class="fieldGrid"><label>发现的问题<select v-model="observation"><option value="">没有发现问题</option><option v-for="item in observationKinds" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label></div>
              <label class="fullField">{{ observation ? "看到的具体情况（必填）" : "补充说明（选填）" }}<textarea v-model="reviewNote" rows="2" /></label>
              <template v-if="target.type === 'take'">
                <h3>片段结束时的实际状态</h3>
                <p class="reviewHint">已按镜头规格预填，只改与画面不符的地方；批准后下一镜继承这些记录。</p>
                <div class="fieldGrid"><label v-for="item in shotAssets" :key="item.id">{{ item.name }}<textarea v-model="stateNotes[item.id]" rows="2" /></label></div>
              </template>
              <button v-if="observation" type="button" :disabled="!reviewNote.trim()" @click="run(saveReview)">记录问题</button>
              <button v-else type="button" :disabled="!reviewFields.every(field => reviewedFields.includes(field[0])) || (target.type === 'take' && !fullPlayback)" @click="run(confirmVersion)">{{ target.type === "keyframe" ? "看过画面，选为主关键帧" : "完整看过，批准此 Take" }}</button>
              <article v-for="report in targetReports" :key="report.id" class="reviewReport"><strong>{{ report.score === null ? '检查未完成' : '已记录检查' }}</strong><p>{{ report.evidence?.note }}</p><p v-if="report.evidence?.vision?.reason">{{ report.evidence.vision.reason }}</p><p v-for="finding in report.findings" :key="finding.kind">{{ finding.cause }}：{{ finding.note }}<br />修复：{{ finding.detail }}</p></article>
            </template>
            <template v-if="candidatePool.length">
              <h3>抽卡批次对比</h3>
              <p class="reviewHint">同一批提示词的产物并排比较：打分后选出定妆图，后续镜头默认沿用该参考，抽卡成本才回得来。</p>
              <div class="candidateGrid">
                <figure v-for="item in candidatePool" :key="item.id" :class="{ promoted: item.status === 'promoted' }">
                  <img v-if="item.media?.mime.startsWith('image/')" :src="mediaUrl(item.media.url)" :alt="`候选 ${item.id.slice(-5)}`" />
                  <video v-else-if="item.media?.mime.startsWith('video/')" :src="mediaUrl(item.media.url)" controls preload="metadata" />
                  <figcaption>{{ item.id.slice(-5) }} · {{ statusLabel(item.status) }}<template v-if="item.scores?.overall != null"> · {{ item.scores.overall }} 分</template></figcaption>
                  <div class="candidateActions">
                    <input v-model.number="candidateScores[item.id]" type="number" min="0" max="100" placeholder="分" :disabled="item.status === 'promoted'" />
                    <button type="button" :disabled="item.status === 'promoted' || candidateScores[item.id] == null" @click="run(() => scoreOne(item))">打分</button>
                    <button type="button" :disabled="item.status === 'promoted'" @click="run(() => promoteOne(item))">采用为定妆图</button>
                  </div>
                </figure>
              </div>
            </template>
          </template>
        </template>
        <productionEdit ref="editPanel" v-show="section === 'edit'" :directory="directory" :sequences="sequences" :shots="shots" :references="references" :request="request" />
      </fieldset>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, inject, onScopeDispose, ref, toRaw, watch } from "vue";
import productionEdit from "./productionEdit.vue";
import type { CanvasContext } from "@toonflow/tool-canvas/runtime";
const editPanel = ref<InstanceType<typeof productionEdit>>();
const getCanvas = inject<() => CanvasContext | undefined>("canvas");
import { ElMessageBox } from "element-plus";
import type { MediaModel } from "@toonflow/tools-scaffold/runtime";
import { cameraTrajectorySchema, type CameraTrajectory } from "@toonflow/tools-scaffold/runtime";
const visible = defineModel<boolean>({ default: false });
const props = defineProps<{ projectId?: string; directory: string }>();
const projectId = props.projectId;
const section = ref("world"), busy = ref(false), error = ref(""), message = ref("");
const controller = new AbortController();
let pollTimer: ReturnType<typeof setTimeout> | undefined;
onScopeDispose(() => { controller.abort(); clearTimeout(pollTimer); clearInterval(watchTimer); });
const tabs = [{ id: "world", label: "世界与资产" }, { id: "shot", label: "镜头规格" }, { id: "generate", label: "生成" }, { id: "review", label: "检查与采用" }, { id: "edit", label: "剪辑与衔接" }];
const worldFields = [["era", "年代"], ["locationLogic", "地点与空间逻辑"], ["architecture", "建筑"], ["weather", "天气"], ["time", "时间"], ["material", "环境材质"], ["physics", "物理规则"], ["realism", "影像媒介（摄影写实、动画等）"]];
const lookFields = [["contrast", "对比"], ["saturation", "饱和度"], ["skinTone", "肤色"], ["highlightRolloff", "高光滚降"], ["shadowBehavior", "暗部表现"], ["lensCharacter", "镜头特性"], ["texture", "纹理"], ["sharpnessPhilosophy", "锐度策略"]];
const cameraFields = [["shotSize", "景别"], ["position", "机位"], ["focus", "焦点"], ["depth", "景深"], ["motion", "摄影机运动"], ["motivation", "运镜动机"], ["axisCrossing", "越轴动机（没有则留空）"]];
const designFields = [["technique", "技术"], ["purpose", "叙事目的"], ["start", "起始状态"], ["end", "结束状态"], ["subjectPath", "主体路线"], ["cameraPath", "相机路线"], ["timing", "动作、对白与停顿预算"], ["cut", "出入剪点"], ["fallback", "能力不足时的替代"]];
const lightingFields = [["worldSource", "光源在场景中的固定位置"], ["motivatedLight", "光源依据"], ["key", "主光方向与软硬"], ["fill", "补光"], ["negativeFill", "负补光"], ["exposure", "曝光主体与策略"], ["colorTemp", "色温"]];
const performanceFields = [["emotion", "情绪"], ["eyeline", "视线"], ["lookTarget", "注视对象"], ["gesture", "表演动作"], ["timing", "表演节拍"]];
const blockingFields = [["foreground", "前景"], ["midground", "人物走位与中景"], ["background", "背景"]];
const realismFields = [["surface", "表面材质", "逐项说明皮肤、头发、布料或物体的纹理与反光，避免统一磨皮。"], ["imaging", "成像", "曝光、高光、暗部、焦平面与光学表现。"], ["world", "空间与物理", "比例、接触、遮挡与物体恒常。"], ["motion", "运动", "动作起止、重心、受力、惯性与次级运动；视频必填。"], ["cinematic", "电影语言", "表演、调度、镜头职责与剪辑衔接。"]];
const functions = [["Establish", "建立"], ["Reveal", "揭示"], ["Reaction", "反应"], ["Contrast", "对比"], ["Transition", "过渡"], ["Match", "匹配"], ["Rhythm", "节奏"]];
const assetTypes = [["Character", "人物"], ["Environment", "场景"], ["Wardrobe", "服装"], ["Prop", "道具"], ["Product", "产品"], ["Vehicle", "车辆"]];
const personaAxes = [
  { key: "bearing", label: "气质", poles: [["poised", "沉稳"], ["liveliness", "灵动"]] },
  { key: "gaze", label: "观感", poles: [["striking", "抓眼"], ["enduring", "耐看"]] },
  { key: "focus", label: "状态", poles: [["focused", "聚焦"], ["relaxed", "松弛"]] },
  { key: "rapport", label: "距离", poles: [["distant", "疏远"], ["familiar", "亲近"]] },
] as const;
const personaLabel: Record<string, string> = { poised: "沉稳", liveliness: "灵动", striking: "抓眼", enduring: "耐看", focused: "聚焦", relaxed: "松弛", distant: "疏远", familiar: "亲近" };
const hasPersonaTags = (tags: any) => !!tags && Object.values(tags).some(Boolean);
const personaSummary = (tags: any) => Object.values(tags ?? {}).filter(Boolean).map(v => personaLabel[v as string] ?? v).join(" / ");
const assetTypeLabel = (type: string) => assetTypes.find(item => item[0] === type)?.[1] ?? type;
const libraryAssets = ref<any[]>([]), librarySearched = ref(false), librarySourceIds = ref(new Set<string>());
const libraryFilter = ref<Record<string, string>>({ type: "Character", bearing: "", gaze: "", focus: "", rapport: "" });
const asBatch = ref(false), batchId = ref(""), batchAssetId = ref(""), candidateBatches = ref<any[]>([]);
const candidatePool = ref<any[]>([]), candidateScores = ref<Record<string, number | null>>({});
const statusLabel = (status: string) => ({ candidate: "待评", promoted: "已采用", rejected: "落选" }[status] ?? status);
const roles = [["IDENTITY", "身份"], ["GEOMETRY", "几何"], ["WARDROBE", "服装"], ["ENVIRONMENT", "场景"], ["COMPOSITION", "构图"], ["LIGHTING", "光线"], ["LOOK", "影调"], ["END_FRAME", "尾帧"], ["PERFORMANCE", "表演视频"], ["CAMERA_MOTION", "运镜视频"], ["AUDIO", "音频"]];
const observationKinds = [["anatomy_failure", "多肢、身体结构或遮挡错误"], ["wardrobe_drift", "服装或商品形状漂移"], ["plastic_surface", "塑料材质或磨皮"], ["imaging_failure", "曝光或光学不可信"], ["temporal_drift", "视频身份或材质漂移"], ["performance_failure", "表演或运镜不可信"], ["motion_physics", "动作受力或接触错误"], ["scene_structure", "场景结构错误"], ["identity_drift", "身份漂移"], ["hand_artifact", "手部错误"], ["face_artifact", "面部错误"], ["color_shift", "色差"]];
const world = ref<Record<string, any>>({}), look = ref<Record<string, any>>({}), worldDirty = ref(false);
const assets = ref<any[]>([]), shots = ref<any[]>([]), sequences = ref<any[]>([]), references = ref<any[]>([]);
const editingAsset = ref(""), assetVersions = ref<any[]>([]);
const emptyPersona = () => ({ bearing: "", gaze: "", focus: "", rapport: "" });
const asset = ref({ type: "Character", name: "", description: "", invariants: "", personaTags: emptyPersona() });
let savedAsset = JSON.stringify(asset.value);
let pendingRequestId = "";
const binding = ref({ referenceId: "", role: "IDENTITY", lockLevel: "LOCK", weight: 1 });
const cropEnabled = ref(false), referenceCrop = ref({ x: 0, y: 0, width: 1, height: 1, unit: "normalized" });
const compiledMedia = ref<any[]>([]);
let baseUpdatedAt: string | undefined;
const shotId = ref(""), draft = ref<any>(null), detail = ref<any>(null), dirty = ref(false);
const kind = ref("image"), modelKey = ref(""), modeKey = ref(""), resolution = ref(""), duration = ref(4), size = ref(""), ratio = ref("16:9");
const visualModels = ref<any[]>([]), visionModelKey = ref("");
const models = ref<MediaModel[]>([]), preview = ref<any>(null), jobs = ref<any[]>([]);
const cameraTrajectory = ref<CameraTrajectory>();
const imageAndCameraOnly = ref(false);
const stateNotes = ref<Record<string, string>>({});
const shotAssets = computed(() => assets.value.filter(item => detail.value?.assetIds?.includes(item.id)));
const targetId = ref(""), reviewNote = ref(""), observation = ref("");
const reviewedFields = ref<string[]>([]), dismissedKinds = ref<string[]>([]), fullPlayback = ref(false);
const keyOf = (model: MediaModel) => JSON.stringify([model.providerId, model.modelId]);
const availableModels = computed(() => models.value.filter(model => model.type === kind.value));
const selectedModel = computed(() => availableModels.value.find(model => keyOf(model) === modelKey.value));
const modes = computed(() => Array.isArray(selectedModel.value?.mode) ? selectedModel.value!.mode as unknown[] : []);
const resolutions = computed(() => [...new Set(selectedModel.value?.durationResolutionMap?.flatMap(rule => rule.resolution) ?? [])]);
const durations = computed(() => [...new Set(selectedModel.value?.durationResolutionMap?.filter(rule => rule.resolution.includes(resolution.value)).flatMap(rule => rule.duration) ?? [])]);
const versions = computed(() => [...(detail.value?.keyframes ?? []).map((item: any) => ({ ...item, type: "keyframe" })), ...(detail.value?.takes ?? []).map((item: any) => ({ ...item, type: "take" }))]);
const target = computed(() => versions.value.find(item => item.id === targetId.value));
const targetReports = computed(() => (detail.value?.qc ?? []).filter((report: any) => report.targetId === targetId.value).reverse());
const priorFindings = computed(() => (targetReports.value[0]?.findings ?? []).filter((item: any) => !item.kind.startsWith("continuity:")));
const reviewFields = computed(() => realismFields.filter(field => target.value?.type === "take" || field[0] !== "motion"));
const mediaUrl = (url: string) => url.startsWith("/") ? `/cloud${url}` : url;
const modeLabel = (mode: unknown) => Array.isArray(mode) ? `多参考 (${mode.join(" / ")})` : ({ singleImage: "首帧", startFrameOptional: "首帧可选", startEndRequired: "首尾帧", endFrameOptional: "首帧与可选尾帧", text: "纯文本" }[String(mode)] ?? String(mode));
const generateAudio = ref(false);
watch([kind, modelKey, modeKey, resolution, duration, size, ratio, shotId, generateAudio], () => { preview.value = null; pendingRequestId = ""; });
watch(selectedModel, model => { modeKey.value = ""; resolution.value = ""; size.value = model?.imageSizes?.[0] ?? ""; ratio.value = model?.cameraTrajectory ? "20:11" : model?.imageRatios?.[0] ?? "16:9"; });
watch([cameraTrajectory, imageAndCameraOnly], () => { preview.value = null; pendingRequestId = ""; }, { deep: true });
watch([shotId, modelKey], () => { cameraTrajectory.value = undefined; imageAndCameraOnly.value = false; });
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
  await refreshLibrarySources().catch(() => {});
  await refreshJobs();
}
let loaded = false;
// 面板开着时每 10 秒检查一次别处发起的任务；打开时立即检查一次。
let watchTimer: ReturnType<typeof setInterval> | undefined;
watch(visible, open => {
  clearInterval(watchTimer);
  if (!open) return;
  if (!loaded) void run(async () => { await load(); loaded = true; });
  else void refreshJobs().catch(() => {});
  watchTimer = setInterval(() => { if (loaded && !busy.value) void refreshJobs().catch(() => {}); }, 10000);
}, { immediate: true });
async function saveWorld() {
  await request(`/projects/${projectId}/world`, "PUT", world.value);
  await request(`/projects/${projectId}/looks/project`, "PUT", look.value);
  worldDirty.value = false; preview.value = null; message.value = "世界与影调已保存";
}
function clearAsset() { editingAsset.value = ""; assetVersions.value = []; asset.value = { type: "Character", name: "", description: "", invariants: "", personaTags: emptyPersona() }; savedAsset = JSON.stringify(asset.value); }
async function editAsset(item: any) {
  if (JSON.stringify(asset.value) !== savedAsset) throw new Error("请先保存当前资产，再切换编辑对象");
  const value = await request(`/assets/${item.id}`); editingAsset.value = item.id; assetVersions.value = value.versions;
  asset.value = { type: value.type, name: value.name, description: value.description, invariants: value.invariants.join("\n"), personaTags: { ...emptyPersona(), ...(value.personaTags ?? {}) } };
  savedAsset = JSON.stringify(asset.value);
}
const personaPayload = (tags: Record<string, string>) => Object.fromEntries(Object.entries(tags).filter(([, v]) => v));
async function createAsset() {
  if (editingAsset.value) await ElMessageBox.confirm("将建立新的资产版本，已采用镜头需重新检查。历史版本保留。", "建立版本", { confirmButtonText: "建立", cancelButtonText: "取消" });
  const tags = personaPayload(asset.value.personaTags);
  const item = await request(editingAsset.value ? `/assets/${editingAsset.value}/versions` : `/projects/${projectId}/assets`, "POST", { ...asset.value, invariants: asset.value.invariants.split(/\n/).map(value => value.trim()).filter(Boolean), ...(Object.keys(tags).length ? { personaTags: tags } : {}) });
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
async function publishAsset(id: string) {
  const entry = await request(`/library/assets/${id}/publish`, "POST", {});
  await refreshLibrarySources();
  message.value = `已入池角色库：${entry.name}`;
}
async function searchLibraryAssets() {
  const params = new URLSearchParams(Object.entries(libraryFilter.value).filter(([, v]) => v));
  const rows = await request(`/library/assets${params.size ? "?" + params : ""}`);
  libraryAssets.value = rows; librarySearched.value = true;
}
async function refreshLibrarySources() {
  const rows = await request("/library/assets");
  librarySourceIds.value = new Set(rows.map((row: any) => row.sourceAssetId).filter(Boolean));
}
async function importLibraryAsset(entry: any) {
  const created = await request(`/projects/${projectId}/library/import/${entry.id}`, "POST", {});
  assets.value = [...assets.value, created];
  entry.reuseCount += 1;
  message.value = `已导入：${created.name}（继承定妆参考）`;
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
  duration.value = draft.value.generationDuration ?? draft.value.duration;
  generateAudio.value = draft.value.musicVideo?.audioMode === "generated";
  selectPendingVersion();
  void refreshJobs().catch(() => {});
  await refreshCandidatePool();
}
async function refreshCandidatePool() {
  candidateBatches.value = await request(`/projects/${projectId}/candidateBatches`);
  const shotBatch = [...candidateBatches.value].reverse().find(item => item.shotId === shotId.value);
  if (!shotBatch) { candidatePool.value = []; candidateScores.value = {}; return; }
  batchId.value = shotBatch.id;
  candidatePool.value = await request(`/candidateBatches/${shotBatch.id}/candidates`);
  candidateScores.value = Object.fromEntries(candidatePool.value.map(item => [item.id, item.scores?.overall ?? null]));
}
async function scoreOne(item: any) {
  const overall = candidateScores.value[item.id];
  if (overall == null) return;
  await request(`/candidates/${item.id}/score`, "POST", { scores: { overall } });
  message.value = "已记录评分";
}
async function promoteOne(item: any) {
  await ElMessageBox.confirm("采用后，该候选将成为绑定资产的定妆参考，后续镜头默认沿用。同批其余候选标记落选。", "采用定妆图", { confirmButtonText: "采用", cancelButtonText: "取消" });
  const result = await request(`/candidates/${item.id}/promote`, "POST", {});
  await refreshCandidatePool();
  message.value = result.heroKeyframeId ? "已采用并同步为主关键帧" : "已采用为资产定妆参考";
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
async function bindReference() { await saveShot(); await request(`/shots/${shotId.value}/bindings`, "POST", { ...binding.value, ...(cropEnabled.value ? { crop: referenceCrop.value } : {}) }); detail.value = await request(`/shots/${shotId.value}`); preview.value = null; }
async function removeBinding(item: any) {
  await ElMessageBox.confirm("解除此参考将改变镜头约束，已有输出需重新检查。", "解除参考", { confirmButtonText: "解除", cancelButtonText: "取消" });
  await request(`/bindings/${item.id}?confirm=1`, "DELETE"); detail.value = await request(`/shots/${shotId.value}`); preview.value = null;
}
function generationRequest() {
  const model = selectedModel.value; if (!model) throw new Error("请选择模型");
  if (model.cameraTrajectory && (!cameraTrajectory.value || !imageAndCameraOnly.value)) throw new Error("请导入轨迹并确认图像与相机控制范围");
  return { providerId: model.providerId, modelId: model.modelId, ratio: ratio.value, ...(kind.value === "image" ? (size.value ? { size: size.value } : {}) : { mode: modeKey.value ? JSON.parse(modeKey.value) : undefined, resolution: resolution.value, duration: duration.value, ...(draft.value?.musicVideo && model.audio === "optional" ? { generateAudio: generateAudio.value } : {}), ...(model.cameraTrajectory ? { cameraTrajectory: cameraTrajectorySchema.parse(cameraTrajectory.value), imageAndCameraOnly: imageAndCameraOnly.value } : {}) }) };
}
async function loadTrajectory(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const currentShot = shotId.value, currentModel = modelKey.value;
  cameraTrajectory.value = undefined; imageAndCameraOnly.value = false;
  if (!file) return;
  if (file.size > 512 * 1024) throw new Error("轨迹文件超过 512 KB");
  const document = JSON.parse(await file.text());
  const trajectory = cameraTrajectorySchema.parse(document.cameraTrajectory ?? document);
  if (shotId.value !== currentShot || modelKey.value !== currentModel) throw new Error("镜头或模型已切换，请重新导入轨迹");
  cameraTrajectory.value = trajectory;
  input.value = "";
}
async function production(requestId?: string, candidateBatchId?: string) {
  const response = await fetch("/api/ai/media/production", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory: props.directory, shotId: shotId.value, kind: kind.value, request: generationRequest(), requestId, fingerprint: preview.value?.fingerprint, ...(candidateBatchId ? { candidateBatchId } : {}) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.message || "镜头生成失败"); return result.data;
}
async function compile() { if (kind.value === "video" && draft.value.generationDuration !== duration.value) { draft.value.generationDuration = duration.value; dirty.value = true; } await saveShot(); if (worldDirty.value) await saveWorld(); preview.value = await production(); compiledMedia.value = await Promise.all(preview.value.compiled.inputs.filter((item: any) => item.sent && item.mediaId).map(async (item: any) => ({ ...await request(`/media/${item.mediaId}`), role: item.role }))); pendingRequestId = ""; }
async function generate() {
  pendingRequestId ||= crypto.randomUUID();
  let candidateBatchId = batchId.value || undefined;
  if (asBatch.value && !candidateBatchId) {
    const batch = await request(`/projects/${projectId}/candidateBatches`, "POST", { kind: kind.value, promptFingerprint: preview.value?.fingerprint ?? crypto.randomUUID(), shotId: shotId.value, ...(batchAssetId.value ? { assetId: batchAssetId.value } : {}) });
    candidateBatchId = batch.id;
  }
  await production(pendingRequestId, candidateBatchId); pendingRequestId = ""; preview.value = null; message.value = "生成任务已提交";
  asBatch.value = false; batchAssetId.value = "";
  await refreshJobs();
}
// 助手或画布在别处发起的任务也要跟上：任务出现或状态变化时刷新当前镜头，几秒内跑完的任务也不会漏。
let jobSignature = "";
async function refreshJobs() {
  const result = await request(`/generations?projectId=${encodeURIComponent(projectId!)}`);
  jobs.value = (Array.isArray(result) ? result : result.items ?? []).filter((job: any) => job.targetType === "shot");
  const signature = jobs.value.map(job => `${job.id}:${job.status}`).join(",");
  const changed = jobSignature !== "" && signature !== jobSignature;
  jobSignature = signature;
  clearTimeout(pollTimer);
  if (jobs.value.some(job => ["QUEUED", "RUNNING"].includes(job.status))) pollTimer = setTimeout(() => void refreshJobs().catch(cause => { if (!controller.signal.aborted) error.value = cause.message; }), 1800);
  if (changed) await refreshResults();
}
async function refreshResults() {
  if (shotId.value) {
    detail.value = await request(`/shots/${shotId.value}`);
    const { id, heroKeyframeId, approvedTakeId } = detail.value;
    shots.value = shots.value.map(shot => shot.id === id ? { ...shot, heroKeyframeId, approvedTakeId } : shot);
    if (!targetId.value) selectPendingVersion();
  }
  window.dispatchEvent(new Event("littoProductionUpdated"));
}
// 直接选中待处理的版本：没有主关键帧选最新关键帧，有了选最新未批准的 Take；当前选中的仍待处理就保留。
function selectPendingVersion() {
  const current = target.value;
  if (current && ["variant", "candidate"].includes(current.status)) return;
  const newest = (type: string, status: string) => versions.value.filter(item => item.type === type && item.status === status)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).at(-1);
  const pending = !detail.value?.heroKeyframeId ? newest("keyframe", "variant") : !detail.value?.approvedTakeId ? newest("take", "candidate") : undefined;
  if (pending) selectVersion(pending);
  else targetId.value = "";
}
// 按镜头顺序找下一个还没批准 Take 的镜头，连续检查时不用回到镜头条。
const nextPendingShot = computed(() => {
  const ordered = [...shots.value].sort((left, right) => left.ord - right.ord);
  const index = ordered.findIndex(shot => shot.id === shotId.value);
  return [...ordered.slice(index + 1), ...ordered.slice(0, Math.max(index, 0))].find(shot => !shot.approvedTakeId && shot.id !== shotId.value);
});
async function cancelJob(id: string) { await request(`/generations/${id}/cancel`, "POST", {}); await refreshJobs(); }
// 结束状态按镜头规格推算的计划结果预填，用户只改与画面不符的地方。
const stateKinds: Record<string, string> = { Character: "characters", Wardrobe: "wardrobe", Environment: "environment" };
const kindOf = (type: string) => stateKinds[type] ?? "props";
function plannedNote(value: unknown) {
  if (!value || typeof value !== "object") return "与开始时一致";
  const state = value as Record<string, unknown>;
  if (typeof state.note === "string" && state.note.trim()) return state.note;
  const parts: string[] = [];
  if (state.present === true) parts.push("在场");
  if (state.present === false) parts.push("不在画面中");
  if (typeof state.heldBy === "string" && state.heldBy !== "unknown") parts.push(`由 ${assets.value.find(item => item.id === state.heldBy)?.name ?? state.heldBy} 拿着`);
  for (const [key, item] of Object.entries(state)) {
    if (["name", "present", "heldBy", "note"].includes(key) || item === null || item === "") continue;
    parts.push(`${key}：${typeof item === "object" ? JSON.stringify(item) : item}`);
  }
  return parts.join("，") || "与开始时一致";
}
// 预填时记下计划状态：用户没改的资产连同结构化字段（如 heldBy）一起提交，连续性检查才能继续按字段比对。
let plannedStates: Record<string, { state: Record<string, unknown> | undefined; note: string }> = {};
function selectVersion(item: any) {
  targetId.value = item.id; reviewNote.value = ""; observation.value = "";
  reviewedFields.value = []; dismissedKinds.value = []; fullPlayback.value = false;
  const planned = detail.value?.state?.result ?? {};
  plannedStates = Object.fromEntries(shotAssets.value.map(asset => {
    const state = planned[kindOf(asset.type)]?.[asset.id];
    return [asset.id, { state, note: plannedNote(state) }];
  }));
  stateNotes.value = Object.fromEntries(Object.entries(plannedStates).map(([id, item]) => [id, item.note]));
}
async function autoReview() { const item = target.value; await request(`/shots/${shotId.value}/qc`, "POST", { targetType: item.type, targetId: item.id, auto: true, visionModel: { providerId: JSON.parse(visionModelKey.value)[0], modelId: JSON.parse(visionModelKey.value)[1] } }); await refreshResults(); }
// 仅提交用户实际确认的维度；不把点击批准转换为所有维度自动通过。
function reviewPayload(item: any) {
  const observedStateDelta: Record<string, Record<string, unknown>> = {};
  if (item.type === "take") for (const asset of shotAssets.value) {
    const note = stateNotes.value[asset.id]?.trim() || "与开始时一致";
    const planned = plannedStates[asset.id];
    // 改过的说明以用户为准，规格里的结构化字段可能已不成立，只记文字。
    (observedStateDelta[kindOf(asset.type)] ??= {})[asset.id] = planned && note === planned.note && planned.state ? { ...planned.state, note } : { note };
  }
  return { targetType: item.type, targetId: item.id, reviewed: reviewedFields.value, note: reviewNote.value, fullPlayback: fullPlayback.value, dismissedKinds: dismissedKinds.value,
    ...(item.type === "take" ? { observedStateDelta } : {}), observations: observation.value ? [{ kind: observation.value, note: reviewNote.value }] : [] };
}
async function saveReview() {
  await request(`/shots/${shotId.value}/qc`, "POST", reviewPayload(target.value));
  await refreshResults(); message.value = "问题已记录，可按修复建议重新生成";
}
async function confirmVersion() {
  const item = target.value;
  const sequenceId = detail.value.sequenceId;
  const context = getCanvas?.();
  const canvasId = context?.id;
  await request(`/shots/${shotId.value}/qc`, "POST", reviewPayload(item));
  const result = await request(`/${item.type === "keyframe" ? "keyframes" : "takes"}/${item.id}/${item.type === "keyframe" ? "promote" : "approve"}`, "POST", {});
  await refreshResults(); selectPendingVersion();
  message.value = result.autoRenderError || (result.autoRender ? "全部镜头已采用，正在合成成片；完成后自动展示到画布" : item.type === "keyframe" ? "主关键帧已选定" : "Take 已批准，结束状态已记录");
  if (result.autoRender) {
    section.value = "edit";
    await editPanel.value?.trackRender(result.autoRender.id, sequenceId, context && canvasId ? { context, id: canvasId } : undefined);
  }
}
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
  .libraryList { padding: 0; list-style: none; li { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--studioBorder); } figure { width: 64px; flex: none; margin: 0; img { width: 64px; height: 64px; object-fit: cover; border-radius: var(--ui-radius); } } .libraryMeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; small { color: var(--studioMuted); } } button { flex: none; } }
  .candidateGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin-top: 12px; figure { margin: 0; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); padding: 8px; img, video { width: 100%; max-height: 220px; object-fit: contain; background: var(--studioRail); } &.promoted { border-color: var(--studioDone); border-width: 2px; } figcaption { font-size: 12px; margin: 8px 0; } .candidateActions { display: flex; gap: 8px; align-items: center; input { width: 64px; flex: none; min-height: 36px; } button { min-height: 36px; padding: 4px 10px; font-size: 12px; flex: none; } } } }
  .sentReferences { display: flex; flex-wrap: wrap; gap: 12px; figure { width: 180px; margin: 0; img, video, audio { width: 100%; max-height: 180px; object-fit: contain; } figcaption { overflow-wrap: anywhere; font-size: 12px; } } }
  .outputPreview { display: block; width: 100%; max-height: 420px; object-fit: contain; background: var(--studioRail); margin: 16px 0; }
  .generationPreview, .reviewReport { padding: 16px 0; border-top: 1px solid var(--studioBorder); margin-top: 16px; }
  .errorMessage, .attention { color: var(--studioAttention); }
  .statusMessage { color: var(--studioDone); }
  .fullField { margin: 16px 0; }
  .reviewHint { margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: var(--studioMuted); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
  small { color: var(--studioMuted); }
  @media (max-width: 640px) { .fieldGrid { grid-template-columns: 1fr; } }
}
</style>
