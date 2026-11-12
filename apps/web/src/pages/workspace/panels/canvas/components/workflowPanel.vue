<template>
  <el-dialog v-model="visible" title="选区工作流" width="min(680px, 92vw)" appendToBody :closeOnClickModal="false" :beforeClose="close">
    <section class="workflowPanel" :aria-busy="busy">
      <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
      <fieldset :disabled="busy">
        <label>工作流名称<input v-model="name" maxlength="100" /></label>
        <button type="button" :disabled="!flow.getSelectedNodes.value.length" @click="run(save)">保存当前选区</button>
        <label>项目工作流<select v-model="path" @change="run(load)"><option value="">选择已保存工作流</option><option v-for="entry in entries" :key="entry.path" :value="entry.path">{{ entry.name }}</option></select></label>
        <label>导入工作流文件<input type="file" accept=".json,application/json" @change="readFile" /></label>
        <template v-if="template">
          <p>{{ template.name }} · {{ template.nodes.length }} 个节点 · {{ template.edges.length }} 条连接</p>
          <p>保留结构、提示词和画幅等设置。素材、模型凭据、旧项目路径及采用状态不随工作流导入；请核对提示词中的项目内容。</p>
          <label>归入当前项目镜头<select v-model="shotId"><option value="">不绑定镜头</option><option v-for="shot in summary?.shots ?? []" :key="shot.shotId" :value="shot.shotId">{{ shot.order + 1 }} · {{ shot.title }}</option></select></label>
          <label v-for="node in mediaNodes" :key="node.id">{{ node.data.label || node.type }} · 重新绑定素材
            <select v-model="bindings[node.id]"><option value="">留空，导入后在节点上传</option><option v-for="source in sources(node.type)" :key="source.id" :value="source.id">{{ source.data.label || source.id }}</option></select>
          </label>
          <button type="button" @click="download">导出工作流文件</button>
          <button type="button" @click="run(insert)">导入当前画布</button>
        </template>
      </fieldset>
    </section>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, inject, ref, type ShallowRef } from "vue";
import { useVueFlow, type Node, type Edge } from "@vue-flow/core";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { ProductionSummary } from "@/lib/productionShots";
import { getSelectionTree } from "../selectionNodes";
import { createWorkflow, workflowSchema, type WorkflowTemplate } from "../workflowTemplate";
const props = defineProps<{ directory: string; insertNodes: (snapshot: { nodes: Node[]; edges: Edge[] }) => Promise<void> }>();
const flow = useVueFlow(), files = useWorkspaceFiles(props.directory);
const summary = inject<ShallowRef<ProductionSummary>>("productionSummary");
const visible = ref(false), busy = ref(false), error = ref(""), message = ref(""), name = ref(""), path = ref(""), shotId = ref("");
const entries = ref<{ path: string; name: string }[]>([]), template = ref<WorkflowTemplate>();
const bindings = ref<Record<string, string>>({});
const mediaNodes = computed(() => template.value?.nodes.filter(node => /^remote-(image|video|audio)Node$/.test(node.type)) ?? []);
const sources = (type: string) => flow.getNodes.value.filter(node => node.type === type && Object.keys(node.data.outputs ?? {}).length);
async function run(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ""; message.value = ""; try { await action(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { busy.value = false; } }
async function list() { entries.value = (await files.list()).entries.filter(entry => /^workflow[a-f0-9]{32}\.json$/.test(entry.name)); }
function open() { visible.value = true; void run(list); }
function close(done: () => void) { if (!busy.value) done(); }
async function save() {
  const selection = getSelectionTree(flow.getSelectedNodes.value, flow.getNodes.value);
  const ids = new Set(selection.map(node => node.id));
  const nodes = selection.map(node => ({ ...node, parentNode: ids.has(node.parentNode ?? "") ? node.parentNode : undefined, position: ids.has(node.parentNode ?? "") ? node.position : { x: node.computedPosition.x, y: node.computedPosition.y } }));
  template.value = createWorkflow(name.value, nodes, flow.toObject().edges); bindings.value = {}; shotId.value = "";
  path.value = `workflow${crypto.randomUUID().replaceAll("-", "")}.json`;
  await files.writeJson(path.value, template.value, true); await list(); message.value = "工作流已保存";
}
async function load() { if (!path.value) return; template.value = workflowSchema.parse(await files.readJson(path.value)); bindings.value = {}; shotId.value = ""; }
function readFile(event: Event) { const input = event.target as HTMLInputElement, file = input.files?.[0]; if (file) void run(async () => { if (file.size > 2 * 1024 * 1024) throw new Error("工作流文件不得超过 2 MB"); template.value = workflowSchema.parse(JSON.parse(await file.text())); bindings.value = {}; shotId.value = ""; path.value = ""; input.value = ""; }); }
function download() { if (!template.value) return; const url = URL.createObjectURL(new Blob([JSON.stringify(template.value, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "workflow.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function insert() {
  const value = workflowSchema.parse(template.value);
  const nodes: Node[] = value.nodes.map(node => ({ ...node, data: { ...node.data, ...(node.data.prompt ? { promptModel: node.data.prompt.split("\n").map(text => [{ type: "Write", text }]) } : {}) } }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const depth = (node: Node): number => node.parentNode ? 1 + depth(byId.get(node.parentNode)!) : 0;
  nodes.sort((a, b) => depth(a) - depth(b));
  for (const node of nodes) if (bindings.value[node.id]) {
    const source = sources(node.type!).find(item => item.id === bindings.value[node.id]);
    if (!source) throw new Error("选定素材已变化，请重新绑定");
    node.data.outputs = JSON.parse(JSON.stringify(source.data.outputs));
  }
  if (shotId.value) {
    const shot = summary?.value.shots.find(item => item.shotId === shotId.value);
    if (!shot) throw new Error("镜头已变化，请重新选择");
    const groupId = crypto.randomUUID();
    const roots = nodes.filter(node => !node.parentNode), left = Math.min(...roots.map(node => node.position.x)), top = Math.min(...roots.map(node => node.position.y));
    for (const node of roots) { node.parentNode = groupId; node.position = { x: node.position.x - left + 24, y: node.position.y - top + 48 }; }
    const width = Math.max(...roots.map(node => node.position.x + (parseFloat(String((node.style as Record<string, unknown>)?.width)) || 360))) + 24;
    const height = Math.max(...roots.map(node => node.position.y + (parseFloat(String((node.style as Record<string, unknown>)?.height)) || 300))) + 24;
    nodes.unshift({ id: groupId, type: "canvasGroup", position: { x: 0, y: 0 }, style: { width: `${width}px`, height: `${height}px` }, data: { label: shot.title, productionUnitId: `shot${shot.shotId}` } });
  }
  await props.insertNodes({ nodes, edges: value.edges }); message.value = "已导入，可通过画布撤销；正式生成请在镜头制作中预览当前规格";
}
defineExpose({ open });
</script>
<style scoped lang="scss">
.workflowPanel { fieldset { border: 0; padding: 0; } label { display: grid; gap: 6px; margin: 12px 0; } input, select, button { font: inherit; padding: 8px; max-width: 100%; } button { margin: 4px; } [role="alert"] { color: var(--el-color-danger); } }
</style>
