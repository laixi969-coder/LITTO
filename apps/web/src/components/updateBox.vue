<template>
  <el-dialog
    v-model="visible"
    class="updateBox"
    width="min(620px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    destroyOnClose
    :showClose="false"
    :closeOnClickModal="false"
    @opened="emit('opened')"
    @close="emit('close')">
    <template #header="{ titleId, close }">
      <div class="updateHeader">
        <div class="versionInfo">
          <h2 :id="titleId" class="updateTitle">MILI MILI <span class="versionNumber">v{{ version }}</span></h2>

        </div>
        <button class="closeButton" type="button" aria-label="关闭更新说明" @click="close">
          <icon-x :size="20" aria-hidden="true" />
        </button>
      </div>
    </template>

    <div class="updateBody">
      <section class="releaseSection" aria-label="更新内容">
        <h3 class="releaseTitle">更新内容</h3>
        <div class="releaseContent" tabindex="0" role="region" aria-label="Markdown 更新说明">
          <messageMarkdown v-if="markdown.trim()" :content="markdown" />
        </div>
      </section>
    </div>

    <template #footer>
      <el-button class="confirmButton" type="primary" @click="visible = false">开始使用<icon-arrow-right :size="16" aria-hidden="true" /></el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import updateNotes from "./updateBox.md?raw";

const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ opened: []; close: [] }>();
const { version, markdown = updateNotes } = defineProps<{ version: string; buildCode: string; markdown?: string }>();
const messageMarkdown = defineAsyncComponent(() => import("./messageMarkdown.vue"));

</script>

<style lang="scss">
.el-dialog.updateBox {
  --el-dialog-padding-primary: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--ui-radius-large);
  background: var(--el-bg-color-overlay);
  box-shadow: 0 24px 80px #0003;

  .el-dialog__header {
    margin: 0;
    padding: 24px 26px 22px;

    .updateHeader {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;

      .versionInfo {
        min-width: 0;

        .updateTitle {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 10px;
          margin: 0;
          color: var(--el-text-color-primary);
          font-size: 20px;
          line-height: 1.4;
          font-weight: 600;
          letter-spacing: -0.4px;

          .versionNumber { color: var(--el-text-color-regular); font-weight: 400; overflow-wrap: anywhere; }
        }


      }

      .closeButton {
        display: grid;
        place-items: center;
        flex-shrink: 0;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 0;
        border-radius: var(--ui-radius-small);
        color: var(--el-text-color-secondary);
        background: transparent;
        cursor: pointer;

        &:hover { color: var(--el-text-color-primary); background: var(--el-fill-color); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
      }
    }
  }

  .el-dialog__body {
    padding: 0;

    .updateBody {


      .releaseSection {
        .releaseTitle {
          margin: 0;
          padding: 26px 26px 12px;
          color: var(--el-text-color-primary);
          font-size: 14px;
          font-weight: 600;
        }

        .releaseContent {
          min-height: 130px;
          max-height: 32vh;
          overflow: auto;
          overscroll-behavior: contain;
          padding: 0 26px 16px;
          color: var(--el-text-color-regular);
          font-size: 13px;
          line-height: 1.8;

          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }

          .messageMarkdown {
            h1, h2, h3, h4 { font-size: 14px; line-height: 1.7; }
            p, ul, ol { margin-top: 8px; margin-bottom: 8px; }
            ul, ol {
              li {
                padding: 3px 0 3px 2px;

                p { margin: 0; }
              }
            }
            a { overflow-wrap: anywhere; }
            img { max-width: 100%; }
          }
        }
      }
    }
  }

  .el-dialog__footer {
    padding: 18px 26px 24px;

    .confirmButton {
      height: 36px;
      padding: 0 18px;
      font-weight: 500;

      svg { margin-left: 12px; }
    }
  }

  @media (max-width: 480px) {
    .el-dialog__header { padding: 20px 20px 18px; }
    .el-dialog__body .updateBody {

      .releaseSection {
        .releaseTitle { padding: 20px 20px 10px; }
        .releaseContent { padding: 0 20px 12px; }
      }
    }
    .el-dialog__footer { padding: 16px 20px 20px; }
  }
}
</style>
