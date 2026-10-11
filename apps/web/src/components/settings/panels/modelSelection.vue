<template>
  <div class="modelSelection">
    <p>分别选择当前工作区使用的平台和模型。用户、节点和 Agent 共用这些选择；未设置或调用失败时停止，不会自动切换到其他平台。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-form labelPosition="top" @submit.prevent="save()">
      <el-form-item v-for="kind in kinds" :key="kind.id" :label="kind.label">
        <el-select v-model="draft[kind.id]" :aria-label="`${kind.label}默认模型`" filterable clearable :disabled="loading || saving || !modelsReady" placeholder="未设置，请选择平台和模型" noDataText="没有可用模型，请先配置 API Key 并检查连接和余额" @change="save(kind.id)">
          <el-option v-if="draft[kind.id] && !choices(kind.id).some(item => keyOf(item) === draft[kind.id])" :value="draft[kind.id]" :label="`${modelsReady ? '已不可用' : '待确认'}：${unavailableLabel(draft[kind.id])}`" disabled />
          <el-option v-for="model in choices(kind.id)" :key="keyOf(model)" :value="keyOf(model)" :label="`${model.providerLabel} · ${model.label}`" />
        </el-select>
      </el-form-item>
      <el-space>
        <el-button :loading="loading" :disabled="saving" @click="load">刷新可用模型</el-button>
        <el-button v-if="saveFailed" type="primary" :loading="saving" :disabled="loading || !modelsReady" @click="save()">重试保存</el-button>
      </el-space>
    </el-form>
    <p class="note">只列出已配置 Key 且未被停用的模型。免费可用模型同样可以选择；已有会话或节点中的旧选择不能覆盖这里的设置。</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { settings, saveSettings } from "@/stores/settings";

type Kind = "text" | "image" | "video" | "audio";
type Choice = { providerId: string; modelId: string; providerLabel: string; label: string; type: Kind };
const kinds: { id: Kind; label: string }[] = [{ id: "text", label: "对话与文本" }, { id: "image", label: "图片" }, { id: "video", label: "视频" }, { id: "audio", label: "配音与音频" }];
const models = ref<Choice[]>([]);
const draft = ref<Record<Kind, string>>({ text: "", image: "", video: "", audio: "" });
const loading = ref(false);
const modelsReady = ref(false);
const saving = ref(false);
const saveFailed = ref(false);
const error = ref("");
const pendingKind = ref<Kind>();
const keyOf = (model: { providerId: string; modelId: string }) => JSON.stringify([model.providerId, model.modelId]);
const choices = (kind: Kind) => models.value.filter(model => model.type === kind);
function unavailableLabel(value: string) { try { return JSON.parse(value).join(" / "); } catch { return "请重新选择"; } }
function currentSelection() { return settings.value.modelSelection as Partial<Record<Kind, { providerId: string; modelId: string }>> | undefined; }

async function load() {
  if (loading.value) return;
  loading.value = true;
  modelsReady.value = false;
  error.value = "";
  try {
    const [text, media] = await Promise.all([axios.get("/api/ai/models?all=true", { timeout: 15000 }), axios.get("/api/ai/media/models?all=true", { timeout: 15000 })]);
    if (text.data.code !== 200 || media.data.code !== 200 || !Array.isArray(text.data.data) || !Array.isArray(media.data.data)) throw new Error("读取可用模型失败");
    models.value = [...text.data.data.map((model: Choice) => ({ ...model, type: "text" })), ...media.data.data];
    modelsReady.value = true;
  } catch (cause) {
    // 读取失败不能证明模型失效，保留上次列表与已保存的选择。
    error.value = axios.isAxiosError(cause) && (!cause.response || [502, 503, 504].includes(cause.response.status))
      ? "无法连接 LITTO 服务或请求超时，模型状态暂时无法确认。已保留原设置，请在服务恢复后刷新可用模型。"
      : axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : "读取可用模型失败";
  }
  finally { loading.value = false; }
}

async function save(kind = pendingKind.value) {
  if (!kind || !modelsReady.value || loading.value || saving.value) return;
  pendingKind.value = kind;
  saving.value = true;
  saveFailed.value = false;
  error.value = "";
  try {
    const model = choices(kind).find(item => keyOf(item) === draft.value[kind]);
    if (draft.value[kind] && !model) throw new Error("所选模型当前不可用，请重新选择");
    const selection = model ? { providerId: model.providerId, modelId: model.modelId } : null;
    await saveSettings(current => ({ modelSelection: { ...current.modelSelection as Record<string, unknown>, [kind]: selection } }));
    pendingKind.value = undefined;
    ElMessage.success("已保存，后续调用只使用你选定的平台和模型");
  } catch (cause) { saveFailed.value = true; error.value = `${axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "保存失败"}。选择已保留，请重试保存。`; }
  finally { saving.value = false; }
}

watch(() => settings.value.modelSelection, () => {
  const selection = currentSelection();
  for (const { id } of kinds) if (id !== pendingKind.value) draft.value[id] = selection?.[id] ? keyOf(selection[id]!) : "";
}, { immediate: true, deep: true });

onMounted(load);
</script>

<style scoped lang="scss">
.modelSelection {
  max-width: 680px;
  p { margin: 0 0 24px; line-height: 1.7; color: var(--el-text-color-secondary); }
  .el-select { width: 100%; }
  .note { margin-top: 24px; font-size: 12px; }
}
</style>
