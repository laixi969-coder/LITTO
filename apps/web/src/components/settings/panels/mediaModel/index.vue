<template>
  <div v-if="loaded" class="providerList">
    <el-alert class="easyConnect" style="margin-bottom: 12px" type="info" showIcon :closable="false" title="只想快速接入自己的模型？">
      <el-button link type="primary" @click="openConnectModel('media')">简易接入 →</el-button>
    </el-alert>
    <div class="itemList">
      <el-card v-for="item in sortedProviders" :key="item.fileName" class="providerItem" shadow="never">
        <div class="providerHeader">
          <div v-if="item.id.toLowerCase() === 'tfrouter'" class="providerMark" aria-hidden="true">
            <brandLogo class="providerLogo" />
          </div>
          <div class="providerInfo">
            <div class="providerHeading">
              <el-text class="providerName" tag="strong">{{ item.label }}</el-text>
              <el-tag v-if="item.id.toLowerCase() === 'tfrouter'" size="small">官方</el-tag>
            </div>
            <el-text class="providerId" size="small" type="info" :title="item.fileName">{{ item.fileName }}</el-text>
          </div>
        </div>
        <el-alert v-if="item.loadError" :title="item.loadError" type="error" :closable="false" showIcon />
        <div class="providerFooter">
          <div class="providerMeta">
            <el-tag v-if="item.version" size="small" type="info" effect="plain">v{{ item.version }}</el-tag>
            <el-text size="small" type="info">{{ item.models.length }} 个模型</el-text>
          </div>
          <el-space class="itemActions" wrap>
            <el-button text @click="reenableProvider('media', item.id).catch(() => ElMessage.error('重新启用失败'))">修复后重新启用</el-button>
            <el-button v-if="item.canSyncModels || item.modelsUrl" text :icon="IconDownload" :disabled="!!deletingFile || !!item.loadError || !item.revision" @click="editProvider(item, true)">同步并选择模型</el-button>
            <el-button text :icon="IconEdit" :disabled="!!deletingFile || !!item.loadError" @click="editProvider(item)">编辑模型</el-button>
            <el-popconfirm title="确定删除此供应商及其模型？" confirmButtonText="删除" cancelButtonText="取消" @confirm="deleteProvider(item)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :loading="deletingFile === item.fileName" :disabled="!!deletingFile || !item.revision">删除</el-button></template>
            </el-popconfirm>
          </el-space>
        </div>
      </el-card>
    </div>
    <div class="providerActions">
      <el-button class="addButton" :icon="IconPlus" @click="openAdd('builtin')">添加供应商</el-button>
      <el-button class="addButton" :icon="IconSettings" @click="openAdd('custom')">添加自定义供应商</el-button>
    </div>
    <component :is="mediaProviderDialog" v-model="providerDialogVisible" :mode="addMode" @added="saveProviderItem" />
    <component :is="editProviderDialog" v-model="editorVisible" :provider="editingProvider" :syncOnOpen="syncOnOpen" @saved="saveProviderItem" />
  </div>
</template>

<script setup lang="ts">
import { openConnectModel } from "@/components/connectModel/state";
import axios from "axios";
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref, shallowRef, type Component } from "vue";
import { ElMessage } from "element-plus";
import { IconPlus, IconSettings, IconEdit, IconTrash, IconDownload } from "@tabler/icons-vue";
import brandLogo from "@/components/brandLogo.vue";
import type { MediaProvider } from "./types";
import { saveSettings, reenableProvider } from "@/stores/settings";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";

const { visible = true } = defineProps<{ visible?: boolean }>();
const mediaProviderDialog = shallowRef<Component>();
const editProviderDialog = shallowRef<Component>();
const providers = ref<MediaProvider[]>([]);
const sortedProviders = computed(() => [...providers.value].sort((a, b) => Number(b.id.toLowerCase() === "tfrouter") - Number(a.id.toLowerCase() === "tfrouter")));
const loaded = ref(false);
const providerDialogVisible = ref(false);
const editorVisible = ref(false);
const addMode = ref<"builtin" | "custom">("builtin");
const editingProvider = ref<MediaProvider>();
const deletingFile = ref("");
const syncOnOpen = ref(false);
let loadRequest = 0;

function refreshInstalled(event: WindowEventMap["toonflow:plugin-installed"]) {
  if (event.detail.type === "provider") void loadProviders();
}
onMounted(() => {
  void loadProviders();
  window.addEventListener("toonflow:plugin-installed", refreshInstalled);
});
onBeforeUnmount(() => {
  loadRequest++;
  window.removeEventListener("toonflow:plugin-installed", refreshInstalled);
});

async function loadProviders() {
  const request = ++loadRequest;
  try {
    const { data } = await axios.get<{ data: MediaProvider[] }>("/api/providers/media/list");
    if (request === loadRequest) providers.value = data.data;
  } catch (error) {
    if (request === loadRequest) ElMessage.error(axios.isAxiosError(error) ? error.response?.data?.message || error.message : "读取媒体供应商失败");
  } finally {
    if (request === loadRequest) loaded.value = true;
  }
}

function openAdd(mode: "builtin" | "custom") {
  mediaProviderDialog.value ??= defineAsyncComponent(() => import("./addCustomProviderDialog.vue"));
  addMode.value = mode;
  providerDialogVisible.value = true;
}

function editProvider(provider: MediaProvider, sync = false) {
  if (deletingFile.value || provider.loadError) return;
  editProviderDialog.value ??= defineAsyncComponent(() => import("./editProviderDialog.vue"));
  editingProvider.value = provider;
  syncOnOpen.value = sync;
  editorVisible.value = true;
}

async function deleteProvider(provider: MediaProvider) {
  if (deletingFile.value || !provider.revision) return;
  deletingFile.value = provider.fileName;
  let deleted = false;
  try {
    await axios.delete("/api/providers/media/delete", { data: { fileName: provider.fileName, revision: provider.revision } });
    deleted = true;
    loadRequest++;
    invalidateNodeModels("media");
    providers.value = providers.value.filter(item => item.fileName !== provider.fileName);
    await saveSettings(settings => {
      const configs = settings.mediaProviderConfigs;
      if (!configs || typeof configs !== "object" || Array.isArray(configs) || !Object.hasOwn(configs, provider.id)) return;
      const current = { ...configs } as Record<string, unknown>;
      delete current[provider.id];
      return { mediaProviderConfigs: current };
    });
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "删除失败，请重试";
    ElMessage.error(deleted ? `供应商已删除，连接配置未清理：${message}` : message);
  } finally { deletingFile.value = ""; }
}

function saveProviderItem(provider: MediaProvider) {
  loadRequest++;
  const index = providers.value.findIndex(item => item.fileName === provider.fileName);
  if (index < 0) providers.value.push(provider);
  else providers.value.splice(index, 1, provider);
}
</script>

<style lang="scss" scoped src="../../providerList.scss"></style>
