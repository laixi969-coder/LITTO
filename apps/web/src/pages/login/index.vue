<template>
  <main class="login">
    <section class="card" aria-label="登录">
      <el-image class="logo" :src="logoUrl" fit="contain" alt="LITTO" />
      <h1>LITTO <small>里头</small></h1>
      <p class="slogan">好戏，都在里头</p>
      <el-form class="form" @submit.prevent="submit">
        <el-input v-model="email" size="large" placeholder="邮箱" :disabled="sent" aria-label="邮箱" @keyup.enter="sent ? undefined : send()" />
        <el-input v-if="sent" v-model="code" size="large" placeholder="6 位验证码" maxlength="6" aria-label="验证码" autofocus @keyup.enter="submit" />
        <el-button v-if="!sent" type="primary" size="large" :loading="busy" :disabled="!email.includes('@')" @click="send">获取验证码</el-button>
        <template v-else>
          <el-button type="primary" size="large" :loading="busy" :disabled="code.length < 6" @click="submit">登录</el-button>
          <el-button size="large" link @click="sent = false; code = ''">换个邮箱</el-button>
        </template>
      </el-form>
      <p class="hint">输入邮箱即可登录，首次使用会自动创建你的个人工作区。</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { requestCode, verifyCode } from "@/lib/session";
import logoUrl from "@toonflow/assets/logo.svg";

const email = ref("");
const code = ref("");
const sent = ref(false);
const busy = ref(false);

async function send() {
  busy.value = true;
  try {
    const result = await requestCode(email.value.trim());
    sent.value = true;
    // Outside production there is no mail transport: the server echoes the code so local trials work.
    if (result.devCode) { code.value = result.devCode; ElMessage.info(`开发模式验证码：${result.devCode}`); }
    else ElMessage.success("验证码已发送，请查收邮件");
  } catch (error) { ElMessage.error((error as Error).message); }
  busy.value = false;
}
async function submit() {
  busy.value = true;
  try {
    await verifyCode(email.value.trim(), code.value.trim());
    location.hash = "#/home";
    location.reload(); // reload so settings and workspaces load under the new session
  } catch (error) { ElMessage.error((error as Error).message); busy.value = false; }
}
</script>

<style scoped lang="scss">
.login { min-height: 100vh; display: grid; place-items: center; background: linear-gradient(160deg, #eaf3ff, #f7f9ff 60%, #eef0ff); }
.card { width: 380px; padding: 40px 36px; border-radius: 20px; background: rgba(255, 255, 255, 0.85); box-shadow: 0 20px 60px rgba(60, 90, 160, 0.15); text-align: center; }
.logo { width: 56px; height: 56px; }
h1 { margin: 8px 0 0; font-size: 30px; small { font-size: 16px; font-weight: 400; opacity: 0.6; margin-left: 6px; } }
.slogan { margin: 6px 0 24px; letter-spacing: 0.3em; opacity: 0.65; }
.form { display: grid; gap: 12px; }
.hint { margin-top: 18px; font-size: 12px; opacity: 0.55; }
</style>
