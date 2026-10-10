<template>
  <el-card class="questionCard" :class="{ decisionCard: storyDecision }" shadow="never" @keydown.stop @keyup.stop>
    <div class="questionHeader">
      <icon-message-question :size="18" />
      <span class="questionTitle">{{ title }}</span>
      <el-tag size="small" :type="(storyDecision ? toolResult?.approved || toolResult?.applied : answer && !skipped) ? 'success' : 'info'">{{ statusText }}</el-tag>
    </div>
    <template v-if="tool.status === 'error'">
      <p class="questionText">{{ storyDecision ? '本次决定未保存，请根据错误重新核对。' : '表单暂时未生成，请 AI 重新整理。' }}</p>
      <details v-if="tool.result" class="errorDetails">
        <summary>查看错误详情</summary>
        <pre class="errorText">{{ tool.result }}</pre>
      </details>
    </template>
    <p v-else-if="question" class="questionText" :tabindex="storyDecision ? 0 : undefined">{{ question }}</p>
    <div v-if="images.length" class="questionImages">
      <figure v-for="item in images" :key="item.id">
        <a :href="item.url" target="_blank" rel="noopener noreferrer" :aria-label="`查看${item.title}原图`">
          <img :src="item.url" :alt="item.title" @load="loadedImages.add(item.url)" @error="loadedImages.delete(item.url)" />
        </a>
        <figcaption>{{ item.title }}</figcaption>
      </figure>
    </div>
    <p v-if="waiting && images.length && !imagesReady" class="questionText" role="status">等待图片加载完成后即可采用；图片未显示时可点击图片区域查看原图，或暂不采用。</p>
    <div v-if="media.length" class="questionMedia">
      <figure v-for="item in media" :key="item.id">
        <video v-if="item.kind === 'video'" :src="item.url" :aria-label="item.title" controls preload="metadata" />
        <audio v-else :src="item.url" :aria-label="item.title" controls preload="metadata" />
        <figcaption>{{ item.title }}</figcaption>
      </figure>
    </div>
    <div v-if="waiting && storyDecision && !formRules.length" class="questionActions">
      <el-button v-for="(option, index) in options" :key="option" :type="index < options.length - 1 ? 'primary' : 'default'" :disabled="!directory || submitting || (index < options.length - 1 && !imagesReady)" @click="submitAnswer(false, option)">{{ option }}</el-button>
    </div>
    <template v-else-if="waiting">
      <form-create v-if="formRules.length" v-model="formValues" v-model:api="formApi" :rule="formRules" :option="formOptions" />
      <template v-else>
        <el-radio-group v-if="options.length" v-model="selected" class="questionOptions" :disabled="submitting" :aria-label="question">
          <el-radio v-for="option in options" :key="option" :value="option" border>{{ option }}</el-radio>
          <el-radio value="" border>自行填写</el-radio>
        </el-radio-group>
        <el-input
          v-model="text"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          :disabled="submitting"
          :maxlength="8000"
          :placeholder="options.length ? '也可以直接回答或补充说明' : '输入你的回答'"
          aria-label="回答问题" />
        <el-text v-if="draftAnswer.length > 8000" type="danger">回答（含选项）不能超过 8000 字</el-text>
      </template>
      <div class="questionActions">
        <el-button type="primary" :loading="submitting" :disabled="!directory || !imagesReady || (formRules.length ? !formApi : !draftAnswer || draftAnswer.length > 8000)" @click="submitAnswer(false)">
          {{ storyDecision ? '保存决定' : '提交回答' }}
        </el-button>
        <el-button :disabled="!directory || submitting" @click="submitAnswer(true)">跳过</el-button>
      </div>
    </template>
    <p v-if="submitError" class="submitError" role="alert">{{ submitError }}</p>
    <p v-else-if="answer" class="answerText">{{ answer }}</p>
  </el-card>
</template>

<script lang="ts">
import { computed, ref, shallowRef } from "vue";
import axios from "axios";
import formCreate, { type Api, type Options, type Rule } from "@form-create/element-ui";
import {
  ElCard, ElTag, ElButton, ElText,
  ElForm, ElFormItem, ElRow, ElCol,
  ElInput, ElInputNumber, ElSwitch, ElSelect,
  ElOption, ElCheckbox, ElCheckboxGroup, ElRadio, ElRadioGroup,
} from "element-plus";
import "element-plus/es/components/base/style/css";
import "element-plus/es/components/card/style/css";
import "element-plus/es/components/tag/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/text/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/row/style/css";
import "element-plus/es/components/col/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/input-number/style/css";
import "element-plus/es/components/switch/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/checkbox/style/css";
import "element-plus/es/components/checkbox-group/style/css";
import "element-plus/es/components/radio/style/css";
import "element-plus/es/components/radio-group/style/css";
import { IconMessageQuestion } from "@tabler/icons-vue";
import type { QuestionRequest, ToolCall } from "@toonflow/tools-scaffold/runtime";

for (const component of [
  ElForm, ElFormItem, ElRow, ElCol, ElInput, ElInputNumber, ElSwitch,
  ElSelect, ElOption, ElCheckbox, ElCheckboxGroup, ElRadio, ElRadioGroup,
]) formCreate.component(component);
</script>

<script setup lang="ts">
const props = defineProps<{ tool: ToolCall; directory?: string }>();
const storyApproval = computed(() => ["requestStoryApproval", "requestKeyframeApproval"].includes(props.tool.name));
const storyDecision = computed(() => storyApproval.value || ["requestStoryDecision", "requestProductionDecision"].includes(props.tool.name));
const title = computed(() => props.tool.question?.title || toolResult.value?.title || (typeof props.tool.args?.title === "string" ? props.tool.args.title.trim() : "") || (props.tool.name === "requestKeyframeApproval" ? "确认采用主关键帧" : storyApproval.value ? "确认采用故事" : "请确认"));
const selected = ref("");
const text = ref("");
const submitting = ref(false);
const submitError = ref("");
const submittedAnswer = ref("");
const submittedSkipped = ref(false);
const loadedImages = ref(new Set<string>());
const images = computed(() => props.tool.question?.images ?? toolResult.value?.images ?? []);
const media = computed(() => props.tool.question?.media ?? toolResult.value?.media ?? []);
const imagesReady = computed(() => images.value.every(item => loadedImages.value.has(item.url)));
const formApi = shallowRef<Api>();
const formValues = ref<Record<string, unknown>>({});
const formOptions = computed<Options>(() => ({ form: { labelPosition: "top", disabled: submitting.value }, submitBtn: false, resetBtn: false }));
const formRules = computed<Rule[]>(() => (props.tool.question?.fields ?? []).map(field => ({
  type: field.type === "textarea" ? "input" : field.type,
  field: field.field,
  title: field.title,
  value: field.type === "checkbox" ? [] : field.type === "switch" ? false : field.type === "inputNumber" ? undefined : "",
  props: {
    placeholder: field.placeholder,
    ...(field.type === "textarea" ? { type: "textarea", autosize: { minRows: 2, maxRows: 6 } } : {}),
    ...(["input", "textarea"].includes(field.type) ? { maxlength: 8000 } : {}),
    ...(field.type === "select" ? { clearable: true } : {}),
  },
  options: field.options?.map(value => ({ label: value, value })),
  validate: field.required ? [{
    required: true,
    type: field.type === "checkbox" ? "array" : field.type === "inputNumber" ? "number" : field.type === "switch" ? "boolean" : "string",
    message: `请填写${field.title}`,
    ...(field.type === "checkbox" ? { min: field.minSelected ?? 1 } : {}),
    ...(["input", "textarea"].includes(field.type) ? { whitespace: true } : {}),
  }] : [],
})));
const question = computed(() => props.tool.question?.question ?? toolResult.value?.question ?? (typeof props.tool.args?.question === "string" ? props.tool.args.question : ""));
const options = computed(() => {
  const values = props.tool.question?.options ?? toolResult.value?.options ?? props.tool.args?.options;
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))] : [];
});
const toolResult = computed(() => {
  if (props.tool.status !== "success" || !props.tool.result) return;
  try {
    return JSON.parse(props.tool.result) as Partial<QuestionRequest> & { answer?: unknown; skipped?: boolean; approved?: boolean; applied?: boolean };
  } catch { return; }
});
const skipped = computed(() => submittedSkipped.value || toolResult.value?.skipped === true);
const answer = computed(() => {
  if (props.tool.status === "success") return typeof toolResult.value?.answer === "string" ? toolResult.value.answer : props.tool.result ?? "";
  return submittedAnswer.value;
});
const waiting = computed(() => props.tool.status === "running" && !!props.tool.question?.callId && !answer.value);
const draftAnswer = computed(() => [selected.value, text.value.trim()].filter(Boolean).join("\n"));
const statusText = computed(() => {
  if (props.tool.status === "error") return storyDecision.value ? "未保存" : "待重新生成";
  if (props.tool.status === "interrupted") return "已停止";
  if (submitting.value) return "正在提交";
  if (storyApproval.value && props.tool.status === "success") return toolResult.value?.approved ? "已采用" : "未采用";
  if (storyDecision.value && props.tool.status === "success") return toolResult.value?.applied ? "已保存" : "未确认";
  if (storyDecision.value && answer.value) return "正在处理";
  if (skipped.value) return "已跳过";
  if (answer.value) return "已回答";
  return waiting.value ? "等待回答" : "提问记录";
});

async function submitAnswer(skip: boolean, choice?: string) {
  const callId = props.tool.question?.callId;
  const value = choice ?? draftAnswer.value;
  if (!waiting.value || submitting.value || !props.directory || !callId) return;
  if (!skip && !imagesReady.value && (formRules.value.length || choice === options.value[0])) return;
  if (!skip && !formRules.value.length && (!value || value.length > 8000)) return;
  submitting.value = true;
  submitError.value = "";
  try {
    if (!skip && formRules.value.length && !(await formApi.value?.validate().catch(() => false))) return;
    const response = await axios.post("/api/agent/answer", {
      directory: props.directory,
      callId,
      ...(skip ? { skipped: true } : formRules.value.length ? { values: formApi.value!.formData() } : { answer: value }),
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (response.data.code !== 200) throw new Error(response.data.message || "提交回答失败");
    submittedAnswer.value = response.data.data.answer;
    submittedSkipped.value = response.data.data.skipped === true;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message : undefined;
    submitError.value = message || (error instanceof Error ? error.message : "提交回答失败，请重试；已填写内容保留");
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped lang="scss">
.questionCard {
  .questionMedia {
    figure { margin: 12px 0; video, audio { display: block; width: 100%; max-height: 360px; } figcaption { margin-top: 6px; overflow-wrap: anywhere; } }
  }
  &.decisionCard .questionText { max-height: min(40vh, 360px); overflow: auto; overscroll-behavior: contain; }
  .questionImages {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
    gap: 12px;
    figure {
      min-width: 0;
      margin: 0;
      a {
        display: block;
        img { display: block; width: 100%; height: 180px; object-fit: contain; background: var(--el-fill-color-light); }
      }
      figcaption { margin-top: 6px; overflow-wrap: anywhere; }
    }
  }
  .questionHeader {
    display: flex;
    align-items: center;
    gap: 8px;

    .questionTitle {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .el-tag {
      margin-left: auto;
      flex-shrink: 0;
    }
  }

  .questionText,
  .answerText,
  .submitError,
  .errorText {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .submitError { color: var(--el-color-danger); }

  .errorDetails {
    color: var(--el-text-color-secondary);
    font-size: 12px;

    summary {
      cursor: pointer;
    }

    .errorText {
      max-height: 240px;
      margin-bottom: 0;
      overflow: auto;
      font-family: var(--el-font-family);
    }
  }

  .questionOptions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    margin-bottom: 12px;

    .el-radio {
      width: 100%;
      height: auto;
      margin: 0;
      padding: 8px 12px;

      :deep(.el-radio__label) {
        white-space: normal;
        overflow-wrap: anywhere;
      }
    }
  }

  .questionActions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 12px;

    .el-button {
      margin: 0;
      max-width: 100%;
      height: auto;
      min-height: 32px;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
}
</style>
