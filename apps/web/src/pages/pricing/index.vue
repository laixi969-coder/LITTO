<template>
  <main class="pricingPage">
    <div class="priceSheet">
      <header>
        <a class="backLink" href="#/home">← 返回工作台</a>
        <p class="brandName">MILI MILI</p>
        <h1>选择你的创作套餐</h1>
        <p>会员方案预览 · 积分按月发放，可在图片与视频模型间通用。订阅待开放。</p>
        <div class="cycleSwitch" role="group" aria-label="付费周期">
          <button v-for="(cycle, index) in cycles" :key="cycle.name" type="button" :aria-pressed="cycleIndex === index" @click="cycleIndex = index">{{ cycle.name }}</button>
        </div>
      </header>
      <section class="planGrid" aria-label="会员套餐对比">
        <article v-for="(plan, index) in plans" :key="plan.name" class="planCard" :class="{ featured: index === 1 }">
          <h2>{{ plan.name }}</h2>
          <p class="price"><span>¥</span><strong>{{ monthlyPrice(plan.introPrice ?? plan.total) }}</strong><small>{{ plan.introPrice ? "/ 首月" : "/ 月" }}</small></p>
          <p v-if="plan.introPrice" class="payment">次月起 ¥{{ plan.total }} / 月</p>
          <p v-else class="payment">{{ cycles[cycleIndex].name }}合计 ¥{{ plan.total }}</p>
          <div class="allowance">
            <span>每月通用积分</span>
            <strong>{{ plan.points.toLocaleString() }} <small>分</small></strong>
            <div v-if="plan.options.length > 1" class="quotaOptions" role="group" :aria-label="plan.name + '月积分档位'">
              <button v-for="(option, optionIndex) in plan.options" :key="option.points" type="button" :aria-pressed="selectedOptions[index] === optionIndex" @click="selectedOptions[index] = optionIndex">{{ option.points.toLocaleString() }} 分</button>
            </div>
          </div>
          <div class="outputs">
            <h3>每月最高可生成</h3>
            <p><span>图像</span><strong>{{ Math.floor(plan.points / lowestImageRate.promo).toLocaleString("zh-CN") }} 张</strong></p>
            <p><span>或视频</span><strong>{{ maxSeconds(plan.points).toLocaleString("zh-CN") }} 秒</strong></p>
          </div>
          <ul v-if="showBenefits" class="benefits" :aria-label="plan.name + '拟含权益'">
            <li v-for="feature in plan.features" :key="feature">{{ feature }}</li>
          </ul>
        </article>
      </section>
      <div class="cardNotes">
        <p>单项上限按同一笔月额度全部用于 {{ lowestImageRate.model }} {{ lowestImageRate.tier }} 或 H3 480p 活动档估算，视频每条 5 秒。</p>
        <button type="button" :aria-expanded="showBenefits" @click="showBenefits = !showBenefits">{{ showBenefits ? "收起权益 −" : "更多权益 +" }}</button>
      </div>
      <section class="comparison" aria-labelledby="outputTitle">
        <h2 id="outputTitle">各模型每月生成量对比</h2>
        <p>选择你常用的模型，按活动扣分估算各档月额度可生成的张数或条数。</p>
        <div class="filters">
          <div class="mediaTabs" role="group" aria-label="生成类型">
            <button v-for="kind in mediaTypes" :key="kind" type="button" :aria-pressed="media === kind" @click="media = kind">{{ kind }}生成</button>
          </div>
          <label>查找型号
            <input v-model.trim="modelSearch[media]" type="search" :placeholder="media === '图像' ? '例如 Seedream 5.5' : '例如 Kling 3.0'" />
          </label>
        </div>
        <div class="tableWrap" tabindex="0" aria-label="模型生成量对比表">
          <table>
            <thead><tr><th scope="col">模型与规格</th><th scope="col">活动扣分<small>每{{ media === "视频" ? "条" : "张" }}</small></th><th v-for="plan in plans" :key="plan.name" scope="col">{{ plan.name }}<small>{{ plan.points }} 分 / 月</small></th></tr></thead>
            <tbody>
              <tr v-for="row in outputRows" :key="row.name">
                <th scope="row">{{ row.name }}<small v-if="row.pending">{{ row.pending }}</small></th>
                <td>{{ row.cost }} 分<small v-if="row.regular !== row.cost">常规 {{ row.regular }} 分</small></td>
                <td v-for="plan in plans" :key="plan.name">
                  <template v-if="plan.points >= row.cost"><strong>{{ Math.floor(plan.points / row.cost) }} {{ media === "视频" ? "条" : "张" }}</strong><small v-if="row.seconds">共 {{ Math.floor(plan.points / row.cost) * row.seconds }} 秒</small></template>
                  <small v-else>差 {{ row.cost - plan.points }} 分</small>
                </td>
              </tr>
              <tr v-if="!outputRows.length"><td :colspan="plans.length + 2">没有匹配的型号，请调整搜索词。</td></tr>
            </tbody>
          </table>
        </div>
        <p>{{ media === "视频" ? "H3 使用已有参考图；Seedance 按有声首帧图生视频估算；Kling 按所选音频档位计。" : "图像按单张文生图估算，K 档按方图询价。GPT Image 2 适用 1024×1024、1536×1024、1024×1536。画布可选型号取决于已配置渠道。" }}</p>
      </section>
      <section class="topUps">
        <h2>一次性充值</h2>
        <p>1 元 = 10 积分。单次体验 ¥9.90 / 99 分，项目包 ¥29.90 / 299 分。</p>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

import membershipPlans from "./membershipPlans.json";
import imageRates from "./imageRates.json";

const cycles = [{ name: "月付", months: 1 }, { name: "季付", months: 3 }, { name: "年付", months: 12 }] as const;
const cycleIndex = ref(0);
const selectedOptions = ref(membershipPlans.map(() => 0));
const showBenefits = ref(true);
const plans = computed(() => membershipPlans.map((plan, index) => {
  const option = plan.options[selectedOptions.value[index]!]!;
  return { ...plan, points: option.points, total: option.prices[cycleIndex.value]!, introPrice: cycleIndex.value === 0 ? plan.firstMonthPrice : undefined };
}));

function monthlyPrice(total: number) {
  return (total / cycles[cycleIndex.value]!.months).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

const mediaTypes = ["图像", "视频"] as const;
const media = ref<(typeof mediaTypes)[number]>("图像");
const modelSearch = ref({ 图像: "", 视频: "" });
const durations = [5, 10, 15];
const videos = [
  { model: "Kling 3.0", tier: "标准 · 无声", promo: [60, 120, 180], regular: [75, 150, 225] },
  { model: "Kling 3.0", tier: "标准 · 有声", promo: [95, 190, 285], regular: [110, 220, 330] },
  { model: "Kling 3.0", tier: "Pro · 无声", promo: [95, 190, 285], regular: [115, 230, 345] },
  { model: "Kling 3.0", tier: "Pro · 有声", promo: [140, 280, 420], regular: [165, 330, 495] },
  { model: "Seedance 2.0", tier: "480p", promo: [85, 170, 255], regular: [105, 210, 315] },
  { model: "Seedance 2.0", tier: "720p", promo: [155, 310, 465], regular: [190, 380, 570] },
  { model: "Seedance 2.0", tier: "1080p", promo: [295, 590, 885], regular: [365, 730, 1095] },
  { model: "Seedance 2.5", tier: "480p", promo: [130, 260, 390], regular: [160, 320, 480] },
  { model: "Seedance 2.5", tier: "720p", promo: [245, 490, 735], regular: [295, 590, 885] },
  { model: "Seedance 2.5", tier: "1080p", promo: [445, 890, 1335], regular: [545, 1090, 1635] },
  { model: "Seedance 2.5 Flash", tier: "480p", promo: [80, 160, 240], regular: [110, 220, 330] },
  { model: "Seedance 2.5 Flash", tier: "720p", promo: [145, 290, 435], regular: [195, 390, 585] },
  { model: "H3", tier: "480p", promo: [19, 39, 59], regular: [49, 99, 149] },
  { model: "H3", tier: "768p", promo: [29, 59, 99], regular: [59, 119, 199] },
];
const imageAliases: Record<string, string> = { "字节 · Seedream": "字节跳动 火山引擎 豆包 Doubao", "Google · Nano Banana": "Gemini 谷歌 香蕉", "MiniMax · H3 Image": "海螺" };
const lowestImageRate = imageRates.filter(rate => !rate.pending).reduce((lowest, rate) => rate.promo < lowest.promo ? rate : lowest);
const imageRows = imageRates.map(rate => ({
  name: rate.model + " · " + rate.tier, keywords: [rate.family, imageAliases[rate.family]].join(" "),
  cost: rate.promo, regular: rate.regular, seconds: 0, pending: rate.pending,
}));
const videoRows = videos.flatMap(rate => durations.map((seconds, index) => ({
  name: rate.model + " · " + rate.tier + " · " + seconds + " 秒", keywords: "",
  cost: rate.promo[index]!, regular: rate.regular[index]!, seconds, pending: false,
})));
const outputRows = computed(() => {
  const rows = media.value === "图像" ? imageRows : videoRows;
  const terms = modelSearch.value[media.value].toLowerCase().split(/[\s-]+/).filter(Boolean);
  return rows.filter(row => {
    const keywords = (row.name + row.keywords).toLowerCase().replace(/[\s-]/g, "");
    return terms.every(term => keywords.includes(term));
  });
});

function maxSeconds(points: number) {
  return Math.max(...videos.map(rate => Math.floor(points / rate.promo[0]!) * durations[0]!));
}
</script>

<style lang="scss" scoped>
.pricingPage {
  --paper: #17191b;
  --line: rgb(198 213 207 / 16%);
  --muted: #b3b8bc;
  --accent: #94d5c6;
  height: 100dvh;
  overflow: auto;
  background: #101214;
  color: #fafaf8;
  color-scheme: dark;
  .priceSheet {
    max-width: 1280px;
    margin: auto;
    padding: 24px clamp(16px, 4vw, 50px) 60px;
    button, select { font: inherit; cursor: pointer; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    @media (pointer: coarse) {
      button, select, input, .backLink { min-height: 44px; }
    }
    h2, h3, p { margin: 0; }
    header {
      position: relative; padding: 38px 0 28px; text-align: center;
      .backLink { position: absolute; top: 0; left: 0; color: var(--muted); }
      .brandName { font-size: 12px; font-weight: 750; color: var(--accent); letter-spacing: 2px; }
      h1 { margin: 8px 0; font-size: clamp(32px, 4vw, 48px); line-height: 1.22; }
      p { color: var(--muted); line-height: 1.6; }
      .cycleSwitch {
        display: inline-flex; gap: 4px; margin-top: 20px; padding: 4px; border-radius: 24px; background: #25282b;
        button { padding: 7px 22px; color: var(--muted); border: 0; border-radius: 20px; background: transparent; }
        button[aria-pressed="true"] { background: #f1f2ef; color: #151718; font-weight: 700; }
      }
    }
    .planGrid {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px;
      @media (max-width: 980px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      @media (max-width: 550px) { grid-template-columns: 1fr; }
      .planCard {
        display: grid; grid-template-rows: subgrid; grid-row: span 6; row-gap: 0;
        padding: clamp(16px, 1.6vw, 24px); border: 1px solid var(--line); border-radius: 16px; background: var(--paper);
        font-variant-numeric: tabular-nums;
        @media (max-width: 550px) { display: block; grid-row: auto; }
        &.featured { border-color: var(--accent); }
        > h2 { font-size: 24px; }
        .price {
          display: flex; align-items: baseline; gap: 4px; margin: 20px 0 2px;
          strong { font-size: clamp(28px, 3vw, 43px); line-height: 1.1; font-variant-numeric: tabular-nums; }
          small { color: var(--muted); }
        }
        .payment { font-size: 13px; color: var(--muted); }
        .allowance {
          padding: 14px; margin-top: 20px; border-radius: 10px; background: #232629;
          > span { display: block; color: var(--muted); font-size: 13px; }
          > strong { font-size: 24px; small { font-size: 13px; } }
          .quotaOptions {
            display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;
            button { background: transparent; color: var(--muted); border: 1px solid #61686d; border-radius: 5px; padding: 2px 7px; font-size: 12px; }
            button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
          }
        }
        .outputs {
          margin-top: 16px;
          h3 { font-size: 16px; margin-bottom: 8px; }
          p { display: flex; align-items: baseline; justify-content: space-between; padding: 3px 0; color: var(--muted); strong { color: #edf3ef; font-size: 18px; } }
        }
        .benefits {
          padding: 12px 0 0; margin: 14px 0 0; border-top: 1px solid var(--line); list-style: none;
          li { margin-top: 6px; font-size: 14px; }
          li::before { content: "✓"; color: var(--accent); margin-right: 8px; }
        }
      }
    }
    .cardNotes {
      margin: 12px 0 30px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;
      p { font-size: 13px; color: var(--muted); }
      button { color: var(--accent); padding: 4px 0; background: transparent; border: 0; }
    }
    .comparison {
      padding: clamp(14px, 3vw, 28px); background: var(--paper); border: 1px solid var(--line); border-radius: 16px;
      > p { margin: 8px 0; color: var(--muted); line-height: 1.6; }
      .filters {
        display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 18px 0;
        label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
        select, input { font: inherit; color: inherit; border-radius: 7px; border: 1px solid var(--line); padding: 7px; background: #232629; }
        .mediaTabs {
          display: flex; gap: 2px; padding: 3px; background: #25282b; border-radius: 8px;
          button { color: inherit; border: 0; padding: 7px 12px; border-radius: 6px; background: transparent; }
          button[aria-pressed="true"] { background: var(--accent); color: #101c19; }
        }
      }
      .tableWrap {
        overflow-x: auto;
        table {
          width: 100%; min-width: 680px; border-collapse: collapse; font-variant-numeric: tabular-nums;
          th, td { text-align: right; padding: 10px 8px; border-bottom: 1px solid var(--line); }
          th:first-child { text-align: left; }
          thead th { background: #25282b; }
          tbody th { font-weight: 500; }
          small { display: block; color: var(--muted); font-weight: 400; }
        }
      }
    }
    .topUps { margin-top: 24px; p { color: var(--muted); margin-top: 8px; } }
  }
}
</style>
