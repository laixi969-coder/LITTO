<template>
  <main class="workspacePage" :style="{ '--agentWidth': `${agentVisible ? agentWidth : 0}px` }">
    <aside class="workspaceRail" aria-label="项目任务">
      <router-link class="railBrand" to="/home">LITTO <small>里头</small></router-link>
      <span class="projectTitle" :title="workspaceStore.project?.name">{{ workspaceStore.project?.name }}</span>
      <div ref="historyTarget" class="historyTarget" />
      <div class="railActions"><el-button text @click="agentVisible = !agentVisible"><icon-layout-sidebar-right :size="16" />{{ agentVisible ? '收起助手' : '打开助手' }}</el-button><el-button text @click="settingsVisible = true"><icon-settings :size="16" />设置</el-button></div>
    </aside>
    <canvasPanel
      :key="workspaceStore.project?.directory"
      ref="canvasPanelRef"
      class="canvasPanel"
      :class="{ backgroundPanel: activePanel !== 'canvas' }"
      :inert="activePanel !== 'canvas'"
      :aria-hidden="activePanel !== 'canvas'"
      :active="activePanel === 'canvas'"
      :settingsVisible="settingsVisible" />
    <keep-alive :max="1">
      <documentPanel
        v-if="activePanel === 'document'"
        :key="workspaceStore.project?.directory"
        ref="documentPanelRef"
        :readNode="readDocumentNode"
        :saveNode="saveDocumentNode" />
    </keep-alive>
    <workspaceMenu class="workspaceMenu" @openSettings="settingsVisible = true" />
    <el-segmented :modelValue="activePanel" class="panelSwitcher" :options="panelOptions" size="small" aria-label="切换面板" @change="switchPanel">
      <template #default="{ item }">
        <span class="panelOption">
          <component :is="item.icon" :size="14" aria-hidden="true" />
          {{ item.label }}
        </span>
      </template>
    </el-segmented>
    <el-tooltip v-if="!agentVisible" content="LITTO Agent" placement="bottom" :showArrow="false" :hideAfter="0">
      <el-button
        class="agentButton"
        :class="{ active: agentVisible }"
        :aria-expanded="agentVisible"
        aria-label="LITTO Agent"
        aria-controls="agentPanel"
        @click="agentVisible = !agentVisible"></el-button>
    </el-tooltip>
    <floatingAgent v-model="agentVisible" :historyTarget="historyTarget" @resize="agentWidth = $event" />
    <settings v-model="settingsVisible" />
    <el-button class="productionButton" @click="productionVisible = true">镜头制作</el-button>
    <productionPanel v-if="workspaceStore.project" :key="workspaceStore.project.directory" ref="productionPanelRef" v-model="productionVisible" :projectId="workspaceStore.project.projectId" :directory="workspaceStore.project.directory" />
  </main>
</template>

<script setup lang="ts">
import { defineAsyncComponent, nextTick, onMounted, onScopeDispose, provide, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import axios from "axios";
import { IconLayoutDashboard, IconFileText, IconLayoutSidebarRight, IconSettings } from "@tabler/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import settings from "@/components/settings/index.vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { registerWorkspaceControl, waitForControlValue } from "@/lib/mcpControl";
import anonymousData from "@/lib/anonymousData";
import canvasPanel from "./panels/canvas/canvasHost.vue";
import workspaceMenu from "./components/workspaceMenu.vue";
import floatingAgent from "./components/floatingAgent.vue";
import productionPanel from "./components/productionPanel.vue";
const productionVisible = ref(false);
const productionPanelRef = ref<InstanceType<typeof productionPanel>>();
provide("openProductionShot", (id: string) => productionPanelRef.value?.openShot(id));

const documentPanel = defineAsyncComponent(() => import("./panels/document/index.vue"));

const activePanel = ref<"canvas" | "document">("canvas");
onMounted(() => anonymousData.track("workspace.canvas"));
const workspaceStore = useWorkspaceStore();
const panelOptions = [
  { label: "画布", value: "canvas", icon: IconLayoutDashboard },
  { label: "文档", value: "document", icon: IconFileText },
];
const agentVisible = ref(window.innerWidth >= 760);
const agentWidth = ref(0);
const historyTarget = ref<HTMLElement>();
const settingsVisible = ref(false);
const canvasPanelRef = ref<InstanceType<typeof canvasPanel>>();
const documentPanelRef = ref<InstanceType<typeof documentPanel>>();
provide("canvas", () => canvasPanelRef.value?.getCanvasContext());
provide("mentionCanvas", () => canvasPanelRef.value?.mentionSource);
provide("activateCanvasPanel", () => switchPanel("canvas"));

const controlLifetime = new AbortController();
onScopeDispose(() => controlLifetime.abort(new Error("工作区已关闭")));
registerWorkspaceControl({
  getState: () => ({
    directory: workspaceStore.project?.directory ?? null,
    canvasId: canvasPanelRef.value?.canvasId || null,
    panel: activePanel.value,
    tools: canvasPanelRef.value?.canvasReady ? canvasPanelRef.value.getCanvasContext()?.tools ?? [] : [],
    document: documentPanelRef.value?.getDocument(false),
  }),
  flushSave,
  async call(request, signal) {
    const directory = workspaceStore.project?.directory;
    if (!directory) throw new Error("请先打开工作区");
    const callSignal = AbortSignal.any([signal, controlLifetime.signal]);
    const checkDirectory = () => {
      callSignal.throwIfAborted();
      if (directory !== workspaceStore.project?.directory) throw new Error("工作区已切换，本次调用已停止");
    };
    checkDirectory();
    if (request.name === "switchPanel") {
      if (request.args.panel !== "canvas" && request.args.panel !== "document") throw new Error("未知面板");
      if (!(await switchPanel(request.args.panel))) throw new Error("面板切换失败，请检查文档是否保存成功");
      checkDirectory();
      return { panel: activePanel.value };
    }
    if (["getDocument", "openDocument", "writeDocument"].includes(request.name)) {
      if (!(await switchPanel("document"))) throw new Error("文档面板无法打开");
      const panel = await waitForControlValue(() => documentPanelRef.value, callSignal);
      checkDirectory();
      if (request.name === "openDocument") await panel.openDocument(request.args, callSignal);
      if (request.name === "writeDocument") await panel.writeDocument(request.args, callSignal);
      checkDirectory();
      return panel.getDocument();
    }
    if (!(await switchPanel("canvas"))) throw new Error("画布面板无法打开");
    const context = await waitForControlValue(
      () => (canvasPanelRef.value?.canvasReady ? canvasPanelRef.value.getCanvasContext() : undefined),
      callSignal
    );
    checkDirectory();
    return context.call({ name: request.name, args: request.args }, callSignal);
  },
});

async function flushSave() {
  await productionPanelRef.value?.flushSave();
  await documentPanelRef.value?.flushSave();
  await canvasPanelRef.value?.flushSave();
}

onBeforeRouteLeave(async () => {
  if (canvasPanelRef.value?.saveBusy) {
    ElMessage.warning("画布操作尚未完成，请稍后退出");
    return false;
  }
  try {
    await flushSave();
    return true;
  } catch (error) {
    const message = axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.data?.message || error.message
      : error instanceof Error
      ? error.message
      : "项目保存失败";
    const leave = await ElMessageBox.confirm(`无法保存项目：${message}。文件或目录可能已被移动或删除。仍然退出将丢弃尚未保存的修改。`, "项目未保存", {
      type: "warning",
      confirmButtonText: "仍然退出",
      cancelButtonText: "留在项目",
      closeOnClickModal: false,
    }).then(
      () => true,
      () => false
    );
    if (leave) {
      documentPanelRef.value?.cancelSave();
      canvasPanelRef.value?.cancelSave();
    }
    return leave;
  }
});

async function switchPanel(value: string | number | boolean) {
  if (value !== "canvas" && value !== "document") return false;
  try {
    if (activePanel.value === "document") await documentPanelRef.value?.flushSave();
    const changed = activePanel.value !== value;
    activePanel.value = value;
    await nextTick();
    if (changed) anonymousData.track(value === "canvas" ? "workspace.canvas" : "workspace.document");
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文本保存失败");
    return false;
  }
}

function readDocumentNode(directory: string, canvasPath: string, nodeId: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.readDocumentNode(directory, canvasPath, nodeId);
}

function saveDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.saveDocumentNode(directory, canvasPath, nodeId, handleId, text);
}
</script>

<style scoped lang="scss">
.workspacePage {
  .productionButton { position: absolute; left: calc(var(--railWidth) + 16px); top: 64px; z-index: 7; min-height: 44px; }
  --railWidth: 208px;
  position: relative;
  width: 100%;
  height: 100dvh;
  background-color: var(--el-bg-color);

  .workspaceRail {
    position: absolute; inset: 0 auto 0 0; z-index: 6; display: flex; flex-direction: column; width: var(--railWidth); background: var(--studioRail); color: var(--studioRailInk);
    .railBrand { margin: 28px 24px 16px; color: inherit; text-decoration: none; font-size: 22px; font-weight: 650; letter-spacing: -0.04em; small { font-size: 12px; font-weight: 400; color: var(--studioRailMuted); } }
    .projectTitle { padding: 0 24px 20px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--studioRailHover); }
    .historyTarget { flex: 1; min-height: 0; overflow: auto; }
    .railActions { display: grid; padding: 16px; border-top: 1px solid var(--studioRailHover); .el-button { margin: 0; color: var(--studioRailInk); justify-content: flex-start; min-height: 44px; gap: 8px; } }
  }

  .canvasPanel {
    position: absolute;
    inset: 0 var(--agentWidth) 0 var(--railWidth);
    width: auto;
    height: auto;

    &.backgroundPanel {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
  }

  .workspaceMenu {
    position: absolute;
    top: 15px;
    left: calc(var(--railWidth) + 15px);
    z-index: 5;
  }

  .panelSwitcher {
    --el-border-radius-base: 999px;
    --el-segmented-bg-color: var(--el-bg-color-overlay);
    --el-segmented-item-selected-color: var(--el-color-primary);
    --el-segmented-item-selected-bg-color: var(--el-color-primary-light-9);
    position: absolute;
    top: 15px;
    left: calc((100% + var(--railWidth) - var(--agentWidth)) / 2);
    z-index: 5;
    min-height: 32px;
    padding: 3px;
    border: 1px solid var(--el-border-color-light);
    box-shadow: var(--el-box-shadow-lighter);
    font-size: 12px;
    transform: translateX(-50%);

    .panelOption {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 0 3px;
      line-height: 24px;
    }
  }

  .agentButton { position: absolute; top: 15px; right: 15px; z-index: 5; width: 36px; height: 36px; padding: 0; border: 1px solid var(--studioBorder); background: var(--studioSurface); &::before { content: "AI"; font-size: 12px; color: var(--studioDone); } }
  @media (max-width: 1000px) { --railWidth: 176px; }
  @media (max-width: 760px) { --railWidth: 0px; .workspaceRail { display: none; } .canvasPanel { right: 0; :deep(.canvasMenuPanel) { top: 58px; } :deep(.canvasMenu) { margin-left: 0; } } .panelSwitcher { left: 50%; } }
}
</style>
