<template>
  <div class="modelPicker">
    <div class="pickerFilters">
      <el-input v-model="search" clearable :prefixIcon="IconSearch" placeholder="搜索模型 ID 或显示名称" aria-label="搜索模型" :disabled="disabled" />
      <el-select v-model="sortOrder" aria-label="模型排序" :disabled="disabled">
        <el-option label="平台原顺序" value="source" />
        <el-option label="最新优先（平台时间）" value="newest" :disabled="!hasModelTime" />
        <el-option label="型号正序（A–Z / 1–9）" value="idAscending" />
        <el-option label="型号倒序（Z–A / 9–1）" value="idDescending" />
        <el-option label="名称正序" value="name" />
      </el-select>
    </div>
    <div class="pickerActions">
      <el-checkbox :modelValue="allSelected" :indeterminate="selectedResultCount > 0 && !allSelected" :disabled="disabled || !filteredModels.length" @change="selectResults">全选当前结果（{{ filteredModels.length }}）</el-checkbox>
      <el-checkbox v-model="onlySelected" :disabled="disabled">仅看已选</el-checkbox>
      <el-button text :disabled="disabled || !selectedIds.size" @click="selectedIds = new Set()">清空全部选择</el-button>
    </div>
    <div class="modelResults">
      <el-auto-resizer>
        <template #default="{ height, width }">
          <el-table-v2 ref="table" :columns="resultColumns" :data="filteredModels" :width="width" :height="height" :rowHeight="42" :headerHeight="36" rowKey="id" fixed />
        </template>
      </el-auto-resizer>
    </div>
    <p class="selectionSummary" role="status" aria-live="polite">{{ filteredModels.length }} 个结果，当前结果已选 {{ selectedResultCount }} 个，共已选 {{ selectedIds.size }} 个</p>
    <p class="dateHint">{{ hasModelTime ? '最新优先按平台返回的模型时间排序，无时间的模型保留原顺序并排在后面。' : '平台未提供模型时间，可按型号倒序查找较高版本；型号顺序不代表发布时间。' }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from "vue";
import { ElCheckbox, type Column, type TableV2Instance } from "element-plus";
import { IconSearch } from "@tabler/icons-vue";

type PickerModel = { id: string; label: string; createdAt?: unknown; created?: unknown; created_at?: unknown; releaseDate?: unknown; release_date?: unknown };
const { models, columns = [], disabled = false } = defineProps<{ models: PickerModel[]; columns?: Column[]; disabled?: boolean }>();
const selectedIds = defineModel<Set<string>>({ required: true });
const search = ref("");
const sortOrder = ref("source");
const onlySelected = ref(false);
const table = ref<TableV2Instance>();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const modelTimes = computed(() => new Map(models.map(model => [model.id, modelTime(model)])));
const hasModelTime = computed(() => [...modelTimes.value.values()].some(time => time > 0));
const filteredModels = computed(() => {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = models.filter(model => (!onlySelected.value || selectedIds.value.has(model.id))
    && terms.every(term => `${model.id} ${model.label}`.toLowerCase().includes(term)));
  if (sortOrder.value === "newest") results.sort((first, second) => (modelTimes.value.get(second.id) ?? 0) - (modelTimes.value.get(first.id) ?? 0));
  else if (sortOrder.value === "name") results.sort((first, second) => collator.compare(first.label, second.label));
  else if (sortOrder.value !== "source") results.sort((first, second) => collator.compare(first.id, second.id) * (sortOrder.value === "idDescending" ? -1 : 1));
  return results;
});
const selectedResultCount = computed(() => filteredModels.value.filter(model => selectedIds.value.has(model.id)).length);
const allSelected = computed(() => filteredModels.value.length > 0 && selectedResultCount.value === filteredModels.value.length);
const resultColumns = computed<Column[]>(() => [
  { key: "selection", width: 42, cellRenderer: ({ rowData }) => h(ElCheckbox, {
    modelValue: selectedIds.value.has(rowData.id), disabled, ariaLabel: `选择 ${rowData.id}`,
    onChange: (value: boolean | string | number) => {
      const next = new Set(selectedIds.value);
      if (value) next.add(rowData.id);
      else next.delete(rowData.id);
      selectedIds.value = next;
    },
  }) },
  { key: "id", dataKey: "id", title: "模型 ID", width: 230, flexGrow: 1 },
  { key: "label", dataKey: "label", title: "显示名称", width: 180, flexGrow: 1 },
  ...columns,
  ...(hasModelTime.value ? [{ key: "modelTime", title: "平台时间", width: 110, cellRenderer: ({ rowData }: { rowData: PickerModel }) => {
    const time = modelTimes.value.get(rowData.id);
    return h("span", time ? new Date(time).toISOString().slice(0, 10) : "—");
  } }] : []),
]);
watch([search, sortOrder, onlySelected, () => models], () => table.value?.scrollToTop(0), { flush: "post" });

function modelTime(model: PickerModel) {
  for (const value of [model.releaseDate, model.release_date, model.createdAt, model.created_at, model.created]) {
    let time = 0;
    if (typeof value === "number" || typeof value === "string" && /^\d{10,13}$/.test(value)) {
      const number = Number(value);
      time = number < 1e12 ? number * 1000 : number;
    } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T| |$)/.test(value)) time = Date.parse(value);
    if (Number.isFinite(time) && time > 0 && time <= 8640000000000000) return time;
  }
  return 0;
}

function selectResults(value: boolean | string | number) {
  const next = new Set(selectedIds.value);
  for (const model of filteredModels.value) {
    if (value) next.add(model.id);
    else next.delete(model.id);
  }
  selectedIds.value = next;
}
</script>

<style scoped lang="scss">
.modelPicker {
  min-width: 0;
  .pickerFilters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    .el-input { flex: 1; min-width: min(220px, 100%); }
    .el-select { width: 224px; max-width: 100%; }
  }
  .pickerActions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; margin-top: 8px; .el-checkbox { margin: 0; } .el-button { margin: 0; } }
  .modelResults { height: min(360px, 42dvh); margin: 8px 0; }
  .selectionSummary { margin: 8px 0 0; color: var(--el-text-color-regular); font-size: 13px; font-variant-numeric: tabular-nums; }
  .dateHint { margin: 4px 0 0; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.6; }
}
</style>
