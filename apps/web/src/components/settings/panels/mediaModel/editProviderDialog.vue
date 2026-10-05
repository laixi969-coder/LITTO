<template>
  <el-dialog
    v-model="visible"
    :title="`编辑媒体供应商：${provider?.label ?? ''}`"
    width="min(800px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving && !fetching"
    :showClose="!saving">
    <div class="providerEditor">
      <messageMarkdown v-if="provider?.readme" class="providerReadme" :content="provider.readme" />
      <form-create-form v-model="configValues" :rule="configRules" :option="formOptions" />
      <div class="modelHeader">
        <h4>模型配置 <el-text type="info">{{ models.length }}</el-text></h4>
        <el-space>
          <el-button v-if="provider?.canSyncModels || provider?.modelsUrl" :icon="IconDownload" size="small" :loading="fetching" :disabled="saving" @click="fetchModels">同步并选择模型</el-button>
          <el-button :icon="IconPlus" size="small" :disabled="saving || fetching" @click="editModel()">手动添加</el-button>
        </el-space>
      </div>
      <el-text v-if="!provider?.canSyncModels && !provider?.modelsUrl" type="info">此供应商未提供目录接口，可手动指定模型 ID。</el-text>
      <div class="modelList">
        <el-card v-for="(item, index) in models" :key="index" class="modelCard" shadow="never">
          <div class="topInfo">
            <div class="modelNameWrap">
              <modelIcon :model="item.id" :size="24" />
              <div class="modelInfo">
                <span class="modelName">{{ item.label }}</span>
                <el-text class="modelId" type="info" size="small">{{ item.id }}</el-text>
              </div>
            </div>
            <div class="actionButtons">
              <el-button text size="small" :icon="IconEdit" :disabled="saving" :aria-label="`编辑模型 ${item.label}`" @click="editModel(index)">编辑</el-button>
              <el-button text size="small" type="danger" :icon="IconTrash" :disabled="saving" :aria-label="`删除模型 ${item.label}`" @click="models.splice(index, 1)">删除</el-button>
            </div>
          </div>
          <div class="modelTags">
            <el-tag size="small">{{ modelTypes[item.type] }}</el-tag>
            <el-tag v-for="(tag, tagIndex) in modelTags(item)" :key="tagIndex" size="small" type="info">{{ tag }}</el-tag>
          </div>
        </el-card>
        <el-text v-if="!models.length" type="info">暂无模型</el-text>
      </div>
    </div>
    <el-alert v-if="formError" class="formError" :title="formError" type="error" :closable="false" showIcon />
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :icon="IconDeviceFloppy" :loading="saving" :disabled="fetching" @click="saveModels">保存</el-button>
    </template>
    <component
      :is="modelEditorDialog"
      v-model="modelEditorVisible"
      :model="editingModelIndex === undefined ? undefined : models[editingModelIndex]"
      :models="models"
      @confirmed="confirmModel" />
  </el-dialog>
  <el-dialog v-model="resultsVisible" title="选择要启用的媒体模型" width="min(760px, 94vw)" alignCenter appendToBody destroyOnClose :closeOnClickModal="false" :showClose="!fetching">
    <el-space class="catalogueFilters">
      <el-input v-model="modelSearch" clearable :prefixIcon="IconSearch" placeholder="搜索模型 ID 或显示名称" aria-label="搜索媒体模型" />
      <el-select v-model="modelType" placeholder="全部类型" aria-label="筛选模型类型" style="width: 120px">
        <el-option label="全部类型" value="" />
        <el-option label="图片" value="image" />
        <el-option label="视频" value="video" />
        <el-option label="音频" value="audio" />
      </el-select>
    </el-space>
    <div class="modelResults">
      <el-auto-resizer>
        <template #default="{ height, width }">
          <el-table-v2 :columns="resultColumns" :data="filteredModels" :width="width" :height="height" :rowHeight="42" :headerHeight="36" rowKey="id" fixed />
        </template>
      </el-auto-resizer>
    </div>
    <el-text type="info">仅列出已适配的远程模型与已有配置。{{ filteredModels.length }} 个结果，已勾选 {{ selectedIds.size }} 个；应用后点击保存生效。</el-text>
    <el-alert v-if="catalogueError" :title="catalogueError" type="error" :closable="false" showIcon />
    <template #footer>
      <el-button :disabled="fetching" @click="resultsVisible = false">取消</el-button>
      <el-button type="primary" :loading="fetching" @click="applySelection">应用选择（{{ selectedIds.size }}）</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";

import axios from "axios";
import { ElCheckbox, type Column } from "element-plus";
import { computed, defineAsyncComponent, h, onBeforeUnmount, ref, shallowRef, watch, type Component } from "vue";
import { IconPlus, IconTrash, IconDeviceFloppy, IconEdit, IconDownload, IconSearch } from "@tabler/icons-vue";
import { mediaProviders } from "@toonflow/providers";
import formCreate, { formCreateForm, type Options } from "../../formCreate";
import { modelIcon } from "@toonflow/model-icons";
import messageMarkdown from "@/components/messageMarkdown.vue";
import type { MediaProvider, MediaProviderModel } from "./types";
import { settings, saveSettings } from "@/stores/settings";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";

const { provider, syncOnOpen = false } = defineProps<{ provider?: MediaProvider; syncOnOpen?: boolean }>();
const modelEditorDialog = shallowRef<Component>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ saved: [provider: MediaProvider] }>();
const models = ref<MediaProviderModel[]>([]);
const modelEditorVisible = ref(false);
const editingModelIndex = ref<number>();
const saving = ref(false);
const configValues = ref<Record<string, unknown>>({});
const configRules = computed(() => formCreate.copyRules([...(mediaProviders.find(item => item.id === provider?.id)?.rules ?? [
  { type: "input", field: "apiKey", title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
])]));
const formOptions = computed<Options>(() => ({ form: { labelPosition: "top", disabled: saving.value || fetching.value }, submitBtn: false, resetBtn: false }));
const formError = ref("");
const modelTypes = { get image() { return translate("图片"); }, get video() { return translate("视频"); }, get audio() { return translate("音频"); }, get text() { return translate("文本"); } };
const modeLabels: Record<string, string> = {
  singleImage: "单图参考", multiReference: "多图参考", startEndRequired: "首尾帧必填",
  endFrameOptional: "尾帧可选", startFrameOptional: "首帧可选",
  imageReference: "图片参考", videoReference: "视频参考", audioReference: "音频参考",
};

const fetching = ref(false);
const resultsVisible = ref(false);
const fetchedModels = ref<MediaProviderModel[]>([]);
const remoteIds = ref(new Set<string>());
const selectedIds = ref(new Set<string>());
const modelSearch = ref("");
const modelType = ref("");
const catalogueError = ref("");
let catalogueRequest: AbortController | undefined;
const filteredModels = computed(() => fetchedModels.value.filter(item => (!modelType.value || item.type === modelType.value)
  && `${item.id} ${item.label}`.toLowerCase().includes(modelSearch.value.trim().toLowerCase())));
const resultColumns = computed<Column[]>(() => [
  { key: "selection", width: 42, cellRenderer: ({ rowData }) => h(ElCheckbox, {
    modelValue: selectedIds.value.has(rowData.id), disabled: fetching.value, ariaLabel: `选择 ${rowData.id}`,
    onChange: (value: boolean | string | number) => { if (value) selectedIds.value.add(rowData.id); else selectedIds.value.delete(rowData.id); },
  }) },
  { key: "id", dataKey: "id", title: "模型 ID", width: 260, flexGrow: 1 },
  { key: "label", dataKey: "label", title: "显示名称", width: 220, flexGrow: 1 },
  { key: "type", title: "类型", width: 65, cellRenderer: ({ rowData }) => h("span", modelTypes[rowData.type as keyof typeof modelTypes]) },
]);
onBeforeUnmount(() => catalogueRequest?.abort());

async function requestCatalogue(modelIds?: string[]) {
  const controller = new AbortController();
  catalogueRequest = controller;
  const { data } = await axios.post<{ code: number; data: MediaProvider; message: string }>("/api/providers/media/models", {
    fileName: provider!.fileName, revision: provider!.revision, apply: false, config: configValues.value, modelIds,
  }, { signal: controller.signal, timeout: 65000 });
  if (controller.signal.aborted) throw new Error("请求已取消");
  if (data.code !== 200 || !data.data?.models?.length) throw new Error(data.message || "没有获取到已适配的模型，保留原有配置");
  return data.data.models;
}

async function fetchModels() {
  if (fetching.value || !provider) return;
  fetching.value = true;
  formError.value = "";
  try {
    const remote = await requestCatalogue();
    remoteIds.value = new Set(remote.map(item => item.id));
    fetchedModels.value = [...remote, ...models.value.filter(item => !remoteIds.value.has(item.id))];
    selectedIds.value = new Set(models.value.map(item => item.id));
    modelSearch.value = "";
    modelType.value = "";
    catalogueError.value = "";
    resultsVisible.value = true;
  } catch (error) {
    if (!catalogueRequest?.signal.aborted) formError.value = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "同步模型失败";
  } finally { fetching.value = false; }
}

async function applySelection() {
  if (fetching.value) return;
  const ids = [...selectedIds.value].filter(id => remoteIds.value.has(id));
  if (ids.length > 100) { catalogueError.value = "每次最多选择 100 个远程模型"; return; }
  fetching.value = true;
  catalogueError.value = "";
  try {
    const resolved = ids.length ? await requestCatalogue(ids) : [];
    if (ids.some(id => !resolved.some(item => item.id === id))) throw new Error("部分模型已从远程目录移除，请重新同步后选择");
    const selections = fetchedModels.value.filter(item => selectedIds.value.has(item.id));
    models.value = selections.map(item => ({ ...models.value.find(model => model.id === item.id), ...(resolved.find(model => model.id === item.id) ?? item) }));
    resultsVisible.value = false;
  } catch (error) {
    if (!catalogueRequest?.signal.aborted) catalogueError.value = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "获取模型参数失败";
  } finally { fetching.value = false; }
}

watch(visible, isVisible => {
  if (!isVisible) {
    catalogueRequest?.abort();
    resultsVisible.value = false;
    return;
  }
  formError.value = "";
  modelEditorVisible.value = false;
  editingModelIndex.value = undefined;
  const configs = settings.value.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  configValues.value = { ...Object.fromEntries(configRules.value.map(rule => [rule.field, rule.value])), ...(provider && configs?.[provider.id] || {}) };
  models.value = JSON.parse(JSON.stringify(provider?.models ?? []));
  catalogueError.value = "";
  if (syncOnOpen) void fetchModels();
}, { immediate: true });

function modelTags(model: MediaProviderModel) {
  const modes = Array.isArray(model.mode) ? model.mode.flat().filter((mode): mode is string => typeof mode === "string") : [];
  return modes.map(mode => {
    if (mode === "text") return model.type === "image" ? translate("文生图") : translate("文生视频");
    const reference = /^(imageReference|videoReference|audioReference):(\d+)$/.exec(mode);
    return reference ? `${modeLabels[reference[1]!]} ×${reference[2]}` : modeLabels[mode] ?? mode;
  });
}

function editModel(index?: number) {
  modelEditorDialog.value ??= defineAsyncComponent(() => import("./modelEditorDialog.vue"));
  editingModelIndex.value = index;
  modelEditorVisible.value = true;
}

function confirmModel(model: MediaProviderModel) {
  const index = editingModelIndex.value;
  if (index === undefined) models.value.push(model);
  else models.value.splice(index, 1, model);
}

async function saveModels() {
  if (saving.value || fetching.value || !provider) return;
  const { id: providerId, fileName, revision } = provider;
  formError.value = "";
  let configSaved = false;
  try {
    const ids = new Set<string>();
    const values = models.value.map((item, index) => {
      const id = item.id.trim();
      const label = item.label.trim();
      if (!id || !label) throw new Error(`请填写第 ${index + 1} 个模型的 ID 和显示名称`);
      if (ids.has(id)) throw new Error(`模型 ID 重复：${id}`);
      ids.add(id);
      return { ...item, id, label };
    });
    const nextConfig = { ...configValues.value };
    for (const field of ["apiKey", "secret", "baseUrl"]) {
      if (typeof nextConfig[field] !== "string") continue;
      nextConfig[field] = (nextConfig[field] as string).trim();
      if ((nextConfig[field] as string).length > (field === "baseUrl" ? 2048 : 8192)) throw new Error(`${field === "baseUrl" ? "API 地址" : "密钥"}过长`);
    }
    saving.value = true;
    configSaved = await saveSettings(settings => {
      const configs = settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
      if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
      const current = configs?.[providerId];
      if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new Error("当前供应商配置格式无效");
      if (Object.entries(nextConfig).every(([key, value]) => value === current?.[key])) return;
      return { mediaProviderConfigs: { ...configs, [providerId]: { ...current, ...nextConfig } } };
    });
    if (configSaved) {
      const maskedConfig = { ...nextConfig };
      for (const field of ["apiKey", "secret"]) {
        const value = maskedConfig[field];
        if (typeof value === "string" && value) maskedConfig[field] = `••••${value.slice(-4)}`;
      }
      await saveSettings(settings => ({ mediaProviderConfigs: { ...(settings.mediaProviderConfigs as Record<string, unknown>), [providerId]: maskedConfig } }));
      configValues.value = maskedConfig;
    }
    const { data } = await axios.put<{ data: MediaProvider }>("/api/providers/media/save", {
      fileName, revision, models: values,
    });
    invalidateNodeModels("media");
    emit("saved", data.data);
    visible.value = false;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "保存失败，请重试";
    formError.value = configSaved ? `连接配置已保存，模型未保存：${message}。模型修改已保留，请重试。` : message;
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.catalogueFilters { margin-bottom: 12px; }
.modelResults { height: 420px; margin-bottom: 12px; }
.providerEditor {
  max-height: 65dvh;
  padding: 8px 4px;
  overflow-y: auto;
  overscroll-behavior: contain;

  .providerReadme { margin-bottom: 20px; }

  .modelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;

    h4 { margin: 0; }
  }

  .modelList {
    display: flex;
    flex-direction: column;
    gap: 10px;

    .modelCard {
      .topInfo {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;

        .modelNameWrap {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;

          .modelInfo {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
            overflow-wrap: anywhere;

            .modelName { font-size: 15px; font-weight: 600; }
            .modelId { align-self: flex-start; }
          }
        }

        .actionButtons {
          display: flex;
          flex-shrink: 0;
          margin-left: auto;
        }
      }

      .modelTags {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 16px;
      }
    }
  }
}

.formError { margin-top: 16px; }
</style>
