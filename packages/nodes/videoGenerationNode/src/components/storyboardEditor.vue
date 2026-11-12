<template>
  <el-button text :disabled="disabled" @click="open">分镜编排<span v-if="count"> · {{ count }}</span></el-button>
  <el-dialog v-model="visible" class="storyboardDialog" title="视频分镜编排" width="min(1080px, 96vw)" top="4vh" appendToBody :closeOnClickModal="false" :beforeClose="close">
    <div class="storyboardEditor nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="draft">
        <div class="planBar"><span>生成时长 {{ duration ?? '未选择' }} 秒 · {{ draft.shots.length }}/8 镜</span><el-button :disabled="busy || disabled || draft.shots.length >= 8" @click="add">添加分镜</el-button></div>
        <p>{{ production ? '正式镜头沿用项目中已绑定的角色、主帧与其他参考；更换素材请在镜头制作中操作。' : '画面字段输入 @ 引用已连接素材。' }}连续段落不切镜；明确选“切镜”时会核对模型能力。</p>
        <div class="shotList">
          <section v-for="(shot, index) in draft.shots" :key="shot.id" class="shotCard" :aria-label="`分镜 ${index + 1}`">
            <div class="shotHeader"><strong>分镜 {{ index + 1 }}</strong><el-button :disabled="busy || disabled || !index" @click="move(index, -1)">上移</el-button><el-button :disabled="busy || disabled || index === draft.shots.length - 1" @click="move(index, 1)">下移</el-button><el-button :disabled="busy || disabled || draft.shots.length === 1" @click="remove(index)">删除</el-button></div>
            <fieldset :disabled="busy || disabled">
              <div class="shotSettings">
                <label>开始（秒）<input v-model.number="shot.start" type="number" min="0" :max="duration" step="0.1" /></label>
                <label>结束（秒）<input v-model.number="shot.end" type="number" min="0.1" :max="duration" step="0.1" /></label>
                <label>与前镜衔接<select v-model="shot.transition" :disabled="!index"><option value="continuous">连续动作</option><option value="cut">切镜</option></select></label>
                <label>焦距<select v-model="shot.lensMm"><option :value="undefined">沿用</option><option v-for="value in [16, 24, 35, 50, 85, 105, 135, 200]" :key="value" :value="value">{{ value }}mm</option><option v-if="shot.lensMm && ![16, 24, 35, 50, 85, 105, 135, 200].includes(shot.lensMm)" :value="shot.lensMm">{{ shot.lensMm }}mm</option></select></label>
                <label>光圈<select v-model="shot.aperture"><option :value="undefined">沿用</option><option v-for="value in [1.4, 1.8, 2.8, 4, 5.6, 8, 11, 16]" :key="value" :value="value">f/{{ value }}</option><option v-if="shot.aperture && ![1.4, 1.8, 2.8, 4, 5.6, 8, 11, 16].includes(shot.aperture)" :value="shot.aperture">f/{{ shot.aperture }}</option></select></label>
                <label>运镜技法<select :value="''" @change="chooseMotion(shot, $event)"><option value="">从现有技法库选择</option><option v-for="item in motions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
              </div>
              <label class="motionField">运镜执行描述<textarea v-model="shot.cameraMove" rows="2" maxlength="2000" aria-label="运镜执行描述" /></label>
              <div class="shotFields" :inert="busy || disabled">
                <div v-for="field in fields" :key="field.key" class="shotField"><span>{{ field.label }}</span><promptInput v-model="editors[shot.id]![field.key]" v-model:text="shot[field.key]" :label="field.label" :references="references" /></div>
              </div>
            </fieldset>
          </section>
        </div>
        <div class="soundSettings"><label>音效<select v-model="draft.soundEffects" :disabled="busy || disabled"><option value="auto">沿用</option><option value="on">生成</option><option value="off">不要音效</option></select></label><label>背景音乐<select v-model="draft.music" :disabled="busy || disabled"><option value="auto">沿用</option><option value="on">生成</option><option value="off">不要背景音乐</option></select></label></div>
        <p>声音开关表达音效与配乐意图，不删除对白。生成声音会同步开启模型音频；焦距、光圈与运镜通过文字引导，效果取决于模型。</p>
        <label class="preview">生成内容预览<textarea :value="previewText" readonly rows="10" aria-label="分镜生成内容预览" /></label>
        <p v-if="validationError" class="error" role="alert">{{ validationError }}</p>
      </template>
    </div>
    <template #footer><el-button v-if="clear" :disabled="busy || disabled" @click="clear(); visible = false">停用已保存编排</el-button><el-button :disabled="busy" @click="visible = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="disabled || !draft || !!validationError" @click="apply">保存编排并预览</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElDialog, ElMessageBox } from "element-plus";
import promptInput from "@toonflow/nodes-scaffold/promptInput";
import { validateVideoStoryboard, type VideoStoryboard, type VideoStoryboardShot } from "@toonflow/nodes-scaffold/runtime";
import { filmTechniques } from "@toonflow/tool-media-generation/filmTechniques";

const props = defineProps<{
  disabled?: boolean; count?: number; duration?: number; production?: boolean;
  references: InstanceType<typeof promptInput>["$props"]["references"];
  load: () => Promise<VideoStoryboard>;
  save: (plan: VideoStoryboard) => Promise<void>;
  clear?: () => void;
  preview: (plan: VideoStoryboard) => string;
  validate: (plan: VideoStoryboard) => void;
}>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const visible = ref(false), busy = ref(false), error = ref("");
watch(visible, value => emit("busy", value), { flush: "sync" });
const draft = ref<VideoStoryboard>();
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const fields = [{ key: "description", label: "画面与动作" }, { key: "foreground", label: "前景" }, { key: "background", label: "远景" }] as const;
const editors = ref<Record<string, Record<typeof fields[number]["key"], PromptModel>>>({});
const motions = filmTechniques.filter(item => item.category === "camera" && item.stages.includes("video"));
const previewText = computed(() => { try { return draft.value ? props.preview(draft.value) : ""; } catch (cause) { return message(cause); } });
const validationError = computed(() => { try { if (draft.value) { validateVideoStoryboard(draft.value, props.duration); props.validate(draft.value); } return ""; } catch (cause) { return message(cause); } });
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
let saved = "";
function initEditors(shot: VideoStoryboardShot) { editors.value[shot.id] = Object.fromEntries(fields.map(field => [field.key, [[{ type: "Write", text: shot[field.key] }]]])) as Record<typeof fields[number]["key"], PromptModel>; }
async function open() {
  visible.value = true; busy.value = true; error.value = ""; draft.value = undefined;
  try { const plan = await props.load(); editors.value = {}; plan.shots.forEach(initEditors); draft.value = plan; saved = JSON.stringify(plan); }
  catch (cause) { error.value = message(cause); }
  finally { busy.value = false; }
}
function add() {
  const plan = draft.value; if (!plan || plan.shots.length >= 8) return;
  const last = plan.shots.at(-1)!;
  if (last.end - last.start < 0.2) { error.value = "最后一镜不足 0.2 秒，无法再拆分"; return; }
  const end = last.end;
  last.end = Math.round((last.start + end) / 2 * 1000) / 1000;
  const shot: VideoStoryboardShot = { id: crypto.randomUUID(), start: last.end, end, transition: "continuous", description: "", foreground: "", background: "", cameraMove: "" };
  initEditors(shot); plan.shots.push(shot); error.value = "";
}
function remove(index: number) {
  const plan = draft.value; if (!plan || plan.shots.length < 2) return;
  const [shot] = plan.shots.splice(index, 1);
  if (index) plan.shots[index - 1]!.end = shot!.end;
  else { plan.shots[0]!.start = 0; plan.shots[0]!.transition = "continuous"; }
  delete editors.value[shot!.id];
}
function move(index: number, offset: number) {
  const plan = draft.value; if (!plan) return;
  const [shot] = plan.shots.splice(index, 1); plan.shots.splice(index + offset, 0, shot!);
  let start = 0;
  for (const item of plan.shots) { const length = item.end - item.start; item.start = start; item.end = Math.round((start + length) * 1000) / 1000; start = item.end; }
  plan.shots[0]!.transition = "continuous";
}
function chooseMotion(shot: VideoStoryboardShot, event: Event) { const item = motions.find(item => item.id === (event.target as HTMLSelectElement).value); if (item) shot.cameraMove = `${item.label}：${item.instruction}`; (event.target as HTMLSelectElement).value = ""; }
async function apply() {
  if (!draft.value || props.disabled || busy.value) return;
  busy.value = true; error.value = "";
  try { const plan = validateVideoStoryboard(draft.value, props.duration); props.validate(plan); await props.save(plan); saved = JSON.stringify(draft.value); visible.value = false; }
  catch (cause) { error.value = message(cause); }
  finally { busy.value = false; }
}
async function close(done: () => void) {
  if (busy.value) return;
  if (draft.value && JSON.stringify(draft.value) !== saved) { try { await ElMessageBox.confirm("放弃尚未保存的分镜修改？", "关闭分镜编排", { confirmButtonText: "放弃修改", cancelButtonText: "继续编辑" }); } catch { return; } }
  done();
}
</script>

<style lang="scss">
.storyboardDialog {
  display: flex; flex-direction: column; max-height: 92vh;
  .el-dialog__body { min-height: 0; overflow-y: auto; }
  .el-dialog__header, .el-dialog__footer { flex-shrink: 0; }
}
.storyboardEditor {
  display: grid; gap: 14px;
  p { margin: 0; color: var(--el-text-color-secondary); line-height: 1.6; }
  .error { color: var(--el-color-danger); }
  .planBar, .shotHeader, .soundSettings { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .shotList { display: grid; gap: 16px;
    .shotCard { border: 1px solid var(--el-border-color); border-radius: 12px; padding: 16px;
      .shotHeader { margin-bottom: 14px; strong { margin-right: auto; } }
      fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
      .shotSettings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .motionField { margin-top: 12px; }
      .shotFields { display: grid; gap: 10px; margin-top: 12px;
        .shotField { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 8px; span { font-size: 13px; } }
      }
    }
  }
  label { display: grid; gap: 6px; font-size: 13px; }
  input, select, textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-fill-color-blank); color: var(--el-text-color-primary); padding: 8px; font: inherit; &:focus-visible { outline: 2px solid var(--el-color-primary); } }
  textarea { resize: vertical; line-height: 1.6; }
  .soundSettings label { min-width: 160px; }
  @media (max-width: 640px) { .shotList .shotCard .shotSettings { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
}
</style>
