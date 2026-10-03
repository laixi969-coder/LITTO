<template>
  <div class="privacy">
    <section class="settingSection" aria-labelledby="collectionTitle">
      <h3 id="collectionTitle">数据与隐私</h3>
      <p class="description">LITTO 不收集匿名使用统计，也不会向第三方上报你的提示词、对话、文件内容、项目名称、路径、账号或密钥。</p>
      <p class="description">生成内容时，素材与提示词只会发送到你自己配置的模型服务。</p>
    </section>
  </div>
</template>

<script setup lang="ts"></script>

<style lang="scss" scoped>
.privacy {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px 8px;

  .settingSection {
    min-width: 0;

    h3 {
      margin: 0 0 12px;
      color: var(--el-text-color-primary);
      font-size: 14px;
      font-weight: 600;
    }

    .settingHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;

      h3 { margin: 0; }
    }

    .description {
      margin: 8px 0 0;
      color: var(--el-text-color-secondary);
      font-size: 13px;
      line-height: 1.6;
    }

    .metricList {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin: 0;

      .metricItem {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        gap: 12px;
        font-size: 13px;
        line-height: 1.6;

        dt { color: var(--el-text-color-regular); }
        dd { margin: 0; color: var(--el-text-color-secondary); }
      }
    }

    .anonymousId {
      display: block;
      padding: 10px 12px;
      border-radius: var(--el-border-radius-base);
      background: var(--el-fill-color-light);
      color: var(--el-text-color-regular);
      overflow-wrap: anywhere;
      user-select: text;
      font-family: monospace;
      font-size: 12px;
    }
  }
}
</style>
