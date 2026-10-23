<template>
  <main class="login">
    <aside class="brandPanel">
      <div class="brandMark">
        <brandLogo class="logo" theme="dark" />
      </div>
      <div class="brandStatement">
        <p>好戏，都在里头。</p>
        <h1>
          把一个想法，
          <br />
          拍成一部片。
        </h1>
        <p class="brandDescription">
          剧本、角色、分镜与画面，
          <br />
          在同一张画布上慢慢成形。
        </p>
      </div>
      <span class="brandFooter">你的创作工作台</span>
    </aside>
    <section class="card" aria-label="登录">
      <h2>开始你的下一部作品</h2>
      <p class="slogan">用邮箱登录，灵感和作品都留在这里。</p>
      <el-form class="form" @submit.prevent="submit">
        <label for="loginEmail">邮箱</label>
        <el-input
          id="loginEmail"
          v-model="email"
          type="email"
          size="large"
          placeholder="填写你的邮箱地址"
          autocomplete="email"
          :disabled="busy"
          aria-label="邮箱" />
        <label for="loginPassword">密码</label>
        <el-input
          id="loginPassword"
          v-model="password"
          type="password"
          showPassword
          size="large"
          autocomplete="current-password"
          maxlength="256"
          :disabled="busy"
          aria-label="密码" />
        <el-button type="primary" size="large" nativeType="submit" :loading="busy" :disabled="!email.includes('@') || !password">登录</el-button>
      </el-form>
      <p class="hint">使用已设置的密码登录。验证码登录暂不可用，未设置密码请联系管理员。</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { verifyPassword } from "@/lib/session";
import brandLogo from "@/components/brandLogo.vue";

const email = ref("");
const password = ref("");
const busy = ref(false);
async function submit() {
  if (busy.value || !email.value.includes("@") || !password.value) return;
  busy.value = true;
  try {
    await verifyPassword(email.value.trim(), password.value);
    location.hash = "#/home";
    location.reload(); // reload so settings and workspaces load under the new session
  } catch (error) {
    ElMessage.error((error as Error).message);
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.login {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  background: var(--studioPage);
  .brandPanel {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: clamp(32px, 5vw, 72px);
    min-height: 100dvh;
    background: var(--studioRail);
    color: var(--studioRailInk);
    .brandMark {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 24px;
      font-weight: 650;
      letter-spacing: -0.04em;
      .logo {
        width: 180px;
        height: 150px;
      }
    }
    .brandStatement {
      margin: 72px 0;
      p {
        font-size: 15px;
        color: var(--studioRailMuted);
        line-height: 1.8;
      }
      h1 {
        font-size: clamp(32px, 4vw, 56px);
        font-weight: 550;
        letter-spacing: -0.04em;
        line-height: 1.3;
        margin: 20px 0 28px;
      }
    }
    .brandFooter {
      color: var(--studioRailMuted);
      font-size: 12px;
    }
  }
  .card {
    align-self: center;
    justify-self: center;
    width: min(420px, calc(100% - 48px));
    padding: 40px 0;
    h2 {
      margin: 0;
      font-size: 26px;
      letter-spacing: -0.03em;
      font-weight: 600;
    }
    .slogan {
      margin: 12px 0 36px;
      font-size: 14px;
      line-height: 1.8;
      color: var(--studioMuted);
    }
    .form {
      display: grid;
      gap: 12px;
      label {
        font-size: 13px;
        margin-top: 4px;
      }
      .el-button {
        margin: 12px 0 0;
        min-height: 44px;
      }
    }
    .hint {
      margin-top: 28px;
      font-size: 12px;
      line-height: 1.8;
      color: var(--studioMuted);
    }
  }
  @media (max-width: 720px) {
    grid-template-columns: minmax(0, 1fr);
    .brandPanel {
      min-height: 0;
      padding: 24px;
      .brandStatement {
        margin: 28px 0 0;
        h1 {
          font-size: 30px;
          margin: 12px 0;
        }
        .brandDescription {
          display: none;
        }
      }
      .brandFooter {
        display: none;
      }
    }
    .card {
      padding: 32px 0;
      h2 {
        font-size: 22px;
      }
    }
  }
}
</style>
