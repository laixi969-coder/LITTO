<template>
  <main class="home">
    <aside class="homeRail" aria-label="工作台导航">
      <div class="railBrand">
        <el-image :src="logoUrl" fit="contain" alt="LITTO" />
        <strong>
          LITTO
          <small>里头</small>
        </strong>
      </div>
      <nav>
        <a class="railLink selected" href="#/home" aria-current="page">
          <icon-layout-grid :size="18" />
          开拍台
        </a>
        <a class="railLink" href="#/home" @click.prevent="showProjects">
          <icon-folder :size="18" />
          我的项目
        </a>
      </nav>
      <div class="railFooter">
        <el-button text :icon="IconPlugConnected" @click="openConnectModel()">接入模型</el-button>
        <el-badge isDot :hidden="!hasDesktopUpdate"><el-button text :icon="IconSettings" @click="settingsVisible = true">设置</el-button></el-badge>
        <span>好戏，都在里头。</span>
      </div>
    </aside>
    <div class="homeBody">
      <header class="pageHeader">
        <span>创作工作台</span>
        <div class="accountBar">
          <usageSummary v-if="accounts" />
          <el-text v-if="accounts" class="accountEmail" :title="me?.user.email">{{ me?.user.email }}</el-text>
          <el-button v-if="accounts" text @click="logout()">退出登录</el-button>
        </div>
      </header>
      <div class="pageContent">
        <el-alert v-if="needsModels && !bannerDismissed" class="connectBanner" type="warning" showIcon @close="dismissBanner">
          <template #title>接入模型，准备开拍</template>
          <div class="connectBannerBody">
            <span>
              {{
                !hasTextModel && !hasMediaModel
                  ? "还需要接入文本和图片 / 视频模型。"
                  : !hasTextModel
                    ? "还需要接入文本模型。"
                    : "还需要接入图片 / 视频模型。"
              }}
            </span>
            <el-button size="small" @click="openConnectModel(!hasTextModel ? 'text' : 'media')">接入模型</el-button>
          </div>
        </el-alert>
        <section class="creationPanel" aria-label="创建项目">
          <div class="creationHeading">
            <h1>今天，想拍点什么？</h1>
            <p>从一句想法开始，让剧本、角色和画面在同一张画布上成形。</p>
          </div>
          <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '20px 24px' }" :footerStyle="{ padding: '12px 24px' }">
            <attachmentList
              v-if="promptAttachments.length"
              :attachments="promptAttachments"
              removable
              restorable
              :disabled="creating || opening"
              @remove="promptAttachments.splice($event, 1)"
              @restore="restoreAttachment" />
            <el-input
              ref="promptInput"
              v-model="prompt"
              type="textarea"
              :rows="3"
              resize="none"
              :disabled="creating || opening"
              :placeholder="promptPlaceholder"
              aria-label="创作描述"
              @paste.capture="pasteText" />
            <template #footer>
              <div class="composerFooter">
                <workspacePicker v-if="!accounts" ref="promptWorkspacePicker" v-model="workspaceDirectory" :disabled="creating || opening" />
                <span v-else class="composerHint">先写想法，再一起细化。</span>
                <div class="sendActions">
                  <modelPopover
                    v-model="selectedModel"
                    v-model:reasoningEffort="reasoningEffort"
                    class="modelSelect"
                    :disabled="creating || opening" />
                  <el-button
                    type="primary"
                    :icon="canSend ? IconArrowUp : IconFolder"
                    :loading="creating"
                    :disabled="creating || opening || (canSend && !prompt.trim() && !promptAttachments.length)"
                    @click="canSend ? createProject() : promptWorkspacePicker?.chooseDirectory()">
                    {{ canSend ? "开始创作" : "选择工作目录" }}
                  </el-button>
                </div>
              </div>
              <p v-if="!accounts && !workspaceDirectory" class="workspaceHint">先选择一个空文件夹，保存画布和素材。</p>
            </template>
          </el-card>
          <div class="creationChoices">
            <button
              v-for="lane in creationLanes"
              :key="lane.kind"
              type="button"
              class="creationChoice"
              :disabled="creating || opening"
              @click="openBrief(lane.kind)">
              <component :is="lane.icon" :size="28" />
              <span>
                <strong>{{ lane.title }}</strong>
                <span>{{ lane.desc }}</span>
              </span>
              <icon-arrow-up-right :size="20" />
            </button>
          </div>
        </section>
        <section class="projectList" aria-labelledby="projectListTitle">
          <div class="sectionHeader">
            <h2 id="projectListTitle">
              我的项目
              <span>{{ projectList.length }}</span>
            </h2>
            <el-space wrap>
              <el-button v-if="!accounts" :icon="IconFolderOpen" :disabled="creating || opening" @click="openProject()">导入项目</el-button>
              <el-button :icon="IconFolderPlus" :disabled="creating || opening" @click="createProject(false)">新建空项目</el-button>
              <el-button
                circle
                :icon="sortDescending ? IconSortDescending : IconSortAscending"
                :aria-label="sortDescending ? '按时间降序' : '按时间升序'"
                @click="sortDescending = !sortDescending" />
              <el-radio-group v-model="viewMode" aria-label="项目视图">
                <el-radio-button value="grid" aria-label="网格视图"><icon-layout-grid :size="16" /></el-radio-button>
                <el-radio-button value="list" aria-label="列表视图"><icon-list :size="16" /></el-radio-button>
              </el-radio-group>
            </el-space>
          </div>
          <div v-if="!projectList.length" class="projectEmpty">
            <icon-folder :size="28" />
            <h3>你的第一部作品，从这里开始。</h3>
            <p>写下想法，或选择上面的创作方式。</p>
          </div>
          <div class="projectItems" :class="{ listView: viewMode === 'list' }">
            <article v-for="project in sortedProjects" :key="project.directory" class="projectCard">
              <button
                class="projectEntry"
                type="button"
                :disabled="creating || opening"
                :aria-label="'打开项目 ' + project.name"
                @click="openProject(project)">
                <workspacePreview
                  :directory="project.directory"
                  :path="projectSummaries[project.directory]?.preview?.path"
                  :mimeType="projectSummaries[project.directory]?.preview?.mimeType"
                  :label="project.name" />
                <span class="projectInfo">
                  <strong class="projectName">{{ project.name }}</strong>
                  <span class="projectProgress">
                    {{
                      projectSummaries[project.directory]?.error ||
                      (projectSummaries[project.directory]
                        ? projectSummaries[project.directory].count + " 个画面 · 已生成 " + projectSummaries[project.directory].generated + " 个"
                        : "读取项目…")
                    }}
                  </span>
                  <span class="projectTime">最近打开 {{ new Date(project.lastOpenedAt).toLocaleDateString(locale) }}</span>
                </span>
              </button>
              <div class="projectActions">
                <el-button
                  text
                  :icon="IconEdit"
                  :disabled="creating || opening"
                  :aria-label="'重命名项目 ' + project.name"
                  title="重命名"
                  @click="renameProject(project)" />
                <el-button
                  text
                  :icon="IconTrash"
                  :disabled="creating || opening"
                  :aria-label="'移除项目 ' + project.name"
                  title="从列表移除，不删除文件"
                  @click="workspaceStore.removeProject(project.directory)" />
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
    <el-dialog
      v-model="briefVisible"
      :title="currentLane.title"
      width="min(560px, calc(100vw - 32px))"
      alignCenter
      :closeOnClickModal="!creating">
      <el-form class="briefForm" labelPosition="top" @submit.prevent="startBrief">
        <el-form-item :label="currentLane.label" required>
          <el-input
            v-model="brief.subject"
            type="textarea"
            :rows="3"
            :disabled="creating"
            :placeholder="currentLane.placeholder" />
        </el-form-item>
        <el-form-item label="给谁看"><el-input v-model="brief.audience" :disabled="creating" placeholder="填写目标受众" /></el-form-item>
        <el-form-item label="时长"><el-input v-model="brief.duration" :disabled="creating" placeholder="填写期望时长" /></el-form-item>
        <el-form-item label="画面风格"><el-input v-model="brief.style" :disabled="creating" placeholder="描述你想要的画面风格" /></el-form-item>
        <div class="briefActions">
          <el-button :disabled="creating" @click="briefVisible = false">取消</el-button>
          <el-button type="primary" :loading="creating" :disabled="!brief.subject.trim()" @click="startBrief">开始创作</el-button>
        </div>
      </el-form>
    </el-dialog>
    <settings v-model="settingsVisible" />
    <workspacePicker ref="relocationPicker" hideTrigger />
  </main>
</template>

<script setup lang="ts">
import { locale } from "@toonflow/i18n/vue";
import axios from "axios";
import { storeToRefs } from "pinia";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox, type InputInstance } from "element-plus";
import {
  IconSettings,
  IconPlugConnected,
  IconArrowUp,
  IconLayoutGrid,
  IconMovie,
  IconSpeakerphone,
  IconMusic,
  IconFileImport,
  IconArrowUpRight,
  IconList,
  IconSortDescending,
  IconSortAscending,
  IconFolder,
  IconEdit,
  IconTrash,
  IconFolderPlus,
  IconFolderOpen,
} from "@tabler/icons-vue";
import modelPopover from "@/components/modelPopover.vue";
import attachmentList from "@/components/agent/attachmentList.vue";
import { createPastedTextFile, readTextAttachment } from "@/components/agent/textAttachments";
import type { AgentAttachment } from "@/components/agent/types";
import logoUrl from "@toonflow/assets/logo.svg";
import { useWorkspaceStore, type Project } from "@/stores/workspace";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import settings from "@/components/settings/index.vue";
import usageSummary from "@/components/usageSummary.vue";
import workspacePreview from "@/components/workspacePreview.vue";
import { getCanvasShots, type CanvasShot } from "@/lib/canvasShots";
import { isCanvasFile } from "@/pages/workspace/canvasFile";
import { getMe, isAuthDisabled, logout } from "@/lib/session";
import { openConnectModel } from "@/components/connectModel/state";
import { customProviders, settings as settingsStore } from "@/stores/settings";
import workspacePicker from "./workspacePicker.vue";

const settingsVisible = ref(false);
const me = getMe();
const accounts = !isAuthDisabled();
const canSend = computed(() => accounts || !!workspaceDirectory.value);
// "Ready" = at least one text model with models, and a media provider with a key (masked values count: they mean a key is stored).
const hasTextModel = computed(() => customProviders.value.some((item) => item.models.length > 0));
const hasMediaModel = computed(() => {
  const configs = settingsStore.value.mediaProviderConfigs;
  return (
    !!configs &&
    typeof configs === "object" &&
    Object.values(configs as Record<string, { apiKey?: unknown } | undefined>).some((item) => typeof item?.apiKey === "string" && item.apiKey.trim())
  );
});
const needsModels = computed(() => !hasTextModel.value || !hasMediaModel.value);
const bannerKey = "litto:connect-banner-dismissed";
const bannerDismissed = ref(
  (() => {
    try {
      return localStorage.getItem(bannerKey) === "1";
    } catch {
      return false;
    }
  })(),
);
function dismissBanner() {
  bannerDismissed.value = true;
  try {
    localStorage.setItem(bannerKey, "1");
  } catch {
    /* per-viewer convenience only */
  }
}
const router = useRouter();
const creating = ref(false);
const opening = ref(false);
const promptWorkspacePicker = ref<InstanceType<typeof workspacePicker>>();
const relocationPicker = ref<InstanceType<typeof workspacePicker>>();
const prompt = ref("");
const promptInput = ref<InputInstance>();
const promptAttachments = ref<AgentAttachment[]>([]);
const workspaceStore = useWorkspaceStore();
const { project, projectList } = storeToRefs(workspaceStore);
const workspaceDirectory = ref(project.value?.directory ?? "");
const promptPlaceholder = "描述你的故事、产品或镜头想法…";

const selectedModel = ref("");
const reasoningEffort = ref("");
const sortDescending = ref(true);
const viewMode = ref("grid");
const sortedProjects = computed(() =>
  [...projectList.value].sort((left, right) =>
    sortDescending.value ? right.lastOpenedAt - left.lastOpenedAt : left.lastOpenedAt - right.lastOpenedAt,
  ),
);

function pasteText(event: ClipboardEvent) {
  if (creating.value || opening.value) return;
  try {
    const file = createPastedTextFile(event.clipboardData?.getData("text/plain") ?? "");
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (promptAttachments.value.length >= 20) return ElMessage.warning("每条消息最多添加 20 个附件");
    promptAttachments.value.push({ name: file.name, path: "", mimeType: file.type, file });
  } catch (error) {
    event.preventDefault();
    event.stopImmediatePropagation();
    ElMessage.error(error instanceof Error ? error.message : "添加文本附件失败，请重试");
  }
}

async function restoreAttachment(index: number) {
  const attachment = promptAttachments.value[index];
  if (!attachment || creating.value || opening.value) return;
  try {
    const text = await readTextAttachment(attachment);
    const currentIndex = promptAttachments.value.indexOf(attachment);
    if (currentIndex < 0 || creating.value || opening.value) return;
    prompt.value += `${prompt.value ? "\n" : ""}${text}`;
    promptAttachments.value.splice(currentIndex, 1);
    await nextTick();
    promptInput.value?.focus();
    promptInput.value?.textarea?.setSelectionRange(prompt.value.length, prompt.value.length);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "取回文本失败，请重试");
  }
}

async function openProject(project?: Project) {
  if (creating.value || opening.value) return;
  opening.value = true;
  try {
    const directory = project?.directory ?? (await relocationPicker.value?.chooseDirectory());
    if (!directory) return;
    try {
      await workspaceStore.openProject(directory);
    } catch (err) {
      if (!project || !axios.isAxiosError(err) || err.response?.status !== 404) throw err;
      const reselect = await ElMessageBox.confirm(`项目“${project.name}”的文件夹不存在，是否重新选择文件夹？`, "工作目录不存在", {
        confirmButtonText: "重新选择",
        cancelButtonText: "取消",
        type: "warning",
      }).then(
        () => true,
        () => false,
      );
      if (!reselect) return;
      const directory = await relocationPicker.value?.chooseDirectory();
      if (!directory) return;
      await workspaceStore.openProject(directory, project.directory);
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(
      axios.isAxiosError<{ message?: string }>(err)
        ? err.response?.data.message || "无法打开项目，请重试"
        : err instanceof Error
          ? err.message
          : "无法打开项目，请重试",
    );
  } finally {
    opening.value = false;
  }
}

async function renameProject(project: Project) {
  const result = await ElMessageBox.prompt("请输入项目名称", "重命名项目", {
    inputValue: project.name,
    confirmButtonText: "保存",
    cancelButtonText: "取消",
    inputValidator: (value) => !!value?.trim() || "项目名称不能为空",
  }).catch(() => null);
  if (result) workspaceStore.renameProject(project.directory, result.value);
}

async function createProject(fromPrompt = true) {
  if (creating.value || opening.value || (fromPrompt && !accounts && !workspaceDirectory.value)) return;
  // Sending an idea without a text model would just fail: take the person to the one-minute wizard instead.
  if (fromPrompt && prompt.value.trim() && !hasTextModel.value) {
    briefVisible.value = false;
    return openConnectModel("text");
  }
  creating.value = true;
  try {
    let path = workspaceDirectory.value;
    if (accounts) {
      // Accounts mode: the server makes an empty project folder inside the caller's own workspace; no folder picking.
      const title = fromPrompt
        ? prompt.value
            .trim()
            .replace(/^\/skill:\S+\s*/, "")
            .split(/\n/)[0]
            ?.slice(0, 24)
        : "";
      path = (await axios.post<{ data: { directory: string } }>("/api/workspaces/createProject", { name: title })).data.data.directory;
    } else if (!fromPrompt) {
      const confirmed = await ElMessageBox.confirm("请选择一个空文件夹作为项目目录，画布和素材将保存在其中。", "添加项目", {
        confirmButtonText: "选择空文件夹",
        cancelButtonText: "取消",
        type: "info",
      }).then(
        () => true,
        () => false,
      );
      if (!confirmed) return;
      path = (await relocationPicker.value?.chooseDirectory()) ?? "";
      if (!path) return;
    }
    const { directory, empty } = await useWorkspaceFiles(path).list();
    if (!empty) return ElMessage.warning("该文件夹不为空，请重新选择空文件夹；已有项目请使用“导入项目”或点击项目列表打开。");
    await useWorkspaceFiles(directory).writeJson(
      "画布1.json",
      { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      true,
    );
    await workspaceStore.openProject(directory);
    if (fromPrompt && (prompt.value.trim() || promptAttachments.value.length)) {
      workspaceStore.pendingAgentMessage = {
        directory: workspaceStore.project!.directory,
        prompt: prompt.value,
        attachments: [...promptAttachments.value],
        model: selectedModel.value,
        reasoningEffort: reasoningEffort.value,
      };
    }
    briefVisible.value = false;
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(
      axios.isAxiosError<{ message?: string }>(err)
        ? err.response?.data.message || "创建项目失败，请重试"
        : err instanceof Error
          ? err.message
          : "创建项目失败，请重试",
    );
  } finally {
    creating.value = false;
  }
}
const briefVisible = ref(false);
// 四条创意通道各对应一个技能；“已有素材”走 story 的定稿剧本整理分支。
const creationLanes = [
  { kind: "story", skill: "story", icon: IconMovie, title: "写一个故事", desc: "从一句想法出发，打磨故事、剧本与镜头。", label: "故事想法", placeholder: "主角是谁？发生了什么？" },
  { kind: "creative", skill: "adfilm", icon: IconSpeakerphone, title: "做一支广告", desc: "围绕产品与受众，把卖点拍清楚。", label: "产品与卖点", placeholder: "要介绍什么产品？最想让人记住什么？" },
  { kind: "musicFilm", skill: "musicfilm", icon: IconMusic, title: "拍一支 MV", desc: "从歌曲与歌词出发，理解情绪，再设计影像。", label: "歌曲与想法", placeholder: "哪首歌？想要什么感觉？歌词可以稍后上传。" },
  { kind: "existing", skill: "story", icon: IconFileImport, title: "已有剧本或素材", desc: "导入剧本、参考片或参考图，整理后继续。", label: "手上有什么", placeholder: "粘贴剧本，或说明你的参考素材。" },
] as const;
type LaneKind = (typeof creationLanes)[number]["kind"];
const briefKind = ref<LaneKind>("story");
const currentLane = computed(() => creationLanes.find((lane) => lane.kind === briefKind.value)!);
const brief = reactive({ subject: "", audience: "", duration: "", style: "" });
function showProjects() {
  document.getElementById("projectListTitle")?.scrollIntoView();
}
function openBrief(kind: LaneKind) {
  briefKind.value = kind;
  Object.assign(brief, { subject: prompt.value, audience: "", duration: "", style: "" });
  briefVisible.value = true;
}
async function startBrief() {
  if (!brief.subject.trim() || creating.value) return;
  prompt.value = [
    "/skill:" + currentLane.value.skill + " " + brief.subject.trim(),
    brief.audience && "目标受众：" + brief.audience,
    brief.duration && "时长：" + brief.duration,
    brief.style && "画面风格：" + brief.style,
    "开始前只追问必要的缺失信息，最多 4 个问题。",
  ]
    .filter(Boolean)
    .join("\n");
  if (!accounts && !workspaceDirectory.value) {
    workspaceDirectory.value = (await relocationPicker.value?.chooseDirectory()) ?? "";
    if (!workspaceDirectory.value) return;
  }
  await createProject();
}
const projectSummaries = ref<Record<string, { count: number; generated: number; preview?: CanvasShot; error?: string }>>({});
watch(
  () => projectList.value.map((item) => item.directory),
  async (directories, _previous, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    // ACT: 项目和画布逐个读取，避免列表同时发起大量磁盘请求；大列表可改为按可见项目加载。
    for (const directory of directories) {
      try {
        const files = useWorkspaceFiles(directory);
        const { entries } = await files.list();
        if (!active) return;
        const shots: CanvasShot[] = [];
        for (const entry of entries) {
          if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
          if (!(await isCanvasFile(files, entry.path))) continue;
          const canvas = await files.readJson<unknown>(entry.path);
          if (canvas && typeof canvas === "object" && "toonflowCanvas" in canvas && canvas.toonflowCanvas === true && "nodes" in canvas)
            shots.push(...getCanvasShots(canvas.nodes));
          if (!active) return;
        }
        projectSummaries.value[directory] = {
          count: shots.length,
          generated: shots.filter((item) => item.path).length,
          preview: shots.find((item) => item.path),
        };
      } catch {
        if (active) projectSummaries.value[directory] = { count: 0, generated: 0, error: "项目暂时无法读取" };
      }
      if (!active) return;
    }
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.home {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  min-height: 100dvh;
  background: var(--studioPage);
  color: var(--studioInk);
  .homeRail {
    position: sticky;
    top: 0;
    height: 100dvh;
    padding: 32px 20px 24px;
    display: flex;
    flex-direction: column;
    background: var(--studioRail);
    color: var(--studioRailInk);
    .railBrand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 8px 48px;
      .el-image {
        width: 28px;
        height: 28px;
        filter: invert(1);
      }
      strong {
        font-size: 22px;
        letter-spacing: -0.04em;
        white-space: nowrap;
      }
      small {
        font-size: 12px;
        font-weight: 400;
        margin-left: 4px;
        color: var(--studioRailMuted);
      }
    }
    nav {
      display: grid;
      gap: 8px;
      .railLink {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-radius: var(--ui-radius);
        color: var(--studioRailMuted);
        text-decoration: none;
        font-size: 14px;
        &:hover,
        &.selected {
          background: var(--studioRailHover);
          color: var(--studioRailInk);
        }
      }
    }
    .railFooter {
      margin-top: auto;
      display: grid;
      gap: 8px;
      .el-button {
        justify-content: flex-start;
        width: 100%;
        min-height: 44px;
        margin: 0;
        color: var(--studioRailInk);
      }
      > span {
        margin: 24px 12px 0;
        font-size: 12px;
        color: var(--studioRailMuted);
      }
    }
  }
  .homeBody {
    min-width: 0;
  }
  .pageHeader {
    min-height: 80px;
    padding: 16px 40px;
    border-bottom: 1px solid var(--studioBorder);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    > span {
      font-size: 13px;
      color: var(--studioMuted);
    }
    .accountBar {
      display: flex;
      align-items: center;
      gap: 16px;
      .accountEmail {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
    }
  }
  .pageContent {
    max-width: 1240px;
    padding: 24px 40px 64px;
    margin: auto;
    .connectBanner {
      margin-bottom: 32px;
      background: var(--studioAttentionSoft);
      color: var(--studioAttention);
      .connectBannerBody {
        display: flex;
        align-items: center;
        gap: 16px;
        font-size: 12px;
        margin-top: 4px;
      }
    }
    .creationPanel {
      margin: 24px 0 48px;
      .creationHeading {
        margin-bottom: 24px;
        h1 {
          font-size: 32px;
          font-weight: 600;
          letter-spacing: -0.04em;
          margin: 0 0 12px;
        }
        p {
          margin: 0;
          font-size: 14px;
          line-height: 1.7;
          color: var(--studioMuted);
        }
      }
      .promptCard {
        border: 1px solid var(--studioBorder);
        box-shadow: var(--studioShadow);
        border-radius: var(--ui-radius-large);
        :deep(.el-textarea__inner) {
          padding: 0;
          box-shadow: none;
          background: transparent;
          font-size: 15px;
          line-height: 1.8;
        }
        :deep(.el-card__footer) {
          background: var(--studioSurface);
          border-top: 1px solid var(--studioBorder);
        }
        .composerFooter {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          .composerHint {
            font-size: 12px;
            color: var(--studioMuted);
          }
          .sendActions {
            display: flex;
            gap: 16px;
            align-items: center;
            margin-left: auto;
            .modelSelect {
              width: 180px;
            }
            .el-button {
              min-height: 40px;
            }
          }
        }
        .workspaceHint {
          font-size: 12px;
          color: var(--studioMuted);
        }
      }
      .creationChoices {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 20px;
        .creationChoice {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 24px;
          text-align: left;
          background: var(--studioSurface);
          border: 1px solid var(--studioBorder);
          border-radius: var(--ui-radius-large);
          color: var(--studioInk);
          cursor: pointer;
          > svg:first-child {
            color: var(--studioDone);
            flex-shrink: 0;
          }
          > svg:last-child {
            margin-left: auto;
            color: var(--studioMuted);
            flex-shrink: 0;
          }
          > span {
            display: grid;
            gap: 8px;
            strong {
              font-size: 17px;
              font-weight: 600;
            }
            span {
              font-size: 12px;
              line-height: 1.6;
              color: var(--studioMuted);
            }
          }
          &:hover {
            border-color: var(--studioDone);
            box-shadow: var(--studioShadow);
          }
          &:disabled {
            opacity: 0.55;
            cursor: wait;
          }
        }
      }
    }
    .projectList {
      .sectionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 16px;
        h2 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          span {
            margin-left: 8px;
            font-size: 13px;
            color: var(--studioMuted);
          }
        }
      }
      .projectEmpty {
        padding: 40px 16px;
        margin-top: 20px;
        border: 1px dashed var(--studioBorder);
        border-radius: var(--ui-radius-large);
        text-align: center;
        color: var(--studioMuted);
        h3 {
          font-size: 14px;
          font-weight: 500;
        }
        p {
          font-size: 12px;
        }
      }
      .projectItems {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 248px), 1fr));
        gap: 20px;
        margin-top: 20px;
        .projectCard {
          position: relative;
          background: var(--studioSurface);
          border: 1px solid var(--studioBorder);
          border-radius: var(--ui-radius-large);
          overflow: hidden;
          .projectEntry {
            display: flex;
            flex-direction: column;
            width: 100%;
            border: 0;
            background: transparent;
            color: inherit;
            font: inherit;
            text-align: left;
            padding: 0;
            cursor: pointer;
            &:disabled {
              opacity: 0.55;
              cursor: wait;
            }
            .workspacePreview {
              width: 100%;
            }
            .projectInfo {
              display: grid;
              gap: 8px;
              width: 100%;
              padding: 18px 16px 40px;
              min-width: 0;
              .projectName {
                font-size: 14px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }
              .projectProgress,
              .projectTime {
                font-size: 12px;
                color: var(--studioMuted);
              }
              .projectProgress {
                color: var(--studioDone);
              }
            }
          }
          .projectActions {
            position: absolute;
            right: 8px;
            bottom: 8px;
            display: flex;
            .el-button {
              width: 32px;
              height: 32px;
              margin: 0;
            }
          }
        }
        &.listView {
          grid-template-columns: minmax(0, 1fr);
          .projectCard .projectEntry {
            flex-direction: row;
            align-items: center;
            .workspacePreview {
              width: 144px;
              flex-shrink: 0;
            }
            .projectInfo {
              padding: 16px 88px 16px 20px;
            }
          }
        }
      }
    }
  }
  @media (max-width: 1100px) {
    grid-template-columns: 176px minmax(0, 1fr);
    .pageHeader {
      padding: 16px 24px;
      .accountEmail {
        display: none;
      }
    }
    .pageContent {
      padding: 24px;
      .creationPanel .creationChoices .creationChoice {
        padding: 20px 16px;
        gap: 12px;
      }
    }
  }
  @media (max-width: 760px) {
    grid-template-columns: minmax(0, 1fr);
    .homeRail {
      position: static;
      height: auto;
      padding: 16px 20px;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      .railBrand {
        margin: 0 auto 0 0;
      }
      nav {
        display: none;
      }
      .railFooter {
        display: flex;
        gap: 8px;
        margin: 0;
        > span {
          display: none;
        }
        .el-button {
          padding: 8px;
        }
      }
    }
    .pageHeader {
      padding: 12px 20px;
      min-height: 64px;
      > span {
        display: none;
      }
      .accountBar {
        justify-content: space-between;
        width: 100%;
      }
    }
    .pageContent {
      padding: 20px;
      .creationPanel {
        margin-top: 16px;
        .creationHeading h1 {
          font-size: 26px;
        }
        .creationChoices {
          grid-template-columns: minmax(0, 1fr);
        }
        .promptCard .composerFooter {
          .composerHint {
            display: none;
          }
          .sendActions {
            gap: 8px;
            flex-wrap: wrap;
            .modelSelect {
              width: 150px;
            }
          }
        }
      }
      .projectList .projectItems.listView .projectCard .projectEntry .workspacePreview {
        width: 80px;
      }
    }
  }
}
.briefForm {
  .briefActions {
    display: flex;
    justify-content: flex-end;
  }
}
</style>
