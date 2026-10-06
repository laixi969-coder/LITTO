<template>
  <section class="productionEdit" :aria-busy="busy">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <fieldset :disabled="busy">
      <div class="editFields">
        <label>序列<select v-model="sequenceId"><option v-for="item in sequences" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <button type="button" @click="run(load)">刷新时间线</button>
        <button type="button" :disabled="!edit?.historyDepth" @click="run(() => history('undo'))">撤销</button>
        <button type="button" :disabled="!edit?.futureDepth" @click="run(() => history('redo'))">重做</button>
      </div>
      <template v-if="edit">
        <h3>素材使用区间</h3>
        <p>入出点为原素材秒数。保留首尾余量可用于动作匹配和声音桥，编辑不改变已采用源文件。</p>
        <div class="clipList">
          <article v-for="clip in videoClips" :key="clip.id">
            <strong>{{ clip.label || '视频片段' }} · {{ clip.duration.toFixed(2) }} 秒</strong>
            <video v-if="clip.source.media" :src="url(clip.source.media.url)" controls preload="metadata" />
            <div class="editFields">
              <label>素材入点<input v-model.number="ranges[clip.id].in" type="number" min="0" step="0.04" /></label>
              <label>素材出点<input v-model.number="ranges[clip.id].out" type="number" min="0" step="0.04" /></label>
              <button type="button" @click="run(() => trim(clip))">保存区间并顺排</button>
            </div>
          </article>
        </div>
        <h3>接缝与声音</h3>
        <label>相邻片段<select v-model="rightId"><option value="">选择接缝</option><option v-for="(clip, index) in videoClips.slice(1)" :key="clip.id" :value="clip.id">{{ videoClips[index].label }} → {{ clip.label }}</option></select></label>
        <template v-if="pair">
          <div class="editFields">
            <label>画面连接<select v-model="transition"><option value="cut">硬切</option><option value="dissolve">溶解</option><option value="fade_black">淡黑</option></select></label>
            <label>转场秒数<input v-model.number="transitionDuration" type="number" min="0" max="10" step="0.1" /></label>
            <button type="button" @click="run(setTransition)">应用画面连接</button>
            <button type="button" @click="run(suggest)">分析剪点候选</button>
            <button type="button" @click="run(previewCut)">生成接缝声画预览</button>
          </div>
          <p v-if="suggestionNote">{{ suggestionNote }}</p>
          <ul><li v-for="(candidate, index) in candidates" :key="index">候选 {{ index + 1 }}：前镜出点 {{ candidate.sourceOut.toFixed(2) }}s，后镜入点 {{ candidate.sourceIn.toFixed(2) }}s <button type="button" @click="run(() => useCut(candidate))">应用并预览</button></li></ul>
          <div class="editFields">
            <label>声音连接<select v-model="soundMode"><option value="jCut">后镜声音提前进入（J-cut）</option><option value="lCut">前镜声音延续（L-cut）</option><option value="crossfade">环境声交叉淡化</option><option value="none">恢复与画面同步</option></select></label>
            <label>声音桥秒数<input v-model.number="soundDuration" type="number" min="0" max="3" step="0.05" /></label>
            <button type="button" @click="run(bridge)">应用声音桥</button>
          </div>
          <p>声音桥会重设这两个片段的原生音轨区间并保持关联。交叉淡化适合环境声；混合音轨不会自动分离对白。请听音确认没有截字或重叠说话。</p>
          <video v-if="preview" class="seamPreview" :src="url(preview.url)" controls autoplay />
        </template>
        <details>
          <summary>独立声音素材</summary>
          <div class="editFields">
            <label>素材<select v-model="audioMediaId"><option value="">选择已导入音频</option><option v-for="item in references.filter(item => item.kind === 'audio')" :key="item.id" :value="item.mediaId">{{ item.name }}</option></select></label>
            <label>用途<select v-model="audioRole"><option value="dialogue">对白</option><option value="sfx">环境与音效</option><option value="music">音乐</option></select></label>
            <label>时间线起点<input v-model.number="audioStart" type="number" min="0" step="0.1" /></label>
            <label>使用时长<input v-model.number="audioDuration" type="number" min="0.1" step="0.1" /></label>
            <button type="button" :disabled="!audioMediaId" @click="run(addAudio)">加入声音轨</button>
          </div>
        </details>
        <details>
          <summary>声音轨音量与淡化</summary>
          <article v-for="clip in audioClips" :key="clip.id">
            <strong>{{ clip.label || '声音片段' }}{{ clip.linkedClipId ? ' · 随镜头移动' : ' · 独立时间位置' }}</strong>
            <div class="editFields">
              <label>音量（dB）<input v-model.number="clip.gainDb" type="number" min="-60" max="24" /></label>
              <label>淡入（秒）<input v-model.number="clip.fadeIn" type="number" min="0" :max="clip.duration" step="0.05" /></label>
              <label>淡出（秒）<input v-model.number="clip.fadeOut" type="number" min="0" :max="clip.duration" step="0.05" /></label>
              <button type="button" @click="run(() => ops([{ type: 'set_gain', id: clip.id, gainDb: clip.gainDb, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut }]))">保存声音</button>
              <button type="button" @click="run(() => ops([{ type: 'delete_clip', id: clip.id }]))">移除声音片段</button>
            </div>
          </article>
        </details>
        <details>
          <summary>多镜视频分段</summary>
          <p>选择已有视频，将真实区间映射到镜头。本操作替换主轨排片及其关联声音，可撤销；不会自动批准镜头。独立音乐保留。</p>
          <label>视频素材<select v-model="segmentMediaId"><option value="">选择素材</option><option v-for="item in videoMedia" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div v-for="(segment, index) in segments" :key="index" class="editFields">
            <label>镜头<select v-model="segment.shotId"><option v-for="shot in shots.filter(item => item.sequenceId === sequenceId)" :key="shot.id" :value="shot.id">{{ shot.title }}</option></select></label>
            <label>入点<input v-model.number="segment.in" type="number" min="0" step="0.04" /></label>
            <label>出点<input v-model.number="segment.out" type="number" min="0" step="0.04" /></label>
            <button type="button" @click="segments.splice(index, 1)">移除此段</button>
          </div>
          <button type="button" @click="segments.push({ shotId: '', in: 0, out: 1 })">添加区间</button>
          <button type="button" :disabled="!segments.length || !segmentMediaId" @click="run(mapSegments)">映射并替换主轨</button>
        </details>
        <h3>导出成片</h3>
        <div class="editFields">
          <label>尺寸<select v-model="exportSize"><option value="source">沿用首个主轨素材</option><option value="1920x1080">1920×1080</option><option value="1080x1920">1080×1920</option></select></label>
          <button type="button" @click="run(render)">导出当前剪辑</button>
          <button type="button" @click="run(loadRenders)">刷新导出状态</button>
        </div>
        <p>导出完成仅表示文件已生成。请检测最终文件并完整看听后逐项验收；自动信号检测不证明电影级质感。</p>
        <article v-for="item in renders" :key="item.id" class="finalReview">
          <p>{{ item.status === 'SUCCEEDED' ? '文件已生成' : item.status }} · {{ qualityLabels[item.quality?.status] || '未验收' }} <span v-if="item.error">{{ item.error }}</span></p>
          <template v-if="item.media">
            <a :href="url(item.media.url)" target="_blank" rel="noopener">查看导出文件</a>
            <button type="button" @click="run(() => analyzeQuality(item.id))">检测最终文件与声音接缝</button>
            <details v-if="qualityDrafts[item.id] && item.quality?.analysisId">
              <summary>最终声画验收</summary>
              <video class="seamPreview" :src="url(item.media.url)" controls preload="metadata" />
              <p>每项记录实际观察；有意静默或声音进入需解释告警，未解决则选返修。剪辑或素材改变后须重新导出。</p>
              <label v-for="field in qualityFields" :key="field[0]">{{ field[1] }}<select v-model="qualityDrafts[item.id].checks[field[0]]"><option value="unverified">未验证</option><option value="fail">需要返修</option><option value="pass">已检查通过</option></select></label>
              <label><input v-model="qualityDrafts[item.id].fullPlayback" type="checkbox" />已完整播放并试听此导出文件</label>
              <label>时间码、观察证据与复查结论<textarea v-model="qualityDrafts[item.id].note" rows="3" /></label>
              <div v-for="finding in item.quality.findings" :key="finding.id">
                <p>{{ finding.seconds === undefined ? '' : `${finding.seconds.toFixed(3)} 秒：` }}{{ finding.message }}</p>
                <label v-if="finding.severity !== 'block'">复听/复核依据（通过前必填）<textarea v-model="qualityDrafts[item.id].reasons[finding.id]" rows="2" /></label>
              </div>
              <button type="button" :disabled="!qualityDrafts[item.id].fullPlayback || item.quality.status === 'stale'" @click="run(() => saveQuality(item))">记录最终验收</button>
            </details>
          </template>
        </article>
      </template>
    </fieldset>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
const props = defineProps<{ sequences: any[]; shots: any[]; references: any[]; request: (path: string, method?: string, body?: unknown) => Promise<any> }>();
const sequenceId = ref(""), edit = ref<any>(null), busy = ref(false), error = ref(""), message = ref("");
const ranges = ref<Record<string, { in: number; out: number }>>({});
const rightId = ref(""), candidates = ref<any[]>([]), suggestionNote = ref(""), preview = ref<any>(null);
const transition = ref("cut"), transitionDuration = ref(0.3), soundMode = ref("jCut"), soundDuration = ref(0.2);
const audioMediaId = ref(""), audioRole = ref("sfx"), audioStart = ref(0), audioDuration = ref(1);
const segmentMediaId = ref(""), segments = ref<{ shotId: string; in: number; out: number }[]>([]);
const exportSize = ref("source"), renders = ref<any[]>([]);
const qualityFields = [["surface", "皮肤、头发与商品材质"], ["motion", "肢体、动作受力与手物接触"], ["lighting", "场景光源、曝光与光色"], ["continuity", "人物、服装、场景与剪点连续"], ["sound", "对白、环境声、音画同步与接缝"]];
const qualityLabels: Record<string, string> = { unverified: "未验收", fail: "需要返修", pass: "人工验收通过", stale: "版本已改变，须重新导出验收" };
const qualityDrafts = ref<Record<string, { analysisId: string; checks: Record<string, string>; fullPlayback: boolean; note: string; reasons: Record<string, string> }>>({});
let disposed = false;
onScopeDispose(() => { disposed = true; });
const videoClips = computed<any[]>(() => {
  const track = edit.value?.tracks.find((item: any) => item.kind === "video");
  return (edit.value?.clips ?? []).filter((clip: any) => clip.trackId === track?.id).sort((a: any, b: any) => a.start - b.start);
});
const audioClips = computed<any[]>(() => (edit.value?.clips ?? []).filter((clip: any) => edit.value.tracks.find((track: any) => track.id === clip.trackId)?.kind === "audio"));
const pair = computed(() => { const index = videoClips.value.findIndex(item => item.id === rightId.value); return index > 0 ? { left: videoClips.value[index - 1], right: videoClips.value[index] } : null; });
const videoMedia = computed(() => [...new Map([
  ...props.references.filter(item => item.kind === "video" && item.mediaId).map(item => ({ id: item.mediaId, name: item.name })),
  ...videoClips.value.filter(item => item.source.mime?.startsWith("video/")).map(item => ({ id: item.source.mediaId, name: item.label })),
].map(item => [item.id, item])).values()]);
const url = (value: string) => value.startsWith("/") ? `/cloud${value}` : value;
const path = () => `/sequences/${sequenceId.value}/edit`;
const pairInput = () => { if (!pair.value) throw new Error("请选择接缝"); return { leftId: pair.value.left.id, rightId: pair.value.right.id, leftMediaId: pair.value.left.source.mediaId, rightMediaId: pair.value.right.source.mediaId, expectedVersion: edit.value.version }; };
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true; error.value = ""; message.value = "";
  try { await action(); } catch (cause) { if (!disposed && cause !== "cancel" && cause !== "close") error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
function accept(value: any) {
  edit.value = value; candidates.value = []; suggestionNote.value = ""; preview.value = null;
  ranges.value = Object.fromEntries(value.clips.map((clip: any) => [clip.id, { in: clip.in, out: clip.out }]));
  if (!value.clips.some((clip: any) => clip.id === rightId.value)) rightId.value = "";
}
async function load() { if (!sequenceId.value) return; accept(await props.request(path())); }
async function ops(operations: any[]) { accept(await props.request(`${path()}/ops`, "POST", { expectedVersion: edit.value.version, ops: operations })); }
async function history(direction: string) { accept(await props.request(`${path()}/${direction}`, "POST", {})); }
watch(() => props.sequences, values => { if (!sequenceId.value && values.length) sequenceId.value = values[0].id; }, { immediate: true });
watch(sequenceId, () => { edit.value = null; renders.value = []; void run(load); }, { immediate: true });
watch(rightId, () => { candidates.value = []; suggestionNote.value = ""; preview.value = null; transition.value = pair.value?.right.transition.type ?? "cut"; });
async function trim(clip: any) {
  if (clip.transition.type !== "cut") throw new Error("请先将该片段设为硬切，再修剪区间");
  const range = ranges.value[clip.id];
  await ops([{ type: "trim_clip", id: clip.id, in: range.in, out: range.out, start: clip.start, ripple: true }]);
}
async function suggest() { const result = await props.request(`${path()}/suggestCuts`, "POST", pairInput()); candidates.value = result.candidates; suggestionNote.value = result.note; }
async function previewCut() { preview.value = (await props.request(`${path()}/previewCut`, "POST", pairInput())).media; }
async function useCut(candidate: any) { await ops([{ type: "set_cut", ...pairInput(), sourceOut: candidate.sourceOut, sourceIn: candidate.sourceIn }]); await previewCut(); }
async function setTransition() { if (!pair.value) return; await ops([{ type: "set_transition", id: pair.value.right.id, transition: { type: transition.value, duration: transition.value === "cut" ? 0 : transitionDuration.value } }]); }
async function bridge() { accept(await props.request(`${path()}/soundBridge`, "POST", { ...pairInput(), mode: soundMode.value, duration: soundDuration.value })); await previewCut(); }
async function addAudio() {
  const track = edit.value.tracks.find((item: any) => item.kind === "audio" && item.role === audioRole.value && !item.locked);
  if (!track) throw new Error("该用途的声音轨不存在或已锁定");
  await ops([{ type: "add_clip", clip: { trackId: track.id, type: "media", mediaId: audioMediaId.value, start: audioStart.value, duration: audioDuration.value, fadeIn: 0.05, fadeOut: 0.05 } }]);
}
async function mapSegments() {
  await ElMessageBox.confirm("将用所列区间替换当前主轨及其关联声音，独立音乐保留；可通过撤销恢复。", "替换主轨", { confirmButtonText: "替换", cancelButtonText: "取消" });
  await ops([{ type: "map_segments", mediaId: segmentMediaId.value, segments: segments.value }]);
}
async function loadRenders() {
  renders.value = await props.request(`/sequences/${sequenceId.value}/renders`);
  for (const item of renders.value) if (item.quality?.analysisId && qualityDrafts.value[item.id]?.analysisId !== item.quality.analysisId) {
    qualityDrafts.value[item.id] = { analysisId: item.quality.analysisId, checks: Object.fromEntries(qualityFields.map(field => [field[0], "unverified"])), fullPlayback: false, note: "", reasons: {} };
  }
}
async function analyzeQuality(id: string) { await props.request(`/renders/${id}/quality/analyze`, "POST", {}); await loadRenders(); }
async function saveQuality(item: any) {
  const draft = qualityDrafts.value[item.id];
  await props.request(`/renders/${item.id}/quality/review`, "POST", { analysisId: draft.analysisId, checks: draft.checks, fullPlayback: draft.fullPlayback, note: draft.note, acknowledgements: Object.entries(draft.reasons).filter(([, reason]) => reason.trim()).map(([id, reason]) => ({ id, reason })) });
  await loadRenders();
}
async function render() {
  const [width, height] = exportSize.value.split("x").map(Number);
  await props.request(`/sequences/${sequenceId.value}/render`, "POST", exportSize.value === "source" ? {} : { width, height });
  message.value = "导出已提交，刷新状态查看结果"; await loadRenders();
}
</script>

<style scoped lang="scss">
.productionEdit {
  fieldset { border: 0; padding: 0; min-width: 0; }
  label { display: flex; flex-direction: column; gap: 6px; }
  input, select, button { min-height: 40px; padding: 8px; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); background: var(--studioSurface); color: var(--studioInk); font: inherit; }
  button { cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  :is(button, input, select, summary):focus-visible { outline: 2px solid var(--studioDone); outline-offset: 2px; }
  .editFields { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin: 12px 0; label { flex: 1; min-width: 140px; } }
  .clipList { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; article { border: 1px solid var(--studioBorder); padding: 12px; video { display: block; width: 100%; max-height: 220px; margin-top: 8px; } } }
  .seamPreview { width: 100%; max-height: 420px; background: black; }
  details { margin: 20px 0; summary { cursor: pointer; padding: 10px 0; } }
  p { line-height: 1.6; color: var(--studioMuted); }
  [role="alert"] { color: var(--studioAttention); }
}
</style>
