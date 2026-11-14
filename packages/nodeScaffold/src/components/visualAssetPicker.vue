<template>
  <section class="visualAssetPicker" :inert="disabled || busy">
    <p v-if="error" role="alert">{{ error }}</p>
    <label>导演配色资料<select v-model="assetId" aria-label="导演配色资料" @change="chooseAsset"><option value="">选择已有配色资料</option><option v-for="item in catalog" :key="item.id" :value="item.id">{{ item.name }} · {{ item.category }}</option></select></label>
    <div class="paletteColors" aria-label="当前配色资产"><span v-for="(hex, index) in model.palette?.colors" :key="index" :style="{ background: hex }" :title="hex" /></div>
    <label>项目配色资产<select v-model="savedId" aria-label="项目配色资产" @change="chooseSaved"><option value="">选择项目配色</option><option v-for="item in saved" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <details>
      <summary>创建或编辑配色</summary>
      <label>配色名称<input v-model="paletteName" maxlength="100" aria-label="配色名称" /></label>
      <div class="harmonyEditor">
        <label>配色关系<select v-model="harmonyMode" aria-label="配色关系"><option value="free">自由配色</option><option value="analogous">相似配色</option><option value="complementary">互补配色</option><option value="triadic">三角配色</option></select></label>
        <label v-if="harmonyMode !== 'free'">主色色轮<input v-model="baseColor" type="color" aria-label="主色色轮" /></label>
        <label v-if="harmonyMode !== 'free'">主色 HEX<input v-model="baseColor" maxlength="7" aria-label="主色 HEX" :aria-invalid="!validBaseColor" /></label>
      </div>
      <p v-if="harmonyMode !== 'free' && !validBaseColor" role="alert">请填写完整的主色色值，例如 #336699。</p>
      <div class="colorEditor">
        <label v-for="(color, index) in colors" :key="index">颜色 {{ index + 1 }}<input v-model="colors[index]" type="color" :aria-label="`颜色 ${index + 1}`" @input="freeColors" /><span>{{ color }}</span><el-button :disabled="colors.length <= 1" @click="colors.splice(index, 1); freeColors()">删除颜色</el-button></label>
      </div>
      <p>更换主色或配色关系会更新编辑色板。应用或保存后参与生成，手动改色后转为自由配色。</p>
      <el-button :disabled="colors.length >= 8" @click="colors.push('#808080'); freeColors()">添加颜色</el-button>
      <el-button :disabled="!paletteName.trim() || harmonyMode !== 'free' && !validBaseColor" @click="applyPalette">应用配色到草稿</el-button>
      <el-button :disabled="!paletteName.trim() || harmonyMode !== 'free' && !validBaseColor" @click="savePalette">保存到项目配色资产</el-button>
    </details>
    <details><summary>选用项目视觉参考 · {{ board.length }}</summary><p>沿用故事工作台收藏的具体用途，以文字方法参与生成；不会把电影画面自动当作人物素材。</p><article v-for="item in board" :key="item.frameId"><img :src="item.frame.src" :alt="item.frame.film" loading="lazy" referrerpolicy="no-referrer" /><label><input type="checkbox" :checked="model.references?.some(value => value.frameId === item.frameId)" @change="toggleReference(item, ($event.target as HTMLInputElement).checked)" />{{ item.frame.film }} · {{ item.purpose }} · {{ item.note }}</label></article><p v-for="item in model.references?.filter(value => !board.some(saved => saved.frameId === value.frameId))" :key="item.frameId">已保存快照 {{ item.frameId }} · {{ item.note }}<el-button @click="model.references = model.references?.filter(value => value.frameId !== item.frameId)">移除快照</el-button></p></details>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { z } from "zod";
import { paletteHarmonyColors, visualModifiersSchema, type PaletteHarmony, type VisualModifiers } from "@toonflow/tools-scaffold/runtime";
import { resolveVisualBoard, visualBoardSchema } from "@toonflow/tool-scene-list/visualReference";
import { useNodeFiles } from "../workspaceFiles";
const props = defineProps<{ active: boolean; disabled?: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const model = defineModel<VisualModifiers>({ required: true });
const files = useNodeFiles();
const paletteSchema = visualModifiersSchema.shape.palette.unwrap().safeExtend({ id: z.string().uuid(), colors: z.array(z.string().regex(/^#[\da-f]{6}$/i)).min(1).max(8) });
const librarySchema = z.strictObject({ littoVisualPalettes: z.literal(1), palettes: z.array(paletteSchema).max(128) });
const catalog = ref<{ id: string; name: string; category: string }[]>([]), saved = ref<z.infer<typeof paletteSchema>[]>([]);
const board = ref<ReturnType<typeof resolveVisualBoard>>([]), assetId = ref(""), savedId = ref(""), paletteName = ref(""), colors = ref<string[]>(["#808080"]), busy = ref(false), error = ref("");
const harmonyMode = ref<PaletteHarmony["mode"] | "free">("free"), baseColor = ref("#808080"), harmony = ref<PaletteHarmony>();
const validBaseColor = computed(() => /^#[\da-f]{6}$/i.test(baseColor.value));
const harmonyLabels = { analogous: "相似配色", complementary: "互补配色", triadic: "三角配色" };
watch([harmonyMode, baseColor], generateHarmony);
watch(busy, value => emit("busy", value), { flush: "sync" });
let controller = new AbortController();
onScopeDispose(() => controller.abort());
async function json(path: string, signal = controller.signal) { const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }); const result = await response.json(); if (!response.ok) throw new Error(result.message || "读取视觉资产失败"); return result.data; }
async function load() {
  controller.abort(); const current = new AbortController(); controller = current; error.value = ""; busy.value = true;
  assetId.value = ""; savedId.value = "";
  try {
    const workspace = files.getWorkspaceFiles(), { directory, entries } = await workspace.list();
    const [assets, project] = await Promise.all([json("/api/ai/media/visualAssets", current.signal), json(`/api/story/get?directory=${encodeURIComponent(directory)}`, current.signal)]);
    current.signal.throwIfAborted(); catalog.value = assets; board.value = resolveVisualBoard(visualBoardSchema.parse(project.visualBoard));
    saved.value = entries.some(item => item.name === "visualPalettes.json") ? librarySchema.parse(await workspace.readJson("visualPalettes.json")).palettes : [];
    current.signal.throwIfAborted(); setPaletteFields(model.value.palette);
    const matches = saved.value.filter(item => item.name === model.value.palette?.name && JSON.stringify(item.colors) === JSON.stringify(model.value.palette.colors));
    if (matches.length === 1) savedId.value = matches[0]!.id;
  } catch (cause) { if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (controller === current) busy.value = false; }
}
watch(() => props.active, active => { if (active) void load(); else controller.abort(); }, { immediate: true });
watch(() => model.value.palette, palette => { if (!palette) { assetId.value = ""; savedId.value = ""; setPaletteFields(); } });
function setPaletteFields(palette?: VisualModifiers["palette"]) {
  paletteName.value = palette?.name ?? ""; colors.value = [...(palette?.colors.slice(0, 8) ?? ["#808080"])];
  harmony.value = palette?.harmony; harmonyMode.value = palette?.harmony?.mode ?? "free"; baseColor.value = palette?.harmony?.base ?? colors.value[0]!;
}
function freeColors() { harmony.value = undefined; harmonyMode.value = "free"; baseColor.value = colors.value[0]!; }
function generateHarmony() {
  if (harmonyMode.value === "free") { harmony.value = undefined; return; }
  if (!validBaseColor.value) return;
  harmony.value = { mode: harmonyMode.value, base: baseColor.value.toUpperCase() };
  colors.value = paletteHarmonyColors(harmony.value);
}
function currentPalette() { return visualModifiersSchema.shape.palette.unwrap().parse({ name: paletteName.value, colors: colors.value, harmony: harmony.value }); }
function applyPalette() {
  try {
    const palette = currentPalette(); model.value.palette = palette;
    model.value.color = `自建配色「${palette.name}」${palette.harmony ? `（${harmonyLabels[palette.harmony.mode]}）` : ""}：${palette.colors.join("、")}。保持人物自然肤色、光源关系与资产识别色。`;
    error.value = "";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
async function chooseAsset() {
  if (!assetId.value) return;
  busy.value = true; error.value = "";
  try {
    const asset = await json(`/api/ai/media/visualAssets?id=${encodeURIComponent(assetId.value)}`);
    savedId.value = ""; model.value.palette = { name: asset.name, colors: asset.colors }; model.value.color = asset.instruction; setPaletteFields(model.value.palette);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
function chooseSaved() { const asset = saved.value.find(item => item.id === savedId.value); if (asset) { assetId.value = ""; setPaletteFields(asset); applyPalette(); } }
async function savePalette() {
  busy.value = true; error.value = "";
  try {
    const asset = paletteSchema.parse({ ...currentPalette(), id: savedId.value || crypto.randomUUID() });
    const workspace = files.getWorkspaceFiles(), { entries } = await workspace.list();
    const exists = entries.some(item => item.name === "visualPalettes.json");
    const library = exists ? librarySchema.parse(await workspace.readJson("visualPalettes.json")) : { littoVisualPalettes: 1 as const, palettes: [] };
    const index = library.palettes.findIndex(item => item.id === asset.id);
    if (index < 0) library.palettes.push(asset); else library.palettes[index] = asset;
    await workspace.writeJson("visualPalettes.json", librarySchema.parse(library), !exists);
    saved.value = library.palettes; savedId.value = asset.id; applyPalette();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
function toggleReference(item: ReturnType<typeof resolveVisualBoard>[number], selected: boolean) { model.value.references = (model.value.references ?? []).filter(value => value.frameId !== item.frameId); if (selected) model.value.references.push({ frameId: item.frameId, purpose: item.purpose, note: item.note, direction: item.purpose === "composition" ? item.director.composition : item.purpose === "lighting" ? item.director.light : item.director.palette.join("、") }); }
</script>
<style scoped lang="scss">
.visualAssetPicker { display: grid; gap: 12px; label { display: grid; gap: 6px; } .paletteColors { display: flex; span { width: 30px; height: 20px; } } .harmonyEditor { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; margin: 12px 0; input:not([type="color"]) { width: 100px; } } .colorEditor { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; } article { display: flex; gap: 10px; margin: 10px 0; img { width: 90px; height: 60px; object-fit: cover; } label { display: block; } } p { font-size: 12px; line-height: 1.6; } }
</style>
