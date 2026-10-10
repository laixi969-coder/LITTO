<template>
  <el-dialog
    v-model="visible"
    :title="provider ? '编辑供应商' : '添加供应商'"
    width="min(760px, 94vw)"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving"
    :showClose="!saving"
    @closed="resetForm">
    <el-scrollbar maxHeight="65vh">
      <el-form ref="providerForm" :model="form" :rules="rules" labelPosition="top" :disabled="saving" class="customProviderForm">
        <div class="formGrid">
          <el-form-item label="供应商名称" prop="label"><el-input v-model="form.label" aria-label="供应商名称" placeholder="例如 我的模型服务" /></el-form-item>
          <el-form-item label="供应商 ID（可自动生成）" prop="id"><el-input v-model="form.id" aria-label="供应商 ID" placeholder="留空自动生成，例如 myProvider" /></el-form-item>
        </div>
        <el-form-item label="Base URL" prop="apiUrl"><el-input v-model="form.apiUrl" dir="ltr" aria-label="Base URL" placeholder="https://api.example.com/v1" /></el-form-item>
        <el-form-item label="API Key" prop="apiKey">
          <el-input v-model="form.apiKey" type="password" dir="ltr" showPassword autocomplete="off" aria-label="API Key" placeholder="本地无鉴权服务可留空" />
        </el-form-item>
        <el-text v-if="!provider" type="info" size="small">默认使用 OpenAI 兼容接口，保存时自动获取模型。</el-text>
        <el-collapse v-model="optionsOpen">
          <el-collapse-item title="接口类型与模型（可选）" name="models">
            <el-form-item label="接口类型" prop="protocol">
              <el-select v-model="form.protocol" aria-label="接口类型">
                <el-option v-for="protocol in protocols" :key="protocol.value" :label="protocol.label" :value="protocol.value" />
              </el-select>
            </el-form-item>
            <div class="modelHeader">
              <el-text tag="strong">模型列表</el-text>
              <el-button :icon="IconDownload" :loading="fetching" @click="fetchModels()">同步并选择模型</el-button>
            </div>
            <div class="modelList">
              <div v-for="item in models" :key="item.key" class="modelItem">
                <div class="modelRow">
                  <el-input v-model="item.id" placeholder="模型 ID" aria-label="模型 ID" />
                  <el-input v-model="item.label" placeholder="显示名称" aria-label="模型显示名称" />
                  <el-button
                    text
                    :icon="expandedModels.has(item.key) ? IconChevronUp : IconChevronDown"
                    :aria-expanded="expandedModels.has(item.key)"
                    aria-label="展开 token 设置"
                    @click="expandedModels.has(item.key) ? expandedModels.delete(item.key) : expandedModels.add(item.key)" />
                  <el-button
                    text
                    type="danger"
                    :icon="IconTrash"
                    aria-label="删除模型"
                    @click="models = models.filter((model) => model.key !== item.key)" />
                </div>
                <div v-if="expandedModels.has(item.key)" class="formGrid tokenSettings">
                  <el-form-item label="上下文窗口">
                    <el-input-number
                      v-model="item.contextWindow"
                      :min="1"
                      :max="Number.MAX_SAFE_INTEGER"
                      :precision="0"
                      controlsPosition="right"
                      placeholder="未设置"
                      aria-label="上下文窗口" />
                  </el-form-item>
                  <el-form-item label="最大输出 token">
                    <el-input-number
                      v-model="item.maxOutputTokens"
                      :min="1"
                      :max="Number.MAX_SAFE_INTEGER"
                      :precision="0"
                      controlsPosition="right"
                      placeholder="未设置"
                      aria-label="最大输出 token" />
                  </el-form-item>
                </div>
              </div>
            </div>
            <el-button class="manualAdd" :icon="IconPlus" @click="addManualModel">手动添加模型</el-button>
          </el-collapse-item>
        </el-collapse>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" showIcon />
      </el-form>
    </el-scrollbar>
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="fetching" @click="addProvider">
        {{ provider ? "保存修改" : "保存并连接" }}
      </el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="resultsVisible" title="选择要启用的模型" width="min(680px, 92vw)" alignCenter appendToBody destroyOnClose>
    <el-input v-model="modelSearch" clearable :prefixIcon="IconSearch" placeholder="搜索模型 ID 或显示名称" aria-label="搜索模型" />
    <div class="modelResults">
      <el-auto-resizer>
        <template #default="{ height, width }">
          <el-table-v2
            :columns="resultColumns"
            :data="filteredModels"
            :width="width"
            :height="height"
            :rowHeight="38"
            :headerHeight="36"
            rowKey="id"
            fixed />
        </template>
      </el-auto-resizer>
    </div>
    <el-text type="info">{{ filteredModels.length }} 个结果，已勾选 {{ selectedIds.size }} 个</el-text>
    <template #footer>
      <el-button @click="resultsVisible = false">取消</el-button>
      <el-button type="primary" @click="addSelectedModels">应用选择（{{ selectedIds.size }}）</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { ElCheckbox, type FormInstance, type FormRules, type Column } from "element-plus";
import {
  IconPlus,
  IconDownload,
  IconTrash,
  IconChevronDown,
  IconChevronUp,
  IconSearch,
} from "@tabler/icons-vue";
import { saveSettings, type CustomProvider, type CustomProviderModel } from "@/stores/settings";
import { languageProviders } from "@toonflow/providers";

const props = defineProps<{ provider?: CustomProvider; syncOnOpen?: boolean }>();
const visible = defineModel<boolean>({ default: false });
const providerForm = ref<FormInstance>();
const form = reactive({ id: "", label: "", apiUrl: "", protocol: "openai-completions", apiKey: "" });
const models = ref<(CustomProviderModel & { key: string })[]>([]);
const expandedModels = ref(new Set<string>());
const fetchedModels = shallowRef<CustomProviderModel[]>([]);
const selectedIds = ref(new Set<string>());
const modelSearch = ref("");
const saving = ref(false);
const optionsOpen = ref<string[]>([]);
const protocols = [
  { value: "openai-completions", label: "OpenAI 兼容（默认）" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Claude" },
];
const addedIds = computed(() => new Set(models.value.map((item) => item.id.trim())));
const filteredModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase();
  return query ? fetchedModels.value.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(query)) : fetchedModels.value;
});
const resultColumns = computed<Column[]>(() => [
  {
    key: "selection",
    width: 42,
    cellRenderer: ({ rowData }) =>
      h(ElCheckbox, {
        modelValue: selectedIds.value.has(rowData.id),
        ariaLabel: `选择 ${rowData.id}`,
        onChange: (value: boolean | string | number) => {
          if (value) selectedIds.value.add(rowData.id);
          else selectedIds.value.delete(rowData.id);
        },
      }),
  },
  { key: "id", dataKey: "id", title: "模型 ID", width: 240, flexGrow: 1 },
  { key: "label", dataKey: "label", title: "显示名称", width: 200, flexGrow: 1 },
]);
const resultsVisible = ref(false);
const fetching = ref(false);
const formError = ref("");
let request: AbortController | undefined;
const rules: FormRules = {
  id: [
    { pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, message: "仅支持字母、数字、点、下划线和短横线", trigger: "blur" },
  ],
  label: [{ required: true, whitespace: true, message: "请输入显示名称", trigger: "blur" }],
  apiUrl: [
    {
      validator: (_rule, value, callback) => {
        try {
          const url = new URL(value);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
          callback();
        } catch {
          callback(new Error("请输入有效的 HTTP API 基础地址，不包含查询参数"));
        }
      },
      trigger: "blur",
    },
  ],
};

watch(visible, async (value) => {
  if (value) {
    resetForm();
    if (props.provider) {
      const { models: providerModels, ...config } = props.provider;
      Object.assign(form, config);
      models.value = providerModels.map((item) => ({ ...item, key: crypto.randomUUID() }));
    }
    if (props.syncOnOpen) {
      await nextTick();
      if (visible.value) void fetchModels();
    }
  } else {
    request?.abort();
    resultsVisible.value = false;
  }
}, { immediate: true });
onBeforeUnmount(() => request?.abort());

function resetForm() {
  optionsOpen.value = props.provider ? ["models"] : [];
  Object.assign(form, { id: "", label: "", apiUrl: "", protocol: "openai-completions", apiKey: "" });
  models.value = [];
  expandedModels.value = new Set();
  fetchedModels.value = [];
  selectedIds.value = new Set();
  modelSearch.value = "";
  formError.value = "";
}

async function fetchModels(autoApply = false) {
  if (fetching.value || !(await providerForm.value?.validateField("apiUrl").catch(() => false))) return;
  fetching.value = true;
  formError.value = "";
  const controller = new AbortController();
  request = controller;
  try {
    const { data } = await axios.post(
      "/api/providers/models",
      { apiUrl: form.apiUrl.trim(), protocol: form.protocol, apiKey: form.apiKey.trim(), providerId: props.provider?.id },
      { signal: controller.signal, timeout: 35000 }
    );
    if (controller.signal.aborted) return;
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || "获取模型列表失败");
    if (autoApply) {
      if (!data.data.length) throw new Error("未获取到可用模型，请检查 API Key 后重试");
      models.value = data.data.map((item: CustomProviderModel) => ({ ...item, key: crypto.randomUUID() }));
      return;
    }
    if (!data.data.length) throw new Error("未获取到可用模型，已保留原有列表");
    const remoteIds = new Set(data.data.map((item: CustomProviderModel) => item.id));
    fetchedModels.value = [...data.data, ...models.value.filter(item => !remoteIds.has(item.id))];
    selectedIds.value = new Set(addedIds.value);
    modelSearch.value = "";
    resultsVisible.value = true;
  } catch (error) {
    if (!controller.signal.aborted) {
      formError.value = axios.isAxiosError(error)
        ? error.response?.data?.message || "获取模型列表失败，请检查连接配置"
        : error instanceof Error
        ? error.message
        : "获取模型列表失败";
    }
  } finally {
    fetching.value = false;
  }
}

function addSelectedModels() {
  models.value = fetchedModels.value.filter(item => selectedIds.value.has(item.id)).map(item => ({
    ...models.value.find(model => model.id === item.id), ...item, key: crypto.randomUUID(),
  }));
  resultsVisible.value = false;
}

function addManualModel() {
  const key = crypto.randomUUID();
  models.value.push({ key, id: "", label: "" });
}

async function addProvider() {
  if (fetching.value) return;
  formError.value = "";
  form.id = form.id.trim() || `provider${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (saving.value || !(await providerForm.value?.validate().catch(() => false))) return;
  const providerId = props.provider?.id;
  const ids = models.value.map((item) => item.id.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    formError.value = "模型 ID 不能为空或重复";
    return;
  }
  if (
    models.value.some((item) =>
      [item.contextWindow, item.maxOutputTokens].some((value) => value != null && (!Number.isSafeInteger(value) || value < 1))
    )
  ) {
    formError.value = "token 限制必须为正整数或留空";
    return;
  }
  saving.value = true;
  try {
    if (!models.value.length && !props.provider) {
      await fetchModels(true);
      if (!models.value.length) {
        optionsOpen.value = ["models"];
        formError.value = `${formError.value || "服务商未返回模型列表"}。也可以在这里手动填写模型 ID 后保存。`;
        return;
      }
    }
    const updatedProvider = {
      ...props.provider,
      ...form,
      label: form.label.trim(),
      apiUrl: form.apiUrl.trim(),
      apiKey: form.apiKey.trim(),
      models: models.value.map(({ key, ...item }) => ({
        ...item,
        id: item.id.trim(),
        label: item.label.trim() || item.id.trim(),
        contextWindow: item.contextWindow ?? undefined,
        maxOutputTokens: item.maxOutputTokens ?? undefined,
      })),
    };
    await saveSettings(settings => {
      const existing = settings.customProviders;
      if (existing !== undefined && !Array.isArray(existing)) throw new Error("已保存的供应商配置格式不正确");
      if (languageProviders.some(item => item.id !== providerId && item.id.toLowerCase() === updatedProvider.id.toLowerCase())
        || existing?.some(item => typeof item?.id === "string" && item.id !== providerId && item.id.toLowerCase() === updatedProvider.id.toLowerCase())) {
        throw new Error("Provider ID 已存在");
      }
      if (providerId && !existing?.some(item => item.id === providerId)) throw new Error("供应商已不存在");
      return { customProviders: providerId
        ? existing!.map(item => item.id === providerId ? updatedProvider : item)
        : [...(existing ?? []), updatedProvider] };
    });
    visible.value = false;
  } catch (error) {
    formError.value = error instanceof Error ? error.message : "保存失败，请重试；当前填写的内容已保留";
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.customProviderForm {
  padding-right: 12px;

  .formGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 20px;

    .el-input-number {
      width: 100%;
    }
  }

  .modelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 8px 0 16px;
  }

  .modelList {
    .modelItem {
      padding: 8px 0;
      border-bottom: 1px solid var(--el-border-color-lighter);

      .modelRow {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px 28px;
        align-items: center;
        gap: 8px;

        .el-button {
          margin: 0;
          padding: 4px;
        }
      }

      .tokenSettings {
        padding-top: 12px;

        .el-form-item {
          margin-bottom: 4px;
        }
      }
    }
  }

  .manualAdd {
    width: 100%;
    margin: 16px 0;
  }

  @media (max-width: 560px) {
    .formGrid {
      grid-template-columns: 1fr;
    }
  }
}
.modelResults {
  height: min(420px, 55dvh);
  margin: 12px 0;
}
</style>
