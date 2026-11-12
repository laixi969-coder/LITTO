<template>
  <section class="characterPicker" aria-label="角色选用" :aria-busy="loading || importing">
    <div class="pickerHeader">
      <div><strong>角色（选填）</strong><span>{{ projectId ? '复用身份和定妆参考' : '可以先写故事，稍后在画布里选角' }}</span></div>
      <el-button :disabled="disabled || importing" :aria-expanded="expanded" @click="toggleLibrary">{{ expanded ? '收起角色库' : '从角色资产库选择' }}</el-button>
    </div>
    <ul v-if="selections.length" class="selectedCast" aria-label="已选角色">
      <li v-for="selection in selections" :key="selection.libraryId">
        <img v-if="selection.imageUrl" :src="selection.imageUrl" alt="" />
        <div class="castRole"><strong>{{ selection.actorName }}</strong><el-input :modelValue="selection.roleName" :aria-label="`${selection.actorName} 饰演的人物`" placeholder="饰演的人物（可选）" :maxlength="120" :disabled="disabled || importing" @update:modelValue="setRole(selection.libraryId, $event)" /></div>
        <el-button text :disabled="disabled || importing" :aria-label="`移除角色 ${selection.actorName}`" @click="removeCharacter(selection.libraryId)">移除</el-button>
      </li>
    </ul>
    <div v-if="expanded" class="pickerBody">
      <div class="pickerFilters">
        <el-input v-model="query" clearable :maxlength="120" placeholder="搜索角色名称或描述" aria-label="搜索角色资产" :disabled="importing" />
        <el-checkbox v-model="favoritesOnly" :disabled="importing">只看收藏</el-checkbox>
        <el-button :loading="loading" :disabled="importing" @click="loadLibrary">刷新</el-button>
      </div>
      <p v-if="error" class="pickerError" role="alert">{{ error }}</p>
      <p v-if="loading" role="status">正在读取角色资产…</p>
      <div v-else class="characterGrid">
        <article v-for="character in filteredCharacters" :key="character.id" :class="{ selected: isSelected(character.id) }">
          <el-image v-if="character.media" :src="mediaUrl(character.media.url)" :alt="character.name" :previewSrcList="(character.images?.length ? character.images : [character.media]).map(image => mediaUrl(image.url))" previewTeleported fit="contain" loading="lazy" />
          <label class="characterChoice"><input type="checkbox" :checked="isSelected(character.id)" :disabled="disabled || importing || existingIds.includes(character.id)" @change="toggleCharacter(character)" /><span>{{ character.name }}</span><small v-if="existingIds.includes(character.id)">已在本项目</small></label>
          <p v-if="character.description" :title="character.description">{{ character.description }}</p>
        </article>
      </div>
      <p v-if="!loading && !error && !filteredCharacters.length" class="pickerHint">{{ characters.length ? '没有匹配的角色，请调整搜索或筛选。' : '角色库还没有角色。可在项目的资产库中上传或生成定妆图，采用并收藏后复用。' }}</p>
    </div>
    <div v-if="selections.length" class="pickerFooter">
      <span role="status">已选 {{ selections.length }} 位角色{{ projectId ? '' : '，开始创作时带入项目' }}</span>
      <el-button v-if="projectId" type="primary" :loading="importing" :disabled="disabled" @click="importSelection">加入本项目</el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { cloudRequest, isAuthDisabled } from "@/lib/session";
import { importCharacters, type CharacterSelection, type LibraryCharacter } from "@/lib/characterAssets";

const props = withDefaults(defineProps<{ disabled?: boolean; projectId?: string; existingIds?: string[] }>(), { existingIds: () => [] });
const selections = defineModel<CharacterSelection[]>({ default: () => [] });
const emit = defineEmits<{ imported: []; busy: [value: boolean] }>();
const expanded = ref(false), loading = ref(false), importing = ref(false), error = ref("");
const characters = ref<LibraryCharacter[]>([]), query = ref(""), favoritesOnly = ref(false);
let loaded = false;
const mediaUrl = (url: string) => url.startsWith("/") ? `/cloud${url}` : url;
const filteredCharacters = computed(() => characters.value.filter(character => (!favoritesOnly.value || character.favorite) && `${character.name} ${character.description ?? ""}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const isSelected = (id: string) => props.existingIds.includes(id) || selections.value.some(selection => selection.libraryId === id);
function removeCharacter(id: string) { selections.value = selections.value.filter(selection => selection.libraryId !== id); }
function setRole(id: string, roleName: string) { selections.value = selections.value.map(selection => selection.libraryId === id ? { ...selection, roleName } : selection); }
function toggleCharacter(character: LibraryCharacter) {
  if (isSelected(character.id)) return removeCharacter(character.id);
  if (selections.value.length >= 20) { error.value = "每次最多选用 20 位角色"; return; }
  error.value = "";
  selections.value = [...selections.value, { libraryId: character.id, actorName: character.name, roleName: "", imageUrl: character.media ? mediaUrl(character.media.url) : "" }];
}
async function toggleLibrary() {
  expanded.value = !expanded.value;
  if (expanded.value && !loaded) await loadLibrary();
}
async function loadLibrary() {
  if (loading.value) return;
  loading.value = true; error.value = "";
  try {
    if (isAuthDisabled()) throw new Error("跨项目角色库需要账号工作区，请登录后选择角色。");
    characters.value = await cloudRequest<LibraryCharacter[]>("/library/assets?type=Character&limit=500");
    loaded = true;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "角色库读取失败，请刷新重试"; }
  finally { loading.value = false; }
}
async function importSelection() {
  if (!props.projectId || importing.value || props.disabled) return;
  importing.value = true; error.value = ""; emit("busy", true);
  try {
    await importCharacters(props.projectId, selections.value);
    selections.value = [];
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "角色导入失败，已选角色保留，可重试"; expanded.value = true; }
  finally { importing.value = false; emit("busy", false); emit("imported"); }
}
</script>

<style scoped lang="scss">
.characterPicker {
  margin: 16px 0;
  padding: 16px;
  border: 1px solid var(--studioBorder);
  border-radius: var(--ui-radius);
  color: var(--studioInk);
  .pickerHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; > div { display: grid; gap: 4px; span { color: var(--studioMuted); font-size: 12px; line-height: 1.6; } } .el-button { min-height: 40px; } }
  .selectedCast { display: grid; gap: 10px; margin: 16px 0 0; padding: 0; list-style: none; li { display: flex; align-items: center; gap: 12px; img { width: 48px; height: 64px; object-fit: contain; border-radius: 4px; background: var(--studioSurface); } .castRole { flex: 1; min-width: 0; display: grid; gap: 6px; strong { font-size: 13px; overflow-wrap: anywhere; } } } }
  .pickerBody {
    margin-top: 16px;
    .pickerFilters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; .el-input { flex: 1; min-width: 160px; } .el-button { margin: 0; } }
    .pickerError { color: var(--el-color-danger); font-size: 13px; }
    .pickerHint { color: var(--studioMuted); font-size: 13px; line-height: 1.7; }
    .characterGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; max-height: 360px; overflow-y: auto; margin-top: 12px; article { padding: 8px; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); &.selected { border-color: var(--studioDone); background: var(--el-color-primary-light-9); } .el-image { display: block; width: 100%; height: 150px; background: var(--studioSurface); } .characterChoice { display: flex; align-items: center; gap: 6px; min-height: 44px; cursor: pointer; font-size: 13px; overflow-wrap: anywhere; input { accent-color: var(--studioDone); } small { color: var(--studioMuted); } } p { margin: 0; font-size: 12px; color: var(--studioMuted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; } } }
  }
  .pickerFooter { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 12px; font-size: 12px; color: var(--studioMuted); }
}
</style>
