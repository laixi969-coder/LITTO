<template>
  <el-dialog
    v-model="visible"
    :title="mode === 'custom' ? '导入供应商适配器' : '添加媒体供应商'"
    :width="mode === 'builtin' ? 'min(860px, 94vw)' : 'min(760px, 94vw)'"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving"
    :showClose="!saving">
    <el-form v-if="mode === 'connection'" ref="connectionForm" class="connectionForm" :model="connection" :rules="connectionRules" labelPosition="top" :disabled="saving" @submit.prevent="addProvider">
      <el-form-item label="供应商名称" prop="label">
        <el-input v-model="connection.label" :disabled="!!addedProvider" maxlength="100" placeholder="例如 我的模型服务" aria-label="供应商名称" />
      </el-form-item>
      <el-form-item label="供应商 ID（可自动生成）" prop="id">
        <el-input v-model="connection.id" :disabled="!!addedProvider" maxlength="96" placeholder="留空自动生成，例如 myProvider" aria-label="供应商 ID" />
      </el-form-item>
      <el-form-item label="Base URL" prop="baseUrl">
        <el-input v-model="connection.baseUrl" dir="ltr" placeholder="服务商提供的 API 基础地址" aria-label="Base URL" />
      </el-form-item>
      <el-form-item label="API Key" prop="apiKey">
        <el-input v-model="connection.apiKey" type="password" showPassword autocomplete="off" aria-label="API Key" />
      </el-form-item>
      <el-form-item label="接口类型" prop="templateId">
        <el-select v-model="connection.templateId" :disabled="!!addedProvider" placeholder="选择服务商兼容的接口" aria-label="接口类型">
          <el-option v-for="item in connectionTemplates" :key="item.id" :value="item.id" :label="`${item.label} 兼容`" />
        </el-select>
      </el-form-item>
      <el-text type="info" size="small">图片、视频接口各不相同，按服务商文档选择接口类型。模型会沿用该接口的已适配列表，无需填写代码。</el-text>
      <el-alert v-if="formError" :title="formError" type="error" :closable="false" showIcon />
    </el-form>
    <div v-else-if="mode === 'builtin'" class="providerPicker">
      <aside class="providerSidebar" aria-label="选择厂商">
        <button
          v-for="item in mediaProviders"
          :key="item.id"
          class="providerItem"
          type="button"
          :disabled="saving"
          :aria-pressed="selectedProvider === item.id"
          @click="selectedProvider = item.id">
          <modelIcon :model="item.id" :size="18" />
          <span>{{ item.label }}</span>
        </button>
      </aside>
      <el-scrollbar class="providerDetails">
        <section v-if="activeProvider" :key="selectedProvider" class="providerContent" :aria-label="activeProvider.label">
          <div class="providerHeader">
            <h3>{{ activeProvider.label }}</h3>
            <el-tag v-if="activeProvider.version" size="small" type="info" effect="plain">v{{ activeProvider.version }}</el-tag>
          </div>
          <messageMarkdown v-if="providerReadme" class="providerReadme" :content="providerReadme" />
          <el-divider v-if="providerReadme" contentPosition="left">连接配置</el-divider>
          <form-create-form v-model:api="formApi" :rule="providerRules" :option="formOptions" />
          <div class="modelHeader">
            <el-text tag="strong">模型列表 <el-text type="info">{{ models.length }}</el-text></el-text>
          </div>
          <el-table v-if="models.length" class="modelList" :data="models" rowKey="id" aria-label="模型列表">
            <el-table-column prop="id" label="模型 ID" minWidth="220" showOverflowTooltip />
            <el-table-column prop="label" label="显示名称" minWidth="180" showOverflowTooltip />
          </el-table>
          <el-alert v-if="formError" :title="formError" type="error" :closable="false" showIcon />
        </section>
      </el-scrollbar>
    </div>
    <el-scrollbar v-else maxHeight="65vh">
      <div class="dialogContent">
        <el-form labelPosition="top" :disabled="saving" @submit.prevent>
          <el-form-item label="添加方式">
            <el-segmented v-model="activeTab" :options="addMethods" block ariaLabel="添加方式">
              <template #default="{ item }">
                <span class="methodOption">
                  <component :is="item.icon" :size="16" aria-hidden="true" />
                  {{ item.label }}
                </span>
              </template>
            </el-segmented>
          </el-form-item>
          <el-form-item v-if="activeTab === 'file'" label="供应商文件">
            <div class="fileSource">
              <input ref="fileInput" type="file" accept=".ts" hidden :disabled="saving" @change="readSourceFile" />
              <el-input :modelValue="fileName" :prefixIcon="IconFileCode" placeholder="尚未选择文件" readonly aria-label="已选择的供应商文件" />
              <el-button :icon="IconFolderOpen" @click="fileInput?.click()">选择文件</el-button>
            </div>
            <el-text class="fieldHint" type="info" size="small">支持 .ts 文件，最大 1 MB。</el-text>
          </el-form-item>
          <el-form-item v-else label="供应商代码">
            <el-input v-model="code" class="sourceInput" type="textarea" dir="ltr" :rows="10" resize="none" aria-label="供应商代码" />
          </el-form-item>
        </el-form>
        <el-alert class="providerTips" title="没有供应商文件？可以让 AI 帮你生成" type="info" :closable="false" showIcon>
          <p>复制提示词发给其他 AI，按引导提供接口资料即可生成配置文件，随后在这里导入 .ts 文件或粘贴完整代码即可使用。</p>
          <el-button size="small" :icon="IconCopy" @click="copyPrompt">一键复制提示词</el-button>
          <details class="promptDetails" :open="promptExpanded" @toggle="promptExpanded = ($event.target as HTMLDetailsElement).open">
            <summary>查看完整提示词</summary>
            <el-input v-if="promptExpanded" :modelValue="providerPrompt" type="textarea" :rows="10" resize="none" readonly aria-label="供应商开发提示词" />
          </details>
        </el-alert>
        <el-alert v-if="formError" class="formError" :title="formError" type="error" :closable="false" showIcon />
      </div>
    </el-scrollbar>
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="mode !== 'connection' && !source.trim()" @click="addProvider">{{ mode === "connection" ? "保存并连接" : "确定添加供应商" }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, reactive, ref, shallowRef, watch } from "vue";
import formCreate, { formCreateForm, type Api, type Options } from "../../formCreate";
import { IconFileCode, IconCode, IconFolderOpen, IconCopy } from "@tabler/icons-vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { mediaProviders } from "@toonflow/providers";
import { modelIcon } from "@toonflow/model-icons";
import messageMarkdown from "@/components/messageMarkdown.vue";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import apiMartSource from "@toonflow/providers/media/apiMart?raw";
import metaSource from "@toonflow/providers/media/meta?raw";
import agnesSource from "@toonflow/providers/media/agnes?raw";
import volcengineSource from "@toonflow/providers/media/volcengine?raw";
import bailianSource from "@toonflow/providers/media/bailian?raw";
import klingSource from "@toonflow/providers/media/kling?raw";
import viduSource from "@toonflow/providers/media/vidu?raw";
import atlasCloudSource from "@toonflow/providers/media/atlasCloud?raw";
import easyRouterSource from "@toonflow/providers/media/easyRouter?raw";
import qwenSpeechSource from "@toonflow/providers/media/qwenSpeech?raw";
import museTalkSource from "@toonflow/providers/media/museTalk?raw";
import type { MediaProvider } from "./types";
import { providerPrompt } from "./providerPrompt";
import { saveSettings } from "@/stores/settings";
import { writeClipboardText } from "@/lib/clipboard";

const { mode = "connection" } = defineProps<{ mode?: "connection" | "builtin" | "custom" }>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ added: [provider: MediaProvider] }>();
const providerSources: Record<string, string> = { apiMart: apiMartSource, meta: metaSource, agnes: agnesSource, volcengine: volcengineSource, bailian: bailianSource, kling: klingSource, vidu: viduSource, atlasCloud: atlasCloudSource, easyRouter: easyRouterSource, qwenSpeech: qwenSpeechSource, museTalk: museTalkSource };
const selectedProvider = ref<string>(mediaProviders[0]?.id ?? "");
const activeProvider = computed(() => mediaProviders.find(provider => provider.id === selectedProvider.value));
const models = computed<MediaProvider["models"]>(() => activeProvider.value?.models ?? []);
const providerReadme = computed(() => {
  const provider = activeProvider.value;
  return provider && "readme" in provider && typeof provider.readme === "string" ? provider.readme : "";
});
const activeTab = ref<"file" | "code">("file");
const addMethods = [
  { label: "文件导入", value: "file", icon: IconFileCode },
  { label: "粘贴代码", value: "code", icon: IconCode },
];
const promptExpanded = ref(false);
const code = ref("");
const fileSource = ref("");
const fileName = ref("");
const fileInput = ref<HTMLInputElement>();
const saving = ref(false);
const formError = ref("");
const formApi = shallowRef<Api>();
const addedProvider = shallowRef<MediaProvider>();
const connectionForm = ref<FormInstance>();
const connection = reactive({ id: "", label: "", baseUrl: "", apiKey: "", templateId: "" });
const connectionTemplates = mediaProviders.filter(provider => ["apiKey", "baseUrl"].every(field => provider.rules.some(rule => rule.field === field)));
const connectionRules: FormRules = {
  label: [{ required: true, whitespace: true, message: "请输入供应商名称", trigger: "blur" }],
  id: [{ pattern: /^[a-z][a-zA-Z0-9]*$/, message: "请以小写字母开头，仅使用字母和数字", trigger: "blur" }],
  apiKey: [{ required: true, whitespace: true, message: "请输入 API Key", trigger: "blur" }, { max: 8192, message: "API Key 过长", trigger: "blur" }],
  templateId: [{ required: true, message: "请选择服务商兼容的接口类型", trigger: "change" }],
  baseUrl: [{ validator: (_rule, value, callback) => {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) throw new Error();
      callback();
    } catch { callback(new Error("请输入不含账号、查询参数的 HTTP API 基础地址")); }
  }, trigger: "blur" }],
};
const formOptions = computed<Options>(() => ({ form: { labelPosition: "top", disabled: saving.value }, submitBtn: false, resetBtn: false }));
const providerRules = computed(() => formCreate.copyRules([...(activeProvider.value?.rules ?? [])]));
const source = computed(() => mode === "builtin" ? providerSources[selectedProvider.value] ?? "" : activeTab.value === "file" ? fileSource.value : code.value);

watch([activeTab, selectedProvider], () => {
  formError.value = "";
  addedProvider.value = undefined;
});

watch(visible, value => {
  if (!value) return;
  Object.assign(connection, { id: "", label: "", baseUrl: "", apiKey: "", templateId: "" });
  selectedProvider.value = mediaProviders[0]?.id ?? "";
  activeTab.value = "file";
  promptExpanded.value = false;
  formApi.value = undefined;
  addedProvider.value = undefined;
  code.value = fileSource.value = fileName.value = formError.value = "";
});

async function readSourceFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  formError.value = "";
  try {
    if (!/\.ts$/i.test(file.name) || file.size > 1024 * 1024) throw new Error("请选择不超过 1 MB 的 .ts 文件");
    fileSource.value = await file.text();
    fileName.value = file.name;
  } catch (error) {
    fileSource.value = fileName.value = "";
    formError.value = error instanceof Error ? error.message : "读取文件失败";
  }
}

async function addProvider() {
  if (mode === "connection") return addConnection();
  if (saving.value || !source.value.trim()) return;
  if (mode === "builtin" && !formApi.value) return;
  saving.value = true;
  formError.value = "";
  try {
    let values: Record<string, unknown> | undefined;
    if (mode === "builtin") {
      if (!(await formApi.value!.validate().then(() => true, () => false))) return;
      values = formApi.value!.formData();
      if ("apiKey" in values) {
        values.apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
        if (!values.apiKey) throw new Error("请填写 API Key");
        if ((values.apiKey as string).length > 8192) throw new Error("API Key 过长");
      }
    }
    if (!addedProvider.value) {
      const { data } = await axios.post<{ data: MediaProvider }>("/api/providers/media/add", { source: source.value });
      addedProvider.value = data.data;
      emit("added", data.data);
      invalidateNodeModels("media");
    }
    if (values) {
      const providerId = addedProvider.value.id;
      // ACT: 安装成功但配置保存失败时保留安装结果，重试只保存配置。
      await saveSettings(settings => {
        const configs = settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
        if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
        const current = configs?.[providerId];
        if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new Error("当前供应商配置格式无效");
        return { mediaProviderConfigs: { ...configs, [providerId]: { ...current, ...values } } };
      });
    }
    invalidateNodeModels("media");
    visible.value = false;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "添加失败，请重试";
    formError.value = addedProvider.value ? `供应商已添加，连接配置未保存：${message}。填写内容已保留，请重试。` : message;
  } finally {
    saving.value = false;
  }
}

async function addConnection() {
  if (saving.value) return;
  formError.value = "";
  connection.id = connection.id.trim() || `provider${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!(await connectionForm.value?.validate().catch(() => false))) return;
  saving.value = true;
  try {
    if (!addedProvider.value) {
      const { data } = await axios.post<{ data: MediaProvider }>("/api/providers/media/add", { connection: { id: connection.id, label: connection.label.trim(), templateId: connection.templateId } });
      addedProvider.value = data.data;
      emit("added", data.data);
    }
    const provider = addedProvider.value;
    // ACT: 安装已成功时重试只保存连接，不重复创建、不覆盖其他供应商。
    await saveSettings(current => {
      const configs = current.mediaProviderConfigs;
      if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
      const values = configs as Record<string, Record<string, unknown>> | undefined;
      return { mediaProviderConfigs: { ...values, [provider.id]: { ...values?.[provider.id], baseUrl: connection.baseUrl.trim().replace(/\/+$/, ""), apiKey: connection.apiKey.trim() } } };
    });
    connection.apiKey = "";
    if (provider.canSyncModels) {
      try {
        const { data: catalogue } = await axios.post<{ data: MediaProvider }>("/api/providers/media/models", { fileName: provider.fileName, revision: provider.revision, apply: false }, { timeout: 65000 });
        const { data: saved } = await axios.put<{ data: MediaProvider }>("/api/providers/media/save", { fileName: provider.fileName, revision: provider.revision, models: catalogue.data.models });
        emit("added", saved.data);
      } catch (error) {
        const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "获取失败";
        ElMessage.warning(`连接已保存，模型列表未同步：${message}。已保留接口自带的模型，可在供应商列表重试同步。`);
      }
    }
    invalidateNodeModels("media");
    window.dispatchEvent(new CustomEvent("toonflow:plugin-installed", { detail: { type: "provider", name: provider.id } }));
    ElMessage.success(`${provider.label} 已保存，密钥与模型权限将在实际调用时验证`);
    visible.value = false;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "保存失败";
    formError.value = addedProvider.value ? `供应商已创建，连接配置未保存：${message}。可直接重试。` : message;
  } finally { saving.value = false; }
}

async function copyPrompt() {
  try {
    await writeClipboardText(providerPrompt);
    ElMessage.success("提示词已复制，发给其他 AI 后跟着回答问题即可");
  } catch {
    ElMessage.error("复制失败，请展开「查看完整提示词」后手动复制");
  }
}
</script>

<style lang="scss" scoped>
.providerPicker {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  height: min(560px, 70dvh);
  gap: 24px;

  .providerSidebar {
    overflow-y: auto;
    border-right: 1px solid var(--el-border-color-lighter);
    padding: 2px;

    .providerItem {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      text-align: left;
      cursor: pointer;

      &:hover { background: var(--el-fill-color-light); }
      &[aria-pressed="true"] {
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
      }
      &:focus-visible { outline: 2px solid var(--el-color-primary); }

      .providerLogo {
        width: 80px;
        height: 67px;
        object-fit: contain;

      }
    }
  }

  .providerDetails {
    min-width: 0;

    .providerContent {
      padding-right: 12px;

      .providerHeader {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 10px;
        margin: 4px 0 24px;

        h3 {
          margin: 0;
          color: var(--el-text-color-primary);
          font-size: 18px;
          overflow-wrap: anywhere;
        }
      }
      .providerReadme {
        margin-bottom: 24px;
        overflow-wrap: anywhere;
      }
      .modelHeader {
        margin: 8px 0 12px;
      }
      .modelList {
        margin-bottom: 16px;
      }
    }
  }

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 16px;

    .providerSidebar {
      max-height: 128px;
      border-right: 0;
      border-bottom: 1px solid var(--el-border-color-lighter);
    }
  }
}

.dialogContent {
  padding: 4px;

  .methodOption {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 4px 0;
  }

  .fileSource {
    display: flex;
    width: 100%;
    gap: 8px;

    .el-input { min-width: 0; }
    .el-button { flex-shrink: 0; }
  }

  .fieldHint {
    margin-top: 6px;
  }

  .sourceInput :deep(.el-textarea__inner) {
    height: min(28vh, 240px);
    min-height: 140px;
  }

  .providerTips {
    align-items: flex-start;

    :deep(.el-alert__content) {
      flex: 1;
      min-width: 0;
    }

    p {
      margin: 6px 0 12px;
      line-height: 1.6;
    }

    .promptDetails {
      margin-top: 12px;

      summary {
        width: fit-content;
        color: var(--el-text-color-secondary);
        cursor: pointer;
        &:hover { color: var(--el-color-primary); }
      }

      .el-textarea { margin-top: 12px; }
    }
  }

  .formError {
    margin-top: 16px;
  }
}
</style>
