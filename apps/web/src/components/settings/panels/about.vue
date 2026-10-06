<template>
  <div class="about">
    <div class="brand">
      <div class="brandMark"><brandLogo class="brandLogo" /></div>
      <div class="brandInfo">
        <div class="brandMeta">
          <span>v{{ currentVersion }}</span>
        </div>
      </div>
    </div>

    <el-card class="infoCard" shadow="never">
      <p class="slogan">好戏，都在里头。</p>
      <p class="note">LITTO 是面向影视与短剧创作的 AI 工作台：把剧本、角色、场景、分镜和生成放在同一个画布里。</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import brandLogo from "@/components/brandLogo.vue";

const currentVersion = computed(() => import.meta.env.appVersion);
</script>

<style lang="scss" scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 4px 8px;

  .brand {
    display: flex;
    align-items: center;
    gap: 16px;

    .brandMark {
      display: grid;
      place-items: center;
      width: 160px;
      height: 134px;
    }

    .brandLogo {
      width: 160px;
      height: 134px;
      object-fit: contain;
    }

    .brandMeta {
      margin-top: 4px;
      color: var(--el-text-color-secondary);
      font-size: 13px;
    }
  }

  .slogan {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
  }

  .note {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.7;
  }
}
</style>
