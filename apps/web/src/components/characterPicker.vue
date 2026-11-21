<template>
  <section class="characterPicker" aria-label="角色选用" :aria-busy="loading || busy">
    <div v-if="!alwaysOpen" class="pickerHeader">
      <strong>角色库</strong>
      <el-button :disabled="disabled || busy" :aria-expanded="expanded" @click="opened = !opened">{{ expanded ? '收起角色库' : '选择角色' }}</el-button>
    </div>
    <ul v-if="selections.length" class="selectedCast" aria-label="已选角色">
      <li v-for="selection in selections" :key="selection.libraryId">
        <img v-if="selection.imageUrl" :src="selection.imageUrl" alt="" />
        <div class="castRole"><strong>{{ selection.actorName }}</strong><el-input :modelValue="selection.roleName" :aria-label="`${selection.actorName} 饰演的人物`" placeholder="饰演的人物（可选）" :maxlength="120" :disabled="disabled || busy" @update:modelValue="setRole(selection.libraryId, $event)" /></div>
        <el-button text :disabled="disabled || busy" :aria-label="`移除角色 ${selection.actorName}`" @click="removeCharacter(selection.libraryId)">移除</el-button>
      </li>
    </ul>
    <div v-if="expanded" class="pickerBody">
      <div class="pickerTools">
        <el-input v-model="query" clearable :maxlength="120" placeholder="搜索角色名称或描述" aria-label="搜索角色" :disabled="busy" />
        <el-button v-if="editable" :disabled="disabled || busy || !!editor" @click="openEditor()">添加角色</el-button>
      </div>
      <div class="pickerFilters">
        <label>性别<select v-model="genderFilter" aria-label="性别" :disabled="busy"><option value="">全部性别</option><option v-for="item in castingGenders" :key="item">{{ item }}</option><option>未标注</option></select></label>
        <label>年龄段<select v-model="ageFilter" aria-label="年龄段" :disabled="busy"><option value="">全部年龄段</option><option v-for="item in castingAgeGroups" :key="item" :value="item">{{ item }}（{{ castingAgeRanges[item] }}）</option><option>未标注</option></select></label>
        <el-checkbox v-model="favoritesOnly" :disabled="busy">只看收藏</el-checkbox>
      </div>
      <div v-if="editor" class="castingEditor" :aria-label="editor === 'new' ? '添加角色' : '编辑角色分类'">
        <strong>{{ editor === 'new' ? '添加角色' : '编辑分类 · ' + editor.name }}</strong>
        <template v-if="editor === 'new'">
          <label>角色名称<input v-model.trim="draftName" :disabled="busy" maxlength="120" /></label>
          <label>定妆图<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="busy" @change="selectPortrait" /></label>
        </template>
        <label>角色性别<select v-model="draftCasting.gender" aria-label="角色性别" :disabled="busy"><option :value="undefined">未标注</option><option v-for="item in castingGenders" :key="item">{{ item }}</option></select></label>
        <label>角色年龄段<select v-model="draftCasting.ageGroup" aria-label="角色年龄段" :disabled="busy"><option :value="undefined">未标注</option><option v-for="item in castingAgeGroups" :key="item" :value="item">{{ item }}（{{ castingAgeRanges[item] }}）</option></select></label>
        <div class="editorActions">
          <el-button :disabled="busy" @click="editor = null; error = ''">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="disabled || importing || (editor === 'new' && (!draftName || !portrait))" @click="saveCharacter">{{ editor === 'new' ? '保存到角色库' : '保存分类' }}</el-button>
        </div>
      </div>
      <p v-if="error || readError" class="pickerError" role="alert">{{ error || readError }} <el-button v-if="readError" text @click="refresh">重新读取</el-button></p>
      <p v-if="notice" class="pickerHint" role="status">{{ notice }}</p>
      <p v-if="loading" class="pickerHint" role="status">正在读取角色…</p>
      <div v-else-if="characters.length" class="characterGrid">
        <article v-for="character in characters" :key="character.id" :class="{ selected: selectedIds.has(character.id) || inProject(character) }">
          <el-image v-if="character.media" :src="mediaUrl(character.media.url)" :alt="character.name" :previewSrcList="(character.images?.length ? character.images : [character.media]).map(image => mediaUrl(image.url))" previewTeleported fit="contain" loading="lazy" />
          <label class="characterChoice"><input type="checkbox" :checked="selectedIds.has(character.id) || inProject(character)" :disabled="!editable || disabled || busy || inProject(character) || !character.media" @change="toggleCharacter(character)" /><strong>{{ character.name }}</strong></label>
          <small>{{ character.attributes?.casting?.gender ?? '性别未标注' }} · {{ character.attributes?.casting?.ageGroup ?? '年龄未标注' }}</small>
          <p v-if="character.description" :title="character.description">{{ character.description }}</p>
          <small v-if="inProject(character)">已在本项目</small>
          <small v-else-if="!character.media">定妆图不可用</small>
          <button v-if="editable" class="editCasting" type="button" :aria-label="`编辑${character.name}的分类`" :disabled="disabled || busy || !!editor" @click="openEditor(character)">编辑分类</button>
        </article>
      </div>
      <p v-else-if="!readError" class="pickerHint">{{ query || genderFilter || ageFilter || favoritesOnly ? '没有匹配的角色，可调整筛选条件。' : '角色库里还没有角色。可上传定妆图，或从项目资产中收藏角色。' }}</p>
    </div>
    <div v-if="selections.length" class="pickerFooter">
      <span role="status">已选 {{ selections.length }} 位角色{{ projectId ? '' : '，开始创作时带入项目' }}</span>
      <el-button v-if="projectId" type="primary" :loading="importing" :disabled="disabled || saving" @click="importSelection">加入本项目</el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { castingAgeGroups, castingAgeRanges, castingGenders, type CharacterCasting } from "@toonflow/tool-media-generation/characterCasting";
import { cloudRequest, getMe, isAuthDisabled } from "@/lib/session";
import { importCharacters, type CharacterSelection, type LibraryCharacter } from "@/lib/characterAssets";

const props = withDefaults(defineProps<{ alwaysOpen?: boolean; disabled?: boolean; projectId?: string; projectAssets?: { id: string; attributes?: { importedFrom?: string } }[] }>(), { projectAssets: () => [] });
const selections = defineModel<CharacterSelection[]>({ default: () => [] });
const emit = defineEmits<{ imported: []; changed: []; busy: [value: boolean] }>();
const opened = ref(false), expanded = computed(() => props.alwaysOpen || opened.value);
const loading = ref(false), importing = ref(false), saving = ref(false);
const busy = computed(() => importing.value || saving.value);
const editable = !isAuthDisabled() && ["OWNER", "ADMIN", "EDITOR"].includes(getMe()?.role ?? "");
const error = ref(""), readError = ref(""), notice = ref("");
const characters = ref<LibraryCharacter[]>([]), query = ref(""), favoritesOnly = ref(false);
const genderFilter = ref(""), ageFilter = ref(""), revision = ref(0);
const editor = shallowRef<"new" | LibraryCharacter | null>(null), draftCasting = ref<CharacterCasting>({}), draftName = ref(""), portrait = shallowRef<File>();
const selectedIds = computed(() => new Set(selections.value.map(item => item.libraryId)));
const localIds = computed(() => new Set(props.projectAssets.map(item => item.id)));
const importedIds = computed(() => new Set(props.projectAssets.map(item => item.attributes?.importedFrom)));
const mediaUrl = (url: string) => url.startsWith("/") ? `/cloud${url}` : url;
const inProject = (character: LibraryCharacter) => importedIds.value.has(character.id) || !!character.sourceAssetId && localIds.value.has(character.sourceAssetId);
const searchParams = computed(() => {
  const params = new URLSearchParams({ type: "Character", limit: "500" });
  if (query.value.trim()) params.set("q", query.value.trim());
  if (genderFilter.value) params.set("gender", genderFilter.value);
  if (ageFilter.value) params.set("ageGroup", ageFilter.value);
  if (favoritesOnly.value) params.set("favorite", "true");
  return params.toString();
});
function refresh() { revision.value++; }
defineExpose({ refresh });
watch([expanded, searchParams, revision], ([open, params], previous, onCleanup) => {
  if (!open) return;
  let active = true;
  loading.value = true; readError.value = "";
  const timer = setTimeout(async () => {
    try {
      if (isAuthDisabled()) throw new Error("请登录账号工作区后使用跨项目角色库。");
      const rows = await cloudRequest<LibraryCharacter[]>(`/library/assets?${params}`);
      if (active) characters.value = rows;
    } catch (cause) {
      if (active) { characters.value = []; readError.value = cause instanceof Error ? cause.message : "角色库读取失败"; }
    } finally { if (active) loading.value = false; }
  }, previous[0] && query.value.trim() ? 160 : 0);
  onCleanup(() => { active = false; clearTimeout(timer); });
}, { immediate: true });
function removeCharacter(id: string) { selections.value = selections.value.filter(selection => selection.libraryId !== id); }
function setRole(id: string, roleName: string) { selections.value = selections.value.map(selection => selection.libraryId === id ? { ...selection, roleName } : selection); }
function toggleCharacter(character: LibraryCharacter) {
  if (selectedIds.value.has(character.id)) return removeCharacter(character.id);
  if (selections.value.length >= 20) { error.value = "每次最多选用 20 位角色"; return; }
  error.value = ""; notice.value = "";
  selections.value = [...selections.value, { libraryId: character.id, actorName: character.name, roleName: "", imageUrl: character.media ? mediaUrl(character.media.url) : "" }];
}
function openEditor(character?: LibraryCharacter) {
  editor.value = character ?? "new";
  draftName.value = character?.name ?? ""; portrait.value = undefined;
  draftCasting.value = { ...character?.attributes?.casting };
  error.value = ""; notice.value = "";
}
function selectPortrait(event: Event) { portrait.value = (event.target as HTMLInputElement).files?.[0]; }
async function saveCharacter() {
  if (!editor.value || busy.value || props.disabled) return;
  const creating = editor.value === "new";
  saving.value = true; error.value = ""; notice.value = ""; emit("busy", true);
  try {
    if (editor.value === "new") {
      if (!draftName.value || !portrait.value) throw new Error("请填写名称并选择定妆图");
      const params = new URLSearchParams({ name: draftName.value });
      if (draftCasting.value.gender) params.set("gender", draftCasting.value.gender);
      if (draftCasting.value.ageGroup) params.set("ageGroup", draftCasting.value.ageGroup);
      await cloudRequest(`/library/characters?${params}`, "POST", portrait.value);
      query.value = draftName.value; genderFilter.value = ""; ageFilter.value = "";
    } else {
      await cloudRequest(`/library/assets/${encodeURIComponent(editor.value.id)}/casting`, "PUT", draftCasting.value);
    }
    notice.value = creating ? `已将「${draftName.value}」加入角色库` : `已保存「${draftName.value}」的分类`;
    editor.value = null; refresh(); emit("changed");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "角色保存失败，请重试"; }
  finally { saving.value = false; emit("busy", false); }
}
async function importSelection() {
  if (!props.projectId || busy.value || props.disabled) return;
  importing.value = true; error.value = ""; notice.value = ""; emit("busy", true);
  try {
    const cast = await importCharacters(props.projectId, selections.value);
    notice.value = `已加入本项目：${cast.map(item => item.roleName).join("、")}`;
    selections.value = [];
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "角色导入失败，已选角色保留，可重试"; opened.value = true; }
  finally { importing.value = false; emit("busy", false); emit("imported"); }
}
</script>

<style scoped lang="scss">
.characterPicker {
  min-width: 0; color: var(--studioInk);
  .pickerHeader, .pickerTools, .pickerFooter, .editorActions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .pickerHeader { padding: 12px 0; strong { font-size: 15px; } }
  .selectedCast { display: grid; gap: 10px; margin: 8px 0 16px; padding: 0; list-style: none; li { display: flex; align-items: center; gap: 12px; img { width: 48px; height: 60px; object-fit: contain; border-radius: 4px; background: var(--studioSurface); } .castRole { flex: 1; min-width: 0; display: grid; gap: 4px; font-size: 13px; overflow-wrap: anywhere; } } }
  .pickerBody {
    .pickerTools { .el-input { flex: 1; min-width: min(150px, 100%); } .el-button { margin: 0; } }
    .pickerFilters, .castingEditor { display: flex; align-items: end; flex-wrap: wrap; gap: 10px 16px; margin-top: 12px;
      label { display: grid; gap: 4px; min-width: 0; font-size: 12px; color: var(--studioMuted); }
      select, input { max-width: 100%; min-height: 36px; padding: 4px 8px; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); background: var(--studioSurface); color: var(--studioInk); font: inherit; }
    }
    .castingEditor { padding: 14px; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius); > strong { width: 100%; } .editorActions { margin-left: auto; } }
    .pickerError { color: var(--el-color-danger); font-size: 13px; }
    .pickerHint { color: var(--studioMuted); font-size: 13px; line-height: 1.7; }
    .characterGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(145px, 100%), 1fr)); gap: 12px; max-height: 50vh; overflow: auto; margin-top: 14px;
      article { min-width: 0; padding: 8px; border: 1px solid var(--studioBorder); border-radius: var(--ui-radius);
        &.selected { border-color: var(--studioDone); background: var(--el-color-primary-light-9); }
        .el-image { display: block; width: 100%; height: 145px; background: var(--studioSurface); }
        .characterChoice { display: flex; align-items: center; gap: 6px; min-height: 40px; cursor: pointer; font-size: 13px; overflow-wrap: anywhere; input { accent-color: var(--studioDone); } }
        small, p { display: block; margin: 2px 0 4px; color: var(--studioMuted); font-size: 12px; }
        p { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .editCasting { min-height: 32px; padding: 0 4px; border: 0; background: transparent; color: var(--el-color-primary); font: inherit; font-size: 12px; cursor: pointer; }
      }
    }
  }
  .pickerFooter { margin-top: 12px; color: var(--studioMuted); font-size: 13px; }
}
</style>
