<template>
  <main class="adminPage">
    <header class="pageHeader">
      <div><h1>管理后台</h1><p>{{ getMe()?.user.email }}</p></div>
      <el-button @click="router.push('/home')">返回工作台</el-button>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
    <el-button v-if="error" class="retryButton" :loading="loading" @click="load">重新读取</el-button>
    <el-tabs v-if="system" v-model="activeTab" class="adminTabs">
      <el-tab-pane label="账户白名单" name="whitelist">
        <el-form class="settingsForm" labelPosition="top" :disabled="loading || !!saving" @submit.prevent="saveWhitelist">
          <el-form-item label="启用账户白名单"><el-switch v-model="system.accountWhitelist.enabled" aria-label="启用账户白名单" /></el-form-item>
          <p class="description">启用后，仅名单内邮箱可以注册和登录；移出名单的账号立即失去访问权限。超级管理员始终可登录。</p>
          <el-form-item label="允许登录的邮箱（每行一个）">
            <el-input v-model="whitelistText" type="textarea" :rows="8" aria-label="允许登录的邮箱" />
          </el-form-item>
          <el-form-item label="允许新用户注册"><el-switch v-model="system.registrationOpen" aria-label="允许新用户注册" /></el-form-item>
          <p class="description">关闭新用户注册后，白名单内尚未注册的邮箱也无法创建账号。</p>
          <el-button type="primary" nativeType="submit" :loading="saving === 'whitelist'">保存白名单</el-button>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="账户积分" name="credits">
        <el-form class="searchForm" inline @submit.prevent="loadUsers">
          <el-form-item label="邮箱"><el-input v-model="search" clearable aria-label="搜索账户邮箱" /></el-form-item>
          <el-button nativeType="submit" :loading="usersLoading">搜索</el-button>
        </el-form>
        <el-table :data="users" rowKey="id" v-loading="usersLoading">
          <el-table-column prop="email" label="邮箱" minWidth="220" />
          <el-table-column label="身份" width="120"><template #default="scope">{{ scope.row.is_admin ? "超级管理员" : "普通用户" }}</template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="scope">{{ scope.row.status === 'active' ? "正常" : "已停用" }}</template></el-table-column>
          <el-table-column prop="balance" label="总积分" width="110" />
          <el-table-column prop="held" label="冻结积分" width="110" />
          <el-table-column label="可用积分" width="110"><template #default="scope">{{ scope.row.balance - scope.row.held }}</template></el-table-column>
          <el-table-column label="操作" width="120"><template #default="scope"><el-button link type="primary" :disabled="!scope.row.workspace_id || !!saving" @click="openAdjustment(scope.row as Account)">调整积分</el-button></template></el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="价格与计费" name="pricing">
        <section class="pricingSection">
          <h2>积分计费</h2>
          <el-form class="settingsForm" labelPosition="top" :disabled="loading || !!saving" @submit.prevent="saveBilling">
            <el-form-item label="启用平台积分计费"><el-switch v-model="system.billingEnabled" aria-label="启用平台积分计费" /></el-form-item>
            <el-form-item label="每美元对应积分"><el-input-number v-model="system.creditsPerUsd" :min="0.000001" :max="1e9" :step="0.000001" :precision="6" :controls="false" aria-label="每美元对应积分" /></el-form-item>
            <el-form-item label="平台加价系数"><el-input-number v-model="system.markup" :min="0" :max="1e6" :step="0.000001" :precision="6" :controls="false" aria-label="平台加价系数" /></el-form-item>
            <el-form-item label="新用户赠送积分"><el-input-number v-model="system.defaultCredits" :min="0" :max="1e9" :step="0.01" :precision="2" aria-label="新用户赠送积分" /></el-form-item>
            <el-form-item label="启用平台文本试用"><el-switch v-model="system.platformTrial.enabled" aria-label="启用平台文本试用" /></el-form-item>
            <el-form-item label="文本试用每 1000 token 扣除积分"><el-input-number v-model="system.platformTrial.creditsPer1kTokens" :min="0.000001" :max="1e9" :step="0.000001" :precision="6" :controls="false" aria-label="文本试用积分单价" /></el-form-item>
            <p class="description">平台生成按供应商费用 × 每美元积分 × 加价系数计费；文本试用使用独立的 token 积分单价。</p>
            <el-button type="primary" nativeType="submit" :loading="saving === 'billing'">保存计费设置</el-button>
          </el-form>
        </section>
        <section class="pricingSection">
          <h2>平台模型成本单价（USD）</h2>
          <p class="description">用于预估生成成本与冻结积分；最终扣费按供应商回执结算。留空表示未配置。</p>
          <el-table :data="models" rowKey="id">
            <el-table-column prop="name" label="模型" minWidth="220" />
            <el-table-column prop="providerId" label="供应商" minWidth="140" />
            <el-table-column v-for="rate in rates" :key="rate.key" :label="rate.label" minWidth="180"><template #default="scope"><el-input-number v-model="scope.row.price[rate.key]" :min="0" :precision="6" :controls="false" :disabled="!!saving" :aria-label="`${scope.row.name} ${rate.label}`" /></template></el-table-column>
            <el-table-column label="操作" width="90"><template #default="scope"><el-button link type="primary" :loading="saving === scope.row.id" :disabled="!!saving && saving !== scope.row.id" @click="saveModel(scope.row as Model)">保存</el-button></template></el-table-column>
          </el-table>
        </section>
        <section class="pricingSection">
          <h2>自有模型用量单价（USD）</h2>
          <p class="description">用于统计自有模型费用，供应商和模型 ID 需与用量记录一致；实际账单以模型服务商为准。</p>
          <el-table :data="usagePrices">
            <el-table-column label="供应商 ID" minWidth="180"><template #default="scope"><el-input v-model="scope.row.providerId" :disabled="!!saving" aria-label="用量供应商 ID" /></template></el-table-column>
            <el-table-column label="模型 ID" minWidth="200"><template #default="scope"><el-input v-model="scope.row.modelId" :disabled="!!saving" aria-label="用量模型 ID" /></template></el-table-column>
            <el-table-column v-for="rate in rates" :key="rate.key" :label="rate.label" minWidth="180"><template #default="scope"><el-input-number v-model="scope.row.price[rate.key]" :min="0" :precision="6" :controls="false" :disabled="!!saving" :aria-label="`用量 ${rate.label}`" /></template></el-table-column>
            <el-table-column label="操作" width="90"><template #default="scope"><el-button link :disabled="!!saving" @click="usagePrices.splice(scope.$index, 1)">移除</el-button></template></el-table-column>
          </el-table>
          <div class="sectionActions"><el-button :disabled="!!saving" @click="usagePrices.push({ providerId: '', modelId: '', price: {} })">添加单价</el-button><el-button type="primary" :loading="saving === 'usage'" :disabled="!!saving && saving !== 'usage'" @click="saveUsagePrices">保存用量单价</el-button></div>
        </section>
        <section v-if="catalogue" class="pricingSection">
          <h2>订阅套餐价格（USD）</h2>
          <el-table :data="catalogue.plans" rowKey="id">
            <el-table-column prop="name" label="套餐" minWidth="200" />
            <el-table-column prop="period" label="周期" width="120" />
            <el-table-column label="价格 USD" minWidth="180"><template #default="scope"><el-input-number v-model="scope.row.priceUsd" :min="0" :precision="2" :disabled="!!saving || scope.row.id === 'free'" :aria-label="`${scope.row.name} 价格`" /></template></el-table-column>
            <el-table-column label="套餐积分" minWidth="180"><template #default="scope"><el-input-number v-model="scope.row.credits" :min="0" :max="1e9" :disabled="!!saving" :aria-label="`${scope.row.name} 积分`" /></template></el-table-column>
          </el-table>
          <h2>积分包价格（USD）</h2>
          <el-table :data="catalogue.packs" rowKey="id">
            <el-table-column prop="name" label="积分包" minWidth="200" />
            <el-table-column label="价格 USD" minWidth="180"><template #default="scope"><el-input-number v-model="scope.row.priceUsd" :min="0" :precision="2" :disabled="!!saving" :aria-label="`${scope.row.name} 价格`" /></template></el-table-column>
            <el-table-column label="积分" minWidth="180"><template #default="scope"><el-input-number v-model="scope.row.credits" :min="0" :max="1e9" :disabled="!!saving" :aria-label="`${scope.row.name} 积分`" /></template></el-table-column>
          </el-table>
          <div class="sectionActions"><el-button type="primary" :loading="saving === 'catalogue'" :disabled="!!saving && saving !== 'catalogue'" @click="saveCatalogue">保存套餐与积分包</el-button></div>
        </section>
      </el-tab-pane>
    </el-tabs>
    <p v-else-if="loading" role="status">正在读取管理设置…</p>
    <el-dialog v-model="adjustmentVisible" title="调整账户积分" width="min(480px, calc(100vw - 32px))" :closeOnClickModal="!saving" :showClose="!saving" alignCenter>
      <el-form v-if="selectedUser" labelPosition="top" :disabled="!!saving" @submit.prevent="saveAdjustment">
        <p>{{ selectedUser.email }}</p><p class="description">可用 {{ selectedUser.balance - selectedUser.held }} 积分，冻结 {{ selectedUser.held }} 积分。</p>
        <el-form-item label="调整数量（正数增加，负数扣减）"><el-input-number v-model="adjustment.amount" :min="-1e9" :max="1e9" :step="0.01" :precision="2" aria-label="调整积分数量" /></el-form-item>
        <el-form-item label="调整原因（至少 3 个字符）"><el-input v-model="adjustment.note" type="textarea" :rows="3" maxlength="500" aria-label="积分调整原因" /></el-form-item>
        <el-button type="primary" nativeType="submit" :loading="saving === 'credits'" :disabled="!adjustment.amount || adjustment.note.trim().length < 3">保存积分调整</el-button>
      </el-form>
    </el-dialog>
  </main>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { cloudRequest, getMe } from "@/lib/session";

type Price = { perImage?: number; perSecond?: number; perCall?: number };
type SystemSettings = { accountWhitelist: { enabled: boolean; emails: string[] }; registrationOpen: boolean; defaultCredits: number; billingEnabled: boolean; creditsPerUsd: number; markup: number; platformTrial: { enabled: boolean; creditsPer1kTokens: number }; pricing: Record<string, Price> };
type Account = { id: string; email: string; status: string; is_admin: number; workspace_id: string | null; balance: number; held: number };
type Model = { id: string; name: string; providerId: string; price: Price; limits: { workspaceExecution?: boolean } };
type Pack = { id: string; name: string; priceUsd: number; credits: number };
type Plan = Pack & { period: string; storageGb: number };
type Catalogue = { plans: Plan[]; packs: Pack[] };
const router = useRouter();
const activeTab = ref("whitelist");
const system = ref<SystemSettings>();
const catalogue = ref<Catalogue>();
const users = ref<Account[]>([]);
const models = ref<Model[]>([]);
const usagePrices = ref<{ providerId: string; modelId: string; price: Price }[]>([]);
const whitelistText = ref("");
const search = ref("");
const loading = ref(false);
const usersLoading = ref(false);
const saving = ref("");
const error = ref("");
const selectedUser = ref<Account>();
const adjustmentVisible = ref(false);
const adjustment = reactive<{ amount: number | undefined; note: string }>({ amount: 0, note: "" });
const rates = [{ key: "perImage", label: "每张图片" }, { key: "perSecond", label: "每秒视频" }, { key: "perCall", label: "每次调用" }] as const;

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const [settings, accounts, modelList, prices] = await Promise.all([
      cloudRequest<SystemSettings>("/admin/system"), cloudRequest<Account[]>("/admin/users"),
      cloudRequest<Model[]>("/admin/models"), cloudRequest<Catalogue>("/admin/plans"),
    ]);
    system.value = settings;
    users.value = accounts;
    models.value = modelList.filter(model => !model.limits.workspaceExecution);
    catalogue.value = prices;
    whitelistText.value = settings.accountWhitelist.emails.join("\n");
    usagePrices.value = Object.entries(settings.pricing).map(([key, price]) => {
      const splitAt = key.indexOf("/");
      return { providerId: key.slice(0, splitAt), modelId: key.slice(splitAt + 1), price };
    });
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally { loading.value = false; }
}
async function loadUsers() {
  if (usersLoading.value) return;
  usersLoading.value = true;
  try { users.value = await cloudRequest<Account[]>(`/admin/users?q=${encodeURIComponent(search.value.trim())}`); }
  catch (failure) { ElMessage.error((failure as Error).message); }
  finally { usersLoading.value = false; }
}
async function save(key: string, action: () => Promise<void>) {
  if (saving.value) return;
  saving.value = key;
  try { await action(); ElMessage.success("已保存"); }
  catch (failure) { ElMessage.error((failure as Error).message); }
  finally { saving.value = ""; }
}
function saveWhitelist() {
  return save("whitelist", async () => {
    const emails = [...new Set(whitelistText.value.split(/\r?\n/).map(email => email.trim().toLowerCase()).filter(Boolean))];
    await cloudRequest("/admin/system", "PUT", { accountWhitelist: { enabled: system.value!.accountWhitelist.enabled, emails }, registrationOpen: system.value!.registrationOpen });
    whitelistText.value = emails.join("\n");
  });
}
function openAdjustment(user: Account) {
  selectedUser.value = user;
  adjustment.amount = 0;
  adjustment.note = "";
  adjustmentVisible.value = true;
}
function saveAdjustment() {
  return save("credits", async () => {
    await cloudRequest("/admin/credits/adjust", "POST", { workspaceId: selectedUser.value!.workspace_id, amount: adjustment.amount, note: adjustment.note.trim() });
    adjustmentVisible.value = false;
    await loadUsers();
  });
}
function saveBilling() {
  return save("billing", async () => {
    const { billingEnabled, creditsPerUsd, markup, defaultCredits, platformTrial } = system.value!;
    await cloudRequest("/admin/system", "PUT", { billingEnabled, creditsPerUsd, markup, defaultCredits, platformTrial });
  });
}
function saveModel(model: Model) {
  return save(model.id, async () => {
    const saved = await cloudRequest<Model>(`/admin/models/${encodeURIComponent(model.id)}`, "PATCH", { price: model.price });
    model.price = saved.price;
  });
}
function saveUsagePrices() {
  return save("usage", async () => {
    const entries = usagePrices.value.map(row => {
      if (!row.providerId.trim() || !row.modelId.trim()) throw new Error("请填写供应商和模型 ID");
      return [`${row.providerId.trim()}/${row.modelId.trim()}`, row.price] as const;
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("同一供应商和模型不能重复设置单价");
    await cloudRequest("/admin/system", "PUT", { pricing: Object.fromEntries(entries) });
  });
}
function saveCatalogue() {
  return save("catalogue", async () => { catalogue.value = await cloudRequest<Catalogue>("/admin/plans", "PUT", catalogue.value); });
}
onMounted(load);
</script>

<style scoped lang="scss">
.adminPage {
  max-width: 1320px;
  margin: 0 auto;
  padding: 32px 24px 64px;
  color: var(--studioInk);
  .pageHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 28px;
    h1 { margin: 0; font-size: 26px; font-weight: 600; }
    p { margin: 8px 0 0; color: var(--studioMuted); font-size: 13px; }
  }
  .retryButton { margin-top: 12px; }
  .adminTabs {
    .settingsForm { max-width: 580px; }
    .searchForm { margin-top: 16px; }
    .pricingSection {
      padding: 20px 0 28px;
      border-bottom: 1px solid var(--studioBorder);
      h2 { margin: 0 0 16px; font-size: 17px; font-weight: 600; }
      > h2:not(:first-child) { margin-top: 28px; }
      .sectionActions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
    }
  }
  .description { margin: 0 0 20px; color: var(--studioMuted); font-size: 13px; line-height: 1.7; }
  @media (max-width: 700px) { padding: 24px 16px; .pageHeader h1 { font-size: 22px; } }
}
</style>
