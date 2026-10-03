<template>
  <el-popover trigger="click" :width="300" :showArrow="false">
    <template #reference>
      <button class="usageSummary" type="button" aria-label="查看本月用量" @click="load">
        <span>本月用量</span>
        <strong v-if="data">图 {{ images }} 张 · 视频 {{ seconds }} 秒</strong>
        <strong v-else>{{ error ? "读取失败" : "读取中…" }}</strong>
      </button>
    </template>
    <section class="usageDetails" aria-label="本月用量明细">
      <h3>本月用量</h3>
      <p class="usageHint">按 UTC 自然月统计，费用以美元计。</p>
      <p v-if="error" role="alert">
        {{ error }}
        <el-button text @click="load">重新读取</el-button>
      </p>
      <template v-else-if="data">
        <dl>
          <div>
            <dt>图片</dt>
            <dd>{{ images }} 张</dd>
          </div>
          <div>
            <dt>视频</dt>
            <dd>{{ seconds }} 秒</dd>
          </div>
          <div>
            <dt>文本</dt>
            <dd>{{ tokens }} token</dd>
          </div>
        </dl>
        <p v-if="data.totalCostUsd !== null">
          {{ unpriced ? "已计价部分" : "已记录费用" }}
          <strong>{{ cost }}</strong>
        </p>
        <p class="usageHint">
          {{
            unpriced
              ? "部分模型尚未配置价格，金额仅包含已计价记录。"
              : data.totalCostUsd === null
                ? "尚无已计价记录，接入模型后开始累计。"
                : "按供应商回执或已配置单价记录。"
          }}
        </p>
      </template>
      <p v-else>正在读取用量…</p>
    </section>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
type UsageSummary = { byKind: { kind: string; unit: string; units: number; unpriced: number }[]; totalCostUsd: number | null };
const data = ref<UsageSummary>();
const error = ref("");
const loading = ref(false);
const images = computed(() => units("image", "image"));
const seconds = computed(() => units("video", "second"));
const tokens = computed(() => units("text", "token"));
const unpriced = computed(() => data.value?.byKind.some((item) => item.unpriced > 0));
const cost = computed(() =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(data.value?.totalCostUsd ?? 0),
);
function units(kind: string, unit: string) {
  return (
    data.value?.byKind.filter((item) => item.kind === kind && item.unit === unit).reduce((total, item) => total + item.units, 0) ?? 0
  ).toLocaleString();
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/cloud/usage/summary?period=month");
    if (!response.ok) throw new Error("用量读取失败，请重试。");
    data.value = await response.json();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "用量读取失败";
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<style scoped lang="scss">
.usageSummary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 12px;
  border: 1px solid var(--studioBorder);
  border-radius: var(--ui-radius);
  background: var(--studioSurface);
  color: var(--studioInk);
  cursor: pointer;
  span {
    font-size: 11px;
    color: var(--studioMuted);
  }
  strong {
    font-size: 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
}
.usageDetails {
  h3 {
    margin: 0;
    font-size: 16px;
  }
  p {
    font-size: 13px;
    line-height: 1.7;
  }
  .usageHint {
    font-size: 12px;
    color: var(--studioMuted);
  }
  dl {
    display: grid;
    gap: 12px;
    div {
      display: flex;
      justify-content: space-between;
    }
    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
  }
}
</style>
