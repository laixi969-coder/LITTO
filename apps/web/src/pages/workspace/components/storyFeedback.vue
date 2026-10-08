<template>
  <section class="storyFeedback">
    <p>记录真实发布版本与观察口径。故事关注理解、记忆和继续观看；效果广告关注卖点理解与行动；品牌片关注品牌记忆；MV 关注音乐与画面的关系。播放量不能独立证明作品优秀。</p>
    <div class="fields">
      <label>故事版本<select v-model="draft.revisionId" @change="draft.previewId = ''"><option value="">选择版本</option><option v-for="(revision, index) in project.revisions" :key="revision.id" :value="revision.id">版本 {{ index + 1 }} · {{ revision.title }}</option></select></label>
      <label>关联预演（可选）<select v-model="draft.previewId"><option value="">不关联预演</option><option v-for="preview in project.previews.filter(item => item.revisionId === draft.revisionId)" :key="preview.id" :value="preview.id">{{ preview.createdAt }}</option></select></label>
      <label v-for="field in textFields" :key="field.key">{{ field.label }}<input v-model="draft[field.key]" :type="field.key === 'publishedAt' ? 'date' : 'text'" /></label>
      <label>分发方式<select v-model="draft.distribution"><option value="organic">自然流量</option><option value="paid">付费投放</option><option value="mixed">混合</option></select></label>
      <label v-for="field in metrics" :key="field.key">{{ field.label }}（未知留空）<input :value="draft[field.key] ?? ''" type="number" min="0" :step="field.key === 'spend' ? '0.01' : '1'" @input="draft[field.key] = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)" /></label>
    </div>
    <label>统计口径<textarea v-model="draft.metricDefinitions" rows="2" /></label>
    <label>数据来源或观众原话<textarea v-model="draft.evidence" rows="3" /></label>
    <label>观察与待验证解释<textarea v-model="draft.notes" rows="3" /></label>
    <div class="toolbar"><el-button :disabled="busy" @click="save">保存真实反馈</el-button><label>导入反馈 JSON<input type="file" accept=".json,application/json" :disabled="busy" @change="importFeedback" /></label><el-button :disabled="!project.releases.length" @click="exportFeedback">导出反馈 JSON</el-button></div>
    <el-button :disabled="busy" @click="resetDraft">清空未保存输入</el-button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p>对比应尽量保持平台、受众、观察时长及分发方式一致；小样本只作线索，不输出“爆款概率”。修改观测时新增记录，保留历史。</p>
    <div class="tableWrap"><table><thead><tr><th>版本 / 变体</th><th>渠道 / 受众</th><th>窗口 / 分发</th><th>开始 / 完整观看</th><th>完播比例</th><th>点击 / 转化</th><th>来源与观察</th></tr></thead><tbody><tr v-for="item in project.releases" :key="item.id"><td>{{ project.revisions.findIndex(revision => revision.id === item.revisionId) + 1 }} / {{ item.variant }}</td><td>{{ item.channel }} / {{ item.audience }}</td><td>{{ item.observationWindow }} / {{ distributionLabels[item.distribution] }}</td><td>{{ item.starts ?? '未知' }} / {{ item.completions ?? '未知' }}</td><td>{{ item.starts && item.completions !== null ? `${(100 * item.completions / item.starts).toFixed(1)}%` : '不可计算' }}</td><td>{{ item.clicks ?? '未知' }} / {{ item.conversions ?? '未知' }}</td><td>{{ item.evidence }}<br />{{ item.notes }}</td></tr></tbody></table></div>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
import axios from "axios";
import { storyReleaseSchema, type StoryAction, type StoryProject } from "@toonflow/tool-scene-list/storyProject";

const props = defineProps<{ project: StoryProject; apply: (action: StoryAction) => Promise<void> }>();
const busy = ref(false), error = ref("");
const empty = () => ({ id: crypto.randomUUID(), revisionId: props.project.approvedId ?? "", previewId: "", channel: "", url: "", publishedAt: "", audience: "", distribution: "organic" as const, variant: "", spend: null, currency: "", impressions: null, starts: null, completions: null, shares: null, follows: null, clicks: null, conversions: null, observationWindow: "", metricDefinitions: "", evidence: "", notes: "" });
const draft = ref<Omit<StoryProject["releases"][number], "previewId"> & { previewId: string }>(empty());
const initial = ref(JSON.stringify(draft.value));
const textFields = [{ key: "variant", label: "变体名称（如开场 A）" }, { key: "channel", label: "发布渠道" }, { key: "url", label: "实际发布链接" }, { key: "publishedAt", label: "发布日期" }, { key: "audience", label: "实际受众 / 样本范围" }, { key: "observationWindow", label: "观察时间范围" }, { key: "currency", label: "花费币种" }] as const;
const metrics = [{ key: "spend", label: "实际花费" }, { key: "impressions", label: "曝光数" }, { key: "starts", label: "开始观看数" }, { key: "completions", label: "完整观看数" }, { key: "shares", label: "分享数" }, { key: "follows", label: "新增关注" }, { key: "clicks", label: "点击数" }, { key: "conversions", label: "转化数" }] as const;
const distributionLabels = { organic: "自然", paid: "付费", mixed: "混合" };
function resetDraft() { draft.value = empty(); initial.value = JSON.stringify(draft.value); error.value = ""; }
async function save() {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try {
    const value = storyReleaseSchema.parse({ ...draft.value, previewId: draft.value.previewId || undefined });
    await props.apply({ type: "release", value }); draft.value = empty(); initial.value = JSON.stringify(draft.value);
  } catch (cause) { error.value = axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "保存失败"; }
  finally { busy.value = false; }
}
async function importFeedback(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = "";
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error("反馈文件最多 1 MB");
    const raw = JSON.parse(await file.text());
    // ACT: 每次导入一条可审阅观测；批量文件不自动写入，避免错误数据污染项目。
    const value = storyReleaseSchema.parse(Array.isArray(raw) && raw.length === 1 ? raw[0] : raw);
    draft.value = { ...value, id: crypto.randomUUID(), previewId: value.previewId ?? "" };
    error.value = "已载入，请核对真实版本与口径后保存。导出多条时，请选取其中一条对象导入。";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "无法导入"; }
}
function exportFeedback() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(props.project.releases, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "storyFeedback.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function flushSave() { if (busy.value || JSON.stringify(draft.value) !== initial.value) throw new Error("发布反馈尚未保存，请先核对并保存；不自动把未核对的数字写入真实反馈"); }
defineExpose({ flushSave });
</script>

<style scoped lang="scss">
.storyFeedback { p { line-height: 1.7; } .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } label { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; } input, select, textarea { color: var(--studioInk); background: var(--studioSurface); border: 1px solid var(--studioBorder); border-radius: 8px; min-height: 42px; padding: 8px; font: inherit; } .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; } .tableWrap { overflow-x: auto; table { border-collapse: collapse; width: 100%; th, td { padding: 12px; border-bottom: 1px solid var(--studioBorder); min-width: 120px; text-align: left; } } } [role="alert"] { color: var(--studioAttention); } @media(max-width: 680px) { .fields { grid-template-columns: 1fr; } } }
</style>
