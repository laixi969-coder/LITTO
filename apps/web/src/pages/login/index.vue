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
      <h2>{{ sent ? "查看你的邮箱" : "开始你的下一部作品" }}</h2>
      <p class="slogan">{{ sent ? "填入验证码，回到创作工作台。" : "用邮箱登录，灵感和作品都留在这里。" }}</p>
      <el-form class="form" @submit.prevent="submit">
        <label for="loginEmail">邮箱</label>
        <el-input
          id="loginEmail"
          v-model="email"
          type="email"
          size="large"
          placeholder="填写你的邮箱地址"
          autocomplete="email"
          :disabled="sent || busy"
          aria-label="邮箱" />
        <template v-if="loginMethod === 'password'">
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
        </template>
        <template v-else-if="sent">
          <label for="loginCode">验证码</label>
          <el-input
            id="loginCode"
            v-model="code"
            size="large"
            placeholder="6 位验证码"
            maxlength="6"
            inputmode="numeric"
            autocomplete="one-time-code"
            :disabled="busy"
            aria-label="验证码"
            autofocus />
        </template>
        <el-button v-if="loginMethod === 'password'" type="primary" size="large" nativeType="submit" :loading="busy" :disabled="!email.includes('@') || !password">登录</el-button>
        <el-button v-else-if="!sent" type="primary" size="large" nativeType="submit" :loading="busy" :disabled="!email.includes('@')">获取验证码</el-button>
        <template v-else>
          <el-button type="primary" size="large" nativeType="submit" :loading="busy" :disabled="code.length < 6">登录</el-button>
          <div class="codeActions">
            <el-button link :disabled="busy || cooldown > 0" @click="send">{{ cooldown > 0 ? `${cooldown} 秒后可重新发送` : "重新发送验证码" }}</el-button>
            <el-button
              link
              :disabled="busy"
              @click="
                sent = false;
                code = '';
              ">
              换个邮箱
            </el-button>
          </div>
        </template>
        <el-button link :disabled="busy" @click="switchLoginMethod">{{ loginMethod === "password" ? "使用验证码登录" : "使用密码登录" }}</el-button>
      </el-form>
      <p class="hint">{{ loginMethod === "password" ? "已设置密码的账号使用密码登录。" : "未设置密码的账号可使用验证码登录，首次使用会自动创建个人工作区。" }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { ElMessage } from "element-plus";
import { requestCode, verifyCode, verifyPassword } from "@/lib/session";
import brandLogo from "@/components/brandLogo.vue";

const email = ref("");
const loginMethod = ref<"password" | "code">("password");
const password = ref("");
const code = ref("");
const sent = ref(false);
const busy = ref(false);
// 与服务端同一邮箱的发送间隔一致，避免反复点击后才看到限流报错。
const cooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | undefined;
onBeforeUnmount(() => clearInterval(cooldownTimer));

function switchLoginMethod() {
  loginMethod.value = loginMethod.value === "password" ? "code" : "password";
  sent.value = false;
  code.value = "";
  password.value = "";
}

function startCooldown() {
  cooldown.value = 60;
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    if (--cooldown.value <= 0) clearInterval(cooldownTimer);
  }, 1000);
}

async function send() {
  if (busy.value || cooldown.value > 0 || !email.value.includes("@")) return;
  busy.value = true;
  try {
    const result = await requestCode(email.value.trim());
    sent.value = true;
    startCooldown();
    // Outside production there is no mail transport: the server echoes the code so local trials work.
    if (result.devCode) {
      code.value = result.devCode;
      ElMessage.info(`开发模式验证码：${result.devCode}`);
    } else ElMessage.success("验证码已发送，请查收邮件");
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
  busy.value = false;
}
async function submit() {
  if (loginMethod.value === "code" && !sent.value) return send();
  if (busy.value || !email.value.includes("@")) return;
  if (loginMethod.value === "code" ? code.value.trim().length !== 6 : !password.value) return;
  busy.value = true;
  try {
    if (loginMethod.value === "password") await verifyPassword(email.value.trim(), password.value);
    else await verifyCode(email.value.trim(), code.value.trim());
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
      .codeActions {
        display: flex;
        justify-content: space-between;
        .el-button {
          margin: 0;
        }
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
