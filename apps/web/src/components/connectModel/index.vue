<template>
  <el-dialog v-model="connectModelVisible" title="接入你的模型" width="min(880px, 94vw)" alignCenter appendToBody destroyOnClose :closeOnClickModal="!busy" :closeOnPressEscape="!busy">
    <p class="intro">模型用的是你自己的账号：把服务商给你的 Key 粘贴进来就行，费用直接结算给服务商。Key 只保存在你的账号里，页面上只会显示末四位。</p>
    <div class="cards" :class="{ single: connectModelFocus }">
      <!-- ① text -->
      <section v-if="connectModelFocus !== 'media'" class="card" aria-label="剧本与对话模型">
        <header>
          <div>
            <h3>剧本与对话模型</h3>
            <p>用来写剧本、拆分镜、和助手聊天</p>
          </div>
          <el-tag :type="connectedTextIds.size ? 'success' : 'info'" effect="light" round>{{ connectedTextIds.size ? "已连接 ✓" : "未连接" }}</el-tag>
        </header>
        <div class="chips" role="radiogroup" aria-label="选择服务商">
          <el-check-tag v-for="item in textPresets.filter(item => !item.custom)" :key="item.id" :checked="textPresetId === item.id" @change="pickText(item.id)">
            {{ connectedTextIds.has(item.id) ? "✓ " : "" }}{{ item.label }}
          </el-check-tag>
          <el-button size="small" @click="openCustom('text')">添加新供应商</el-button>
        </div>
        <template v-if="textConnected && !textReplacing">
          <div class="connected">
            <div><strong>{{ textConnected.label }}</strong> 已连接 · {{ textConnected.models.length }} 个模型</div>
            <el-text type="info" size="small">密钥 {{ textConnected.apiKey || "（无需密钥）" }}</el-text>
            <el-space>
              <el-button @click="textReplacing = true">更换 Key</el-button>
              <el-popconfirm title="断开后将删除这个服务商的 Key 和模型列表。" confirmButtonText="断开" cancelButtonText="取消" @confirm="disconnectText"><template #reference><el-button text type="danger">断开</el-button></template></el-popconfirm>
            </el-space>
          </div>
        </template>
        <el-form v-else class="form" labelPosition="top" @submit.prevent="saveText">
          <el-form-item v-if="textPreset.custom" label="API 地址">
            <el-input v-model="textUrl" dir="ltr" placeholder="https://你的服务商/v1" aria-label="API 地址" />
          </el-form-item>
          <el-form-item label="Key">
            <el-input v-model="textKey" type="password" showPassword autocomplete="off" dir="ltr" placeholder="粘贴你的 Key" aria-label="Key" @keyup.enter="saveText" />
          </el-form-item>
          <el-text class="help" type="info" size="small">在哪里获取 Key？{{ textPreset.keyHelp }}</el-text>
          <el-collapse v-if="!textPreset.custom" class="advanced" v-model="textAdvanced">
            <el-collapse-item title="高级" name="1">
              <el-form-item label="API 地址（一般不用改）"><el-input v-model="textUrl" dir="ltr" :placeholder="textPreset.apiUrl" aria-label="API 地址" /></el-form-item>
            </el-collapse-item>
          </el-collapse>
          <el-button type="primary" :loading="textBusy" :disabled="!canSaveText" @click="saveText">测试并保存</el-button>
        </el-form>
        <el-alert v-if="textResult" class="result" :title="textResult.message" :type="textResult.ok ? (textResult.verified === false ? 'warning' : 'success') : 'error'" :closable="false" showIcon />
      </section>

      <!-- ② media -->
      <section v-if="connectModelFocus !== 'text'" class="card" aria-label="图片与视频模型">
        <header>
          <div>
            <h3>图片与视频模型</h3>
            <p>用来出角色图、分镜画面和视频</p>
          </div>
          <el-tag :type="connectedMediaIds.size ? 'success' : 'info'" effect="light" round>{{ connectedMediaIds.size ? "已连接 ✓" : "未连接" }}</el-tag>
        </header>
        <div class="chips" role="radiogroup" aria-label="选择服务商">
          <el-check-tag v-for="item in mediaPresets" :key="item.id" :checked="mediaPresetId === item.id" @change="pickMedia(item.id)">
            {{ connectedMediaIds.has(item.id) ? "✓ " : "" }}{{ item.label }}
          </el-check-tag>
          <el-button size="small" @click="openCustom('media')">添加新供应商</el-button>
        </div>
        <p class="desc">{{ mediaPreset.desc }}</p>
        <template v-if="mediaConnectedKey && !mediaReplacing">
          <div class="connected">
            <div><strong>{{ mediaPreset.label }}</strong> 已连接</div>
            <el-text type="info" size="small">密钥 {{ mediaConnectedKey }}</el-text>
            <el-space>
              <el-button @click="mediaReplacing = true">修改连接</el-button>
              <el-popconfirm title="断开后将删除这个服务商的 Key。" confirmButtonText="断开" cancelButtonText="取消" @confirm="disconnectMedia"><template #reference><el-button text type="danger">断开</el-button></template></el-popconfirm>
            </el-space>
          </div>
        </template>
        <el-form v-else class="form" labelPosition="top" @submit.prevent="saveMedia">
          <el-form-item v-if="mediaPreset.regions" label="你的账号在哪个地区注册？">
            <el-radio-group v-model="mediaRegion" aria-label="请求地区"><el-radio value="1">国内</el-radio><el-radio value="2">海外</el-radio></el-radio-group>
          </el-form-item>
          <el-form-item label="Key">
            <el-input v-model="mediaKey" type="password" showPassword autocomplete="off" dir="ltr" placeholder="粘贴你的 Key" aria-label="Key" @keyup.enter="saveMedia" />
          </el-form-item>
          <el-form-item v-if="mediaPreset.secret" label="Secret Key（旧 AK/SK 认证填写，新 API Key 认证留空）">
            <el-input v-model="mediaSecret" type="password" showPassword autocomplete="off" dir="ltr" aria-label="Secret Key" />
          </el-form-item>
          <el-form-item v-if="mediaPreset.baseUrl !== undefined" label="API 地址（可填同协议中转地址）" :required="mediaPreset.urlRequired">
            <el-input v-model="mediaUrl" dir="ltr" :placeholder="mediaPreset.urlRequired ? 'https://你的工作空间.cn-beijing.maas.aliyuncs.com/api/v1' : mediaPreset.baseUrl || '留空使用所选地区的默认地址'" aria-label="媒体 API 地址" />
          </el-form-item>
          <el-text class="help" type="info" size="small">在哪里获取 Key？{{ mediaPreset.keyHelp }}</el-text>
          <el-button type="primary" :loading="mediaBusy" :disabled="!canSaveMedia" @click="saveMedia">检查并保存</el-button>
        </el-form>
        <el-alert v-if="mediaResult" class="result" :title="mediaResult.message" :type="mediaResult.ok ? (mediaResult.verified ? 'success' : 'warning') : 'error'" :closable="false" showIcon />
      </section>
    </div>
    <template #footer>
      <el-text class="footnote" type="info" size="small">服务商不在列表中？点击「添加新供应商」，填写名称、Base URL 和 API Key 即可配置。</el-text>
      <el-button type="primary" @click="connectModelVisible = false">完成</el-button>
    </template>
  </el-dialog>
  <component :is="customProviderDialog" v-model="customVisible" v-bind="customKind === 'media' ? { mode: 'connection' } : {}" />
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, defineAsyncComponent, ref, shallowRef, watch, type Component } from "vue";
import { ElMessage } from "element-plus";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import { customProviders, saveSettings, settings, type CustomProvider } from "@/stores/settings";
import { mediaPresets, nonChatModel, textPresets } from "./presets";
import { connectModelFocus, connectModelVisible } from "./state";

type TestResult = { ok: boolean; verified?: boolean; message: string; models?: { id: string; label: string; contextWindow?: number; maxOutputTokens?: number }[] };

const customProviderDialog = shallowRef<Component>();
const customVisible = ref(false);
const customKind = ref<"text" | "media">("text");
function openCustom(kind: "text" | "media") {
  connectModelVisible.value = false;
  customKind.value = kind;
  customProviderDialog.value = kind === "text"
    ? defineAsyncComponent(() => import("@/components/settings/panels/languageModel/addCustomProviderDialog.vue"))
    : defineAsyncComponent(() => import("@/components/settings/panels/mediaModel/addCustomProviderDialog.vue"));
  customVisible.value = true;
}

const textPresetId = ref(textPresets[0]!.id);
const textKey = ref("");
const textUrl = ref("");
const textAdvanced = ref<string[]>([]);
const textBusy = ref(false);
const textReplacing = ref(false);
const textResult = ref<TestResult>();

const mediaPresetId = ref(mediaPresets[0]!.id);
const mediaKey = ref("");
const mediaSecret = ref("");
const mediaUrl = ref("");
const mediaRegion = ref<"1" | "2">("1");
const mediaBusy = ref(false);
const mediaReplacing = ref(false);
const mediaResult = ref<TestResult>();

const busy = computed(() => textBusy.value || mediaBusy.value);
const textPreset = computed(() => textPresets.find(item => item.id === textPresetId.value)!);
const mediaPreset = computed(() => mediaPresets.find(item => item.id === mediaPresetId.value)!);
// "Other (OpenAI-compatible)" providers are saved as custom-<host>; they all light up the one "其他" chip.
const connectedTextIds = computed(() => new Set(customProviders.value.filter(item => item.models.length).map(item => item.id.startsWith("custom-") ? "custom" : item.id)));
const textConnected = computed<CustomProvider | undefined>(() => customProviders.value.find(item => item.models.length && (textPreset.value.custom ? item.id.startsWith("custom-") : item.id === textPresetId.value)));

function mediaConfigs() {
  const value = settings.value.mediaProviderConfigs;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Record<string, unknown> | undefined> : {};
}
const mediaKeyOf = (id: string) => { const key = mediaConfigs()[id]?.apiKey; return typeof key === "string" ? key.trim() : ""; };
const connectedMediaIds = computed(() => new Set(mediaPresets.filter(item => mediaKeyOf(item.id)).map(item => item.id)));
const mediaConnectedKey = computed(() => mediaKeyOf(mediaPresetId.value));

const canSaveText = computed(() => (textPreset.value.custom ? textUrl.value.trim() && textKey.value.trim() : textKey.value.trim().length > 0));
const canSaveMedia = computed(() => mediaKey.value.trim().length >= 8 && (!mediaPreset.value.urlRequired || !!mediaUrl.value.trim()));

function pickText(id: string) { textPresetId.value = id; textKey.value = ""; textUrl.value = ""; textResult.value = undefined; textReplacing.value = false; textAdvanced.value = []; }
function pickMedia(id: string) {
  mediaPresetId.value = id; mediaKey.value = mediaSecret.value = ""; mediaResult.value = undefined; mediaReplacing.value = false;
  const config = mediaConfigs()[id];
  mediaUrl.value = typeof config?.baseUrl === "string" ? config.baseUrl : mediaPreset.value.baseUrl ?? "";
  mediaRegion.value = config?.isOverseas === "2" ? "2" : "1";
}
watch(connectModelVisible, visible => {
  if (!visible) return;
  textKey.value = ""; mediaKey.value = ""; textResult.value = mediaResult.value = undefined; textReplacing.value = mediaReplacing.value = false;
  // Open on the first provider that is not connected yet.
  const open = textPresets.find(item => !connectedTextIds.value.has(item.id));
  if (!textConnected.value && open) textPresetId.value = textPresetId.value || open.id;
  const connected = mediaPresets.find(item => connectedMediaIds.value.has(item.id));
  pickMedia(connected?.id ?? mediaPresetId.value);
});

const maskKey = (key: string) => (key ? `••••${key.slice(-4)}` : "");
const errorText = (error: unknown) => axios.isAxiosError(error) ? error.response?.data?.message || "网络出了点问题，请稍后重试" : error instanceof Error ? error.message : "出错了，请重试";
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return "自定义服务商"; } };

async function saveText() {
  if (!canSaveText.value || textBusy.value) return;
  textBusy.value = true; textResult.value = undefined;
  const preset = textPreset.value;
  const apiUrl = (textUrl.value.trim() || preset.apiUrl).replace(/\/+$/, "");
  const apiKey = textKey.value.trim();
  try {
    const { data } = await axios.post<{ data: TestResult }>("/api/providers/test", { kind: "text", apiUrl, apiKey, protocol: preset.protocol, probeModel: preset.probeModel || undefined }, { timeout: 60000 });
    textResult.value = data.data;
    if (!data.data.ok) return;
    let models = (data.data.models ?? []).filter(item => !nonChatModel.test(item.id));
    if (!models.length) models = data.data.models ?? [];
    // A sensible default goes first: the picker preselects the first model.
    const first = [preset.defaultModel, preset.probeModel].find(id => id && models.some(item => item.id === id));
    if (first) models = [models.find(item => item.id === first)!, ...models.filter(item => item.id !== first)];
    if (!models.length) { textResult.value = { ok: false, message: "连上了，但没有拿到可用的模型" }; return; }
    const id = preset.custom ? `custom-${hostOf(apiUrl).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : preset.id;
    const label = preset.custom ? hostOf(apiUrl) : preset.label;
    await saveSettings(current => {
      const list = Array.isArray(current.customProviders) ? current.customProviders : [];
      return { customProviders: [...list.filter(item => item?.id !== id), { id, label, apiUrl, protocol: preset.protocol, apiKey, models }] };
    });
    // Do not keep the clear-text key in browser memory: swap in the masked form (the server restores the stored key from the mask).
    await saveSettings(current => ({ customProviders: (current.customProviders as CustomProvider[]).map(item => item.id === id ? { ...item, apiKey: maskKey(apiKey) } : item) }));
    textKey.value = ""; textUrl.value = ""; textReplacing.value = false;
    ElMessage.success(`${label} 已连接`);
  } catch (error) {
    textResult.value = { ok: false, message: errorText(error) };
  } finally { textBusy.value = false; }
}

async function disconnectText() {
  const id = textConnected.value?.id ?? textPresetId.value;
  try {
    await saveSettings(current => ({ customProviders: (Array.isArray(current.customProviders) ? current.customProviders : []).filter(item => item?.id !== id) }));
    textResult.value = undefined;
  } catch (error) { ElMessage.error(errorText(error)); }
}

async function saveMedia() {
  if (!canSaveMedia.value || mediaBusy.value) return;
  mediaBusy.value = true; mediaResult.value = undefined;
  const preset = mediaPreset.value;
  const apiKey = mediaKey.value.trim();
  const secret = mediaSecret.value.trim();
  const baseUrl = mediaUrl.value.trim() || preset.baseUrl;
  try {
    const { data } = await axios.post<{ data: TestResult }>("/api/providers/test", { kind: "media", providerId: preset.id, apiKey, secret: preset.secret ? secret : undefined, baseUrl, region: preset.regions ? mediaRegion.value : undefined }, { timeout: 60000 });
    mediaResult.value = data.data;
    if (!data.data.ok) return;
    await saveSettings(current => {
      const configs = mediaConfigs();
      return { mediaProviderConfigs: { ...configs, [preset.id]: { ...(configs[preset.id] ?? {}), apiKey, ...(preset.secret ? { secret } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}), ...(preset.regions ? { isOverseas: mediaRegion.value } : {}) } } };
    });
    await saveSettings(() => ({ mediaProviderConfigs: { ...mediaConfigs(), [preset.id]: { ...(mediaConfigs()[preset.id] ?? {}), apiKey: maskKey(apiKey), ...(preset.secret ? { secret: maskKey(secret) } : {}) } } }));
    invalidateNodeModels("media");
    mediaKey.value = mediaSecret.value = ""; mediaReplacing.value = false;
    ElMessage.success(`${preset.label} 已连接`);
  } catch (error) {
    mediaResult.value = { ok: false, message: errorText(error) };
  } finally { mediaBusy.value = false; }
}

async function disconnectMedia() {
  const id = mediaPresetId.value;
  try {
    await saveSettings(() => ({ mediaProviderConfigs: { ...mediaConfigs(), [id]: { ...(mediaConfigs()[id] ?? {}), apiKey: "", ...(mediaPreset.value.secret ? { secret: "" } : {}) } } }));
    invalidateNodeModels("media");
    mediaResult.value = undefined;
  } catch (error) { ElMessage.error(errorText(error)); }
}
</script>

<style scoped lang="scss">
.intro { margin: 0 0 16px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;
  &.single { grid-template-columns: minmax(0, 1fr); }
}
.card { display: flex; flex-direction: column; gap: 12px; padding: 18px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); min-width: 0;
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; h3 { margin: 0 0 4px; font-size: 16px; } p { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); } }
}
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.desc { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; }
.form { display: flex; flex-direction: column; gap: 8px; :deep(.el-form-item) { margin-bottom: 4px; } }
.connected { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 10px; background: var(--el-fill-color-light); }
.help { line-height: 1.5; }
.advanced { border: none; :deep(.el-collapse-item__header) { height: 32px; font-size: 12px; border: none; } :deep(.el-collapse-item__wrap) { border: none; } }
.result { margin: 4px 0; }
.footnote { margin-right: auto; }
@media (max-width: 720px) { .cards { grid-template-columns: minmax(0, 1fr); } }
</style>
