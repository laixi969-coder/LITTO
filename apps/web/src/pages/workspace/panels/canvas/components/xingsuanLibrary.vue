<template>
  <el-dialog v-model="visible" title="星算云素材库" width="min(620px, calc(100vw - 32px))" appendToBody @open="load">
    <el-form labelPosition="top" @submit.prevent>
      <el-form-item label="创建素材组"><div class="row"><el-input v-model="groupName" placeholder="素材组名称" aria-label="素材组名称" /><el-button type="primary" :loading="busy" :disabled="!groupName.trim()" @click="createGroup">创建</el-button></div></el-form-item>
      <el-form-item label="上传素材到素材组">
        <div class="fields">
          <el-select v-model="groupId" placeholder="选择素材组" aria-label="选择素材组"><el-option v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" /></el-select>
          <el-input v-model="assetName" placeholder="素材名称" aria-label="素材名称" />
          <el-input v-model="assetUrl" placeholder="公网可下载的素材 URL" aria-label="素材 URL" />
          <div class="row"><el-select v-model="assetType" aria-label="素材类型"><el-option label="图片" value="Image" /><el-option label="视频" value="Video" /></el-select><el-button type="primary" :loading="busy" :disabled="!groupId || !assetName.trim() || !assetUrl.trim()" @click="createAsset">上传</el-button></div>
        </div>
      </el-form-item>
    </el-form>
    <el-collapse><el-collapse-item v-for="group in groups" :key="group.id" :title="group.name" :name="group.id"><div v-for="asset in group.assets" :key="asset.id" class="assetRow"><span>{{ asset.name }}（{{ asset.type === 'Image' ? '图片' : '视频' }}）</span><el-button text :loading="checking === asset.id" @click="checkAsset(asset.id)">查询状态和链接</el-button></div></el-collapse-item></el-collapse>
    <el-alert v-if="result" class="result" :title="result" type="info" :closable="false" />
  </el-dialog>
</template>
<script setup lang="ts">
import { ref } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";

type Group = { id: string; name: string; assets: { id: string; name: string; type: "Image" | "Video" }[] };
const visible = defineModel<boolean>({ default: false });
const groups = ref<Group[]>([]);
const groupName = ref("");
const groupId = ref("");
const assetName = ref("");
const assetUrl = ref("");
const assetType = ref<"Image" | "Video">("Image");
const busy = ref(false);
const checking = ref("");
const result = ref("");
function showError(error: unknown) { ElMessage.error(axios.isAxiosError<{ message: string }>(error) ? error.response?.data.message || error.message : (error as Error).message); }
async function load() {
  try { groups.value = (await axios.get<{ data: Group[] }>("/api/xingsuan/list")).data.data; }
  catch (error) { showError(error); }
}
async function createGroup() {
  busy.value = true;
  try {
    groups.value = (await axios.post<{ data: Group[] }>("/api/xingsuan/createGroup", { name: groupName.value.trim(), description: "" })).data.data;
    groupName.value = "";
    ElMessage.success("素材组已创建");
  } catch (error) { showError(error); } finally { busy.value = false; }
}
async function createAsset() {
  busy.value = true;
  try {
    const response = await axios.post<{ data: { Status?: string } }>("/api/xingsuan/createAsset", { groupId: groupId.value, name: assetName.value.trim(), url: assetUrl.value.trim(), type: assetType.value }, { timeout: 100000 });
    result.value = `素材状态：${response.data.data.Status || "未知"}`;
    assetName.value = assetUrl.value = "";
    await load();
  } catch (error) { showError(error); } finally { busy.value = false; }
}
async function checkAsset(id: string) {
  checking.value = id;
  try {
    const { data } = await axios.get<{ data: { Status?: string; URL?: string } }>("/api/xingsuan/getAsset", { params: { id }, timeout: 100000 });
    result.value = `状态：${data.data.Status || "未知"}${data.data.URL ? `；临时链接（12 小时内有效）：${data.data.URL}` : ""}`;
  } catch (error) { showError(error); } finally { checking.value = ""; }
}
</script>
<style lang="scss" scoped>
.row { display: flex; width: 100%; gap: 8px; }
.fields { display: grid; width: 100%; gap: 8px; }
.assetRow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.result { margin-top: 12px; overflow-wrap: anywhere; }
</style>
