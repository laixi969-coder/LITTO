<template>
  <div class="about">
    <div class="brand">
      <div class="brandMark"><img class="brandLogo" :src="logoUrl" alt="LITTO Logo" /></div>
      <div class="brandInfo">
        <h3>LITTO 里头</h3>
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
import logoUrl from "@toonflow/assets/logo.svg";

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
      width: 72px;
      height: 72px;
      border-radius: 16px;
      background: var(--el-fill-color-light);
    }

    .brandLogo {
      width: 52px;
      height: 52px;
      object-fit: contain;
    }

    h3 {
      margin: 0;
      font-size: 20px;
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
