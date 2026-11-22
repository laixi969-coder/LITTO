<template>
  <div class="privacy">
    <section v-if="share" class="settingSection" aria-labelledby="lockTitle">
      <h3 id="lockTitle">打开工作台时需要密码</h3>
      <p class="description">{{ share.passwordRequired ? "已开启。每次重新打开应用都要输入密码。" : "当前可以直接打开本机工作台。" }}</p>
      <el-button v-if="!editing" @click="editing = true">{{ share.passwordRequired ? "关闭密码保护" : "设置打开密码" }}</el-button>
      <form v-else class="lockForm" @submit.prevent="saveLock">
        <label for="workbenchPassword">{{ share.passwordRequired ? "当前密码" : "新密码（12 至 256 个字符）" }}</label>
        <el-input id="workbenchPassword" v-model="password" type="password" showPassword :autocomplete="share.passwordRequired ? 'current-password' : 'new-password'" :minlength="share.passwordRequired ? 1 : 12" :maxlength="256" required :disabled="saving" />
        <template v-if="!share.passwordRequired">
          <label for="repeatWorkbenchPassword">再次输入新密码</label>
          <el-input id="repeatWorkbenchPassword" v-model="confirmation" type="password" showPassword autocomplete="new-password" :maxlength="256" required :disabled="saving" />
        </template>
        <p v-if="errorMessage" class="lockError" role="alert">{{ errorMessage }}</p>
        <div>
          <el-button type="primary" nativeType="submit" :loading="saving">{{ share.passwordRequired ? "确认关闭" : "保存密码" }}</el-button>
          <el-button :disabled="saving" @click="closeForm">取消</el-button>
        </div>
      </form>
    </section>
    <section class="settingSection" aria-labelledby="collectionTitle">
      <h3 id="collectionTitle">数据与隐私</h3>
      <p class="description">MILI MILI 不收集匿名使用统计，也不会向第三方上报你的提示词、对话、文件内容、项目名称、路径、账号或密钥。</p>
      <p class="description">生成内容时，素材与提示词只会发送到你自己配置的模型服务。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { cloudRequest, getMe } from "@/lib/session";

const share = ref(getMe()?.desktopShare);
const editing = ref(false);
const saving = ref(false);
const password = ref("");
const confirmation = ref("");
const errorMessage = ref("");

function closeForm() {
  editing.value = false;
  password.value = confirmation.value = errorMessage.value = "";
}

async function saveLock() {
  if (!share.value || saving.value) return;
  const enabled = !share.value.passwordRequired;
  if (enabled && password.value !== confirmation.value) {
    errorMessage.value = "两次输入的密码不一致。";
    return;
  }
  saving.value = true;
  try {
    share.value = await cloudRequest<{ passwordRequired: boolean }>("/auth/desktop-lock", "PUT", { enabled, password: password.value });
    const me = getMe();
    if (me) me.desktopShare = share.value;
    closeForm();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "密码保护设置失败";
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.privacy {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px 8px;

  .settingSection {
    min-width: 0;

    .lockForm {
      display: grid;
      gap: 8px;
      max-width: 360px;
      font-size: 13px;

      .lockError { margin: 0; color: var(--el-color-danger); }
    }

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
