<template>
  <section class="visualReferenceBoard" :aria-busy="busy">
    <p>从故事寻找构图、光线和色彩方向。收藏随项目保存，助手可以读取具体参考用途。</p>
    <form @submit.prevent="discover">
      <label>故事与视觉需求<textarea v-model="query" rows="3" maxlength="6000" :disabled="busy" /></label>
      <div class="boardToolbar">
        <el-button nativeType="submit" :disabled="busy || !model || query.trim().length < 3">匹配视觉方向</el-button>
        <el-button v-if="busy && matching" @click="controller?.abort()">停止</el-button>
        <label><input v-model="exploratory" type="checkbox" :disabled="busy" />探索更多方向</label>
        <el-button :disabled="busy || !project.visualBoard.length" @click="exportBoard">导出参考清单</el-button>
      </div>
    </form>
    <p v-if="error" class="boardError" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <p class="boardHint">匹配评估导演文字画像，未分析图片像素；分数表示主观适配程度。图片来自 TMDB，收藏清单不授予电影画面使用权。</p>
    <div v-if="rankings.length" class="directionList">
      <button v-for="rank in recommendations" :key="rank.directorId" :aria-pressed="directorId === rank.directorId" @click="directorId = rank.directorId"><strong>{{ directorName(rank.directorId) }} · {{ rank.total }}</strong><span>{{ rank.reason }}</span></button>
      <p v-if="!recommendations.length">本次没有达到筛选阈值的方向，可以继续浏览资料库。</p>
    </div>
    <label>浏览导演<select v-model="directorId"><option v-for="director in visualDirectors" :key="director.id" :value="director.id">{{ director.name }}</option></select></label>
    <div v-if="director" class="directorDetails">
      <h3>{{ director.name }}</h3><p>{{ director.mood }}</p><p>构图：{{ director.composition }}</p><p>光线：{{ director.light }}</p>
      <div class="palette" aria-label="参考色彩"><span v-for="color in director.palette" :key="color" :style="{ background: color }" :title="color" /></div>
    </div>
    <div class="referenceGrid">
      <button v-for="frame in gallery" :key="frame.id" :aria-pressed="selectedId === frame.id" @click="selectedId = frame.id"><img :src="frame.src" :alt="`${frame.film}（${frame.year}）参考画面`" loading="lazy" referrerpolicy="no-referrer" /><span>{{ frame.film }} · {{ frame.year }}</span></button>
    </div>
    <div v-if="selectedFrame" class="referenceDetails">
      <h3>{{ selectedFrame.film }} · {{ selectedFrame.year }}</h3><a :href="selectedFrame.source" target="_blank" rel="noopener noreferrer">查看画面来源</a>
      <label>采用用途<select v-model="purpose" :disabled="busy"><option value="composition">构图</option><option value="lighting">光线</option><option value="palette">色彩</option></select></label>
      <label>具体借鉴什么<textarea v-model="note" rows="2" maxlength="1000" :disabled="busy" /></label>
      <el-button :disabled="busy || !note.trim() || project.visualBoard.length >= 24 && !isSaved(selectedFrame.id)" @click="saveReference">{{ isSaved(selectedFrame.id) ? '更新参考用途' : '收藏到本项目' }}</el-button>
    </div>
    <h3 v-if="savedReferences.length">本项目参考 · {{ savedReferences.length }}/24</h3>
    <div class="savedReferences"><article v-for="item in savedReferences" :key="item.frameId"><img :src="item.frame.src" :alt="item.frame.film" loading="lazy" referrerpolicy="no-referrer" /><div><strong>{{ item.frame.film }}</strong><p>{{ purposeLabels[item.purpose] }} · {{ item.note }}</p><a :href="item.frame.source" target="_blank" rel="noopener noreferrer">来源</a></div><el-button :disabled="busy" @click="removeReference(item.frameId)">移除</el-button></article></div>
    <p class="boardHint">参考库据 Frame 项目整理。电影图片权利属于各自权利人；本产品不由 TMDB 背书或认证。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { useNodeAi, type NodeAiModel } from "@toonflow/nodes-scaffold/nodeAi";
import { visualDirectors, visualFrames, visualRankParameters, readVisualRanks, resolveVisualBoard, visualReferenceGuide, type VisualRank, type VisualBoard } from "@toonflow/tool-scene-list/visualReference";
import type { StoryProject, StoryAction } from "@toonflow/tool-scene-list/storyProject";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const props = defineProps<{ directory: string; project: StoryProject; model?: NodeAiModel; apply: (action: StoryAction) => Promise<void> }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const ai = useNodeAi(), files = useWorkspaceFiles(props.directory);
const query = ref(props.project.brief.idea.slice(0, 6000)), rankings = ref<VisualRank[]>([]), exploratory = ref(false);
const directorId = ref(visualDirectors[0]!.id), selectedId = ref("");
const purpose = ref<VisualBoard[number]["purpose"]>("composition"), note = ref("");
const busy = ref(false), matching = ref(false), error = ref(""), message = ref("");
let controller: AbortController | undefined;
const purposeLabels = { composition: "构图", lighting: "光线", palette: "色彩" };
const recommendations = computed(() => rankings.value.filter(item => item.total >= (exploratory.value ? 35 : 60)).slice(0, exploratory.value ? 8 : 6));
const director = computed(() => visualDirectors.find(item => item.id === directorId.value));
const gallery = computed(() => visualFrames.filter(item => item.director === directorId.value).slice(0, 24));
const selectedFrame = computed(() => visualFrames.find(item => item.id === selectedId.value));
const savedReferences = computed(() => resolveVisualBoard(props.project.visualBoard));
const directorName = (id: string) => visualDirectors.find(item => item.id === id)?.name;
const isSaved = (id: string) => props.project.visualBoard.some(item => item.frameId === id);
watch(query, () => { rankings.value = []; });
watch(directorId, () => { selectedId.value = ""; });
watch(selectedId, id => { const saved = props.project.visualBoard.find(item => item.frameId === id); purpose.value = saved?.purpose ?? "composition"; note.value = saved?.note ?? ""; });
async function run(action: () => Promise<void>, canStop = false) {
  if (busy.value) return;
  busy.value = true; matching.value = canStop; emit("busy", true); error.value = ""; message.value = "";
  const current = new AbortController(); controller = current;
  try { await action(); }
  catch (cause) { error.value = current.signal.aborted ? "已停止匹配" : cause instanceof Error ? cause.message : "处理失败"; }
  finally { busy.value = false; matching.value = false; emit("busy", false); controller = undefined; }
}
async function discover() {
  await run(async () => {
    const model = props.model, brief = query.value.trim();
    if (!model || brief.length < 3) throw new Error("请先选择模型并说明故事需求");
    const signal = controller!.signal;
    let result: VisualRank[] | undefined;
    await ai.generate({ directory: props.directory, providerId: model.providerId, modelId: model.modelId, systemPrompt: visualReferenceGuide, prompt: JSON.stringify({ brief, profiles: visualDirectors }), signal,
      tools: [{ name: "submitVisualRanks", description: "返回每位导演各一次的三维评分及中文依据。", parameters: visualRankParameters,
        execute(input) { signal.throwIfAborted(); if (result) return { accepted: true }; result = readVisualRanks(input); return { accepted: true }; } }],
    });
    signal.throwIfAborted();
    if (!result) throw new Error("模型未返回完整匹配结果，请重试");
    rankings.value = result;
    const best = recommendations.value[0]; if (best) directorId.value = best.directorId;
    message.value = "匹配完成，可浏览画面并选择具体参考用途";
  }, true);
}
async function saveReference() {
  await run(async () => {
    const frame = selectedFrame.value; if (!frame) throw new Error("请先选择参考画面");
    const values = props.project.visualBoard.filter(item => item.frameId !== frame.id);
    values.push({ frameId: frame.id, purpose: purpose.value, note: note.value });
    await props.apply({ type: "visualBoard", values }); message.value = "参考用途已保存到本项目";
  });
}
async function removeReference(id: string) { await run(async () => { await props.apply({ type: "visualBoard", values: props.project.visualBoard.filter(item => item.frameId !== id) }); }); }
async function exportBoard() {
  await run(async () => { const path = `visualReferenceBoard${Date.now()}.json`; await files.writeJson(path, { milimiliVisualBoard: 1, references: savedReferences.value, note: "外部画面来源清单，不包含图片使用授权" }, true); message.value = `参考清单已保存：${path}`; });
}
onScopeDispose(() => controller?.abort());
</script>

<style scoped lang="scss">
.visualReferenceBoard {
  label { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; font-size: 13px; }
  textarea, select { width: 100%; box-sizing: border-box; min-height: 42px; padding: 10px; border: 1px solid var(--studioBorder); border-radius: 8px; background: var(--studioSurface); color: inherit; font: inherit; }
  textarea { resize: vertical; } :is(textarea, select, a):focus-visible { outline: 2px solid var(--studioDone); outline-offset: 2px; }
  p { line-height: 1.7; overflow-wrap: anywhere; }
  .boardToolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; label { flex-direction: row; align-items: center; margin: 0; input { width: auto; min-height: auto; } } }
  .boardError { color: var(--studioAttention); } .boardHint { color: var(--studioMuted); font-size: 12px; }
  .directionList { display: grid; gap: 8px; margin: 20px 0; button { text-align: left; padding: 12px; span { display: block; margin-top: 8px; line-height: 1.6; } } }
  .directorDetails { margin: 20px 0; .palette { display: flex; gap: 4px; span { width: 48px; height: 16px; } } }
  button { border: 1px solid var(--studioBorder); background: var(--studioSurface); color: inherit; cursor: pointer; &[aria-pressed="true"] { border-color: var(--studioDone); } &:focus-visible { outline: 2px solid var(--studioDone); outline-offset: 2px; } }
  .referenceGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; button { overflow: hidden; padding: 0; text-align: left; img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; } span { display: block; padding: 10px; font-size: 12px; } } }
  .referenceDetails { margin: 20px 0; padding: 16px 0; border-block: 1px solid var(--studioBorder); a { display: inline-block; margin-bottom: 16px; } }
  a { color: var(--studioInk); text-underline-offset: 3px; }
  .savedReferences { article { display: flex; align-items: center; gap: 16px; img { width: 120px; aspect-ratio: 16 / 9; object-fit: cover; } div { flex: 1; min-width: 0; } } }
  @media(max-width: 680px) { .referenceGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .savedReferences { article { flex-wrap: wrap; img { width: 100%; } } } }
}
</style>
