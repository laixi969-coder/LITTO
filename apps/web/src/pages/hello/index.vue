<template>
  <main class="hello">
    <bg class="pageBackground" />
    <div class="welcome">
      <img class="logo" :src="logoUrl" alt="LITTO" />
      <h1>LITTO <small>里头</small></h1>
      <p class="slogan">好戏，都在里头</p>
      <p class="description">把剧本、角色、场景、分镜和生成，放进同一个画布。</p>
      <el-button type="primary" size="large" round :loading="saving" @click="enter">进入 LITTO</el-button>
    </div>
    <footer class="footer">
      <languageSelect />
    </footer>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import logoUrl from "@toonflow/assets/logo.svg";
import { useHelloStore } from "@/stores/hello";
import bg from "./bg.vue";
import languageSelect from "@/components/languageSelect.vue";

const router = useRouter();
const hello = useHelloStore();
const saving = ref(false);

async function enter() {
  if (saving.value) return;
  saving.value = true;
  try {
    await hello.complete();
    await router.replace("/home");
  } catch {
    ElMessage.error("保存引导状态失败，请重试");
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.hello {
  position: relative;
  display: grid;
  min-height: 100vh;
  place-items: center;
  overflow: hidden;

  .pageBackground {
    position: absolute;
    inset: 0;
  }

  .welcome {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px;
    text-align: center;

    .logo {
      width: 96px;
      height: 96px;
      object-fit: contain;
    }

    h1 {
      margin: 0;
      font-size: 40px;
      letter-spacing: 2px;

      small {
        font-size: 20px;
        font-weight: 400;
        letter-spacing: 6px;
        color: var(--el-text-color-secondary);
      }
    }

    .slogan {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: var(--el-color-primary);
    }

    .description {
      margin: 0 0 12px;
      color: var(--el-text-color-secondary);
    }
  }

  .footer {
    position: absolute;
    right: 24px;
    bottom: 20px;
  }
}
</style>
