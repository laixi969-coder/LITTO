<template>
  <section v-if="visible" class="canvasCharacters nowheel nopan nodrag" aria-label="画布选角" :aria-busy="busy || loading" @click.stop @pointerdown.stop>
    <header><strong>画布选角</strong><el-button text :disabled="busy || importing" aria-label="关闭画布选角" @click="visible = false">关闭</el-button></header>
    <p class="castingHint">{{ target ? `当前镜头：${target.data.label || '未命名镜头'}` : '选中一个图片生成节点，在这里安排出镜角色；也可先将角色加入项目备用。' }}</p>
    <p v-if="videoKeyframe" class="castingHint">正在为视频的图片关键帧选角，视频会沿用该关键帧中的人物。</p>
    <p v-if="error" class="castingError" role="alert">{{ error }}</p>
    <p v-if="message" class="castingHint" role="status">{{ message }}</p>
    <p v-if="loading" role="status">正在读取本项目角色…</p>
    <template v-else>
      <p v-if="target" class="castingHint">已关联：{{ linkedNames || '尚未选角' }}</p>
      <div v-if="characters.length" class="projectCharacters">
        <label v-for="character in characters" :key="character.id">
          <img v-if="portraits[character.attributes?.authoritativeReference ?? '']" :src="mediaUrl(portraits[character.attributes?.authoritativeReference ?? '']!.url)" alt="" />
          <input v-model="chosenIds" type="checkbox" :value="character.id" :disabled="!target || busy || importing || target.data.generationPending" />
          <span>{{ character.name }}</span>
        </label>
      </div>
      <el-button v-if="target" type="primary" :loading="busy" :disabled="loading || importing || !!target.data.generationPending" @click="applyCharacters">应用到当前镜头</el-button>
      <p v-if="target?.data.generationPending" class="castingHint">当前镜头正在生成，完成或停止后可调整角色。</p>
      <details class="uploadCharacter"><summary>上传或关联角色图片</summary>
        <label>关联到角色<select v-model="uploadAssetId" :disabled="busy || importing"><option value="">新建角色</option><option v-for="character in characters" :key="character.id" :value="character.id">{{ character.name }}</option></select></label>
        <el-input v-if="!uploadAssetId" v-model="uploadName" :maxlength="120" placeholder="角色名称" aria-label="上传角色名称" :disabled="busy || importing" />
        <p class="castingHint">一次选择同一人物的照片。新角色以首张作为主参考；补充已有角色时保留原主参考。</p>
        <label class="uploadButton">上传角色图片<input type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="上传角色参考图片" :disabled="busy || importing || !uploadAssetId && !uploadName.trim()" @change="uploadCharacterFiles" /></label>
        <el-button v-if="selectedNode?.type === 'remote-imageNode' && selectedNode.data.outputs?.image?.value" :disabled="busy || importing || !uploadAssetId && !uploadName.trim()" @click="useCanvasImage">关联画布中选中的图片</el-button>
      </details>
      <characterPicker v-model="librarySelection" :projectId="projectId" :existingIds="importedIds" :disabled="busy || loading" @busy="importing = $event" @imported="refreshImported" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElMessageBox } from "element-plus";
import axios from "axios";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/workspaceFiles";
import { cloudRequest } from "@/lib/session";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import characterPicker from "@/components/characterPicker.vue";
import type { CharacterSelection } from "@/lib/characterAssets";

type Character = { id: string; name: string; type: string; attributes?: { authoritativeReference?: string; importedFrom?: string } };
type AssetImage = { id: string; url: string; mime: string };
type Shot = { id: string; projectId: string; assetIds: string[]; visibleAssetIds?: string[]; updatedAt?: string; heroKeyframeId?: string; approvedTakeId?: string };
const props = defineProps<{ projectId: string; directory: string; availableNodes: { type: string }[]; batchHistory: (action: () => Promise<void>) => Promise<void>; getSignal: () => AbortSignal }>();
const visible = defineModel<boolean>({ default: false });
const flow = useVueFlow();
const characters = ref<Character[]>([]), images = ref<AssetImage[]>([]), chosenIds = ref<string[]>([]), linkedIds = ref<string[]>([]);
const librarySelection = ref<CharacterSelection[]>([]), busy = ref(false), loading = ref(false), importing = ref(false), error = ref(""), message = ref("");
const uploadName = ref(""), uploadAssetId = ref("");
const selectedNode = computed(() => flow.getSelectedNodes.value.length === 1 ? flow.getSelectedNodes.value[0] : undefined);
const videoKeyframe = computed(() => {
  const node = selectedNode.value;
  if (node?.type !== "remote-videoGenerationNode" || node.data.production?.shotId) return;
  const edges = flow.edges.value.filter(edge => edge.target === node.id && edge.targetHandle === "in" && flow.findNode(edge.source)?.type === "remote-imageGenerationNode");
  return edges.length === 1 ? flow.findNode(edges[0]!.source) : undefined;
});
const target = computed(() => videoKeyframe.value ?? (selectedNode.value && ["remote-imageGenerationNode", "remote-videoGenerationNode"].includes(selectedNode.value.type ?? "") && (selectedNode.value.type === "remote-imageGenerationNode" || selectedNode.value.data.production?.shotId) ? selectedNode.value : undefined));
const portraits = computed(() => Object.fromEntries(images.value.map(image => [image.id, image])));
const importedIds = computed(() => characters.value.flatMap(character => character.attributes?.importedFrom ? [character.attributes.importedFrom] : []));
const linkedNames = computed(() => characters.value.filter(character => linkedIds.value.includes(character.id)).map(character => character.name).join("、"));
const mediaUrl = (url: string) => url.startsWith("/") ? `/cloud${url}` : url;
let revision = 0;
onScopeDispose(() => { revision++; });
async function loadCharacters() {
  const [assets, media] = await Promise.all([cloudRequest<Character[]>(`/projects/${encodeURIComponent(props.projectId)}/assets`), cloudRequest<AssetImage[]>(`/projects/${encodeURIComponent(props.projectId)}/assetImages`)]);
  characters.value = assets.filter(asset => asset.attributes?.authoritativeReference && asset.type === "Character");
  images.value = media;
}
async function refreshImported() {
  const previous = new Set(characters.value.map(character => character.id));
  try { await loadCharacters(); chosenIds.value = [...new Set([...chosenIds.value, ...characters.value.filter(character => !previous.has(character.id)).map(character => character.id)])]; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "角色读取失败"; }
}
async function readLinked() {
  const request = ++revision, node = target.value;
  loading.value = true; error.value = ""; message.value = "";
  try {
    await loadCharacters();
    const shotId = node?.data.production?.shotId;
    const shot = shotId ? await cloudRequest<Shot>(`/shots/${encodeURIComponent(shotId)}`) : undefined;
    if (request !== revision) return;
    const ids = shot ? shot.visibleAssetIds ?? shot.assetIds : node ? flow.edges.value.filter(edge => edge.target === node.id && edge.targetHandle === "in").map(edge => flow.findNode(edge.source)?.data.characterAssetId).filter(Boolean) : [];
    linkedIds.value = ids.filter((id: string) => characters.value.some(character => character.id === id));
    chosenIds.value = [...linkedIds.value];
  } catch (cause) { if (request === revision) error.value = cause instanceof Error ? cause.message : "角色读取失败"; }
  finally { if (request === revision) loading.value = false; }
}
watch([visible, () => target.value?.id], ([opened]) => { if (opened) void readLinked(); else revision++; });
async function uploadCharacterFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  await registerPhotos(files);
}
async function useCanvasImage() {
  const node = selectedNode.value, image = node?.data.outputs?.image?.value;
  if (!node || !image || busy.value) return;
  try {
    const bytes = await useWorkspaceFiles(props.directory).read(image.url);
    await registerPhotos([new File([bytes], "角色参考", { type: image.mimeType })], node.id);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "画布图片读取失败"; }
}
async function registerPhotos(files: File[], sourceNodeId?: string) {
  if (!files.length || busy.value || importing.value) return;
  const assetId = uploadAssetId.value, name = uploadName.value.trim(), signal = props.getSignal();
  busy.value = true; error.value = ""; message.value = "";
  try {
    if (!assetId && !name) throw new Error("请填写角色名称");
    if (!assetId && characters.value.some(character => character.name === name)) throw new Error("已有同名角色，请在“关联到角色”中选择它");
    if (files.length > 15 || files.some(file => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 100 * 1024 * 1024)) throw new Error("请选择最多 15 张 PNG、JPG 或 WEBP 图片，单张不超过 100 MB");
    const existing = assetId ? await cloudRequest<Character & { references: string[]; invariants: string[] }>(`/assets/${encodeURIComponent(assetId)}`) : undefined;
    const references: string[] = [], mediaIds: string[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      const response = await fetch(`/cloud/media?projectId=${encodeURIComponent(props.projectId)}`, { method: "POST", headers: { "Content-Type": file.type, "x-milimili-csrf": "1" }, body: file, signal });
      const media = await response.json();
      if (!response.ok) throw new Error(media.error || "图片上传失败");
      mediaIds.push(media.id);
      const reference = await cloudRequest<{ id: string }>(`/projects/${encodeURIComponent(props.projectId)}/references`, "POST", { kind: "image", name: existing?.name ?? name, mediaId: media.id });
      references.push(reference.id);
    }
    signal.throwIfAborted();
    const asset = await cloudRequest<Character>(existing ? `/assets/${encodeURIComponent(assetId)}/versions` : `/projects/${encodeURIComponent(props.projectId)}/assets`, "POST", {
      ...(existing ? {} : { type: "Character", name }),
      references: [...new Set([...(existing?.references ?? []), ...references])],
      attributes: { ...(existing?.attributes ?? {}), authoritativeReference: existing?.attributes?.authoritativeReference || mediaIds[0] },
      invariants: existing?.invariants?.length ? existing.invariants : ["保持用户所选角色参考图中的同一人物身份与面部特征"],
    });
    await cloudRequest(`/assets/${encodeURIComponent(asset.id)}/approve`, "POST", {});
    if (sourceNodeId) {
      const source = flow.findNode(sourceNodeId);
      if (source) { source.data.characterAssetId = asset.id; source.data.characterReferenceId = mediaIds[0]; }
    }
    await loadCharacters();
    chosenIds.value = [...new Set([...chosenIds.value, asset.id])];
    uploadName.value = "";
    message.value = `已将 ${files.length} 张照片关联到角色“${asset.name}”${target.value ? '，点击“应用到当前镜头”完成选角' : '，可用于后续镜头'}。`;
    window.dispatchEvent(new Event("milimiliProductionUpdated"));
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "角色图片关联失败"; }
  finally { busy.value = false; }
}
async function applyCharacters() {
  const node = target.value;
  if (!node || busy.value || loading.value || importing.value || node.data.generationPending) return;
  const signal = props.getSignal(), files = useWorkspaceFiles(props.directory), chosen = [...chosenIds.value];
  busy.value = true; error.value = ""; message.value = "";
  try {
    signal.throwIfAborted();
    if (node.data.production?.shotId) {
      const shot = await cloudRequest<Shot>(`/shots/${encodeURIComponent(node.data.production.shotId)}`);
      if (shot.projectId !== props.projectId) throw new Error("镜头不属于当前项目，未修改角色");
      const characterIds = new Set(characters.value.map(character => character.id));
      const visibleAssetIds = [...new Set([...(shot.visibleAssetIds ?? shot.assetIds).filter(id => !characterIds.has(id)), ...chosen])];
      if (JSON.stringify(visibleAssetIds) !== JSON.stringify(shot.visibleAssetIds ?? shot.assetIds)) {
        if (shot.heroKeyframeId || shot.approvedTakeId) await ElMessageBox.confirm("调整出镜角色会使已采用画面的检查记录过期，原有画面保留。", "调整镜头角色", { confirmButtonText: "应用角色", cancelButtonText: "取消" });
        signal.throwIfAborted();
        await cloudRequest(`/shots/${encodeURIComponent(shot.id)}`, "PATCH", { assetIds: [...new Set([...shot.assetIds, ...chosen])], visibleAssetIds, expectedUpdatedAt: shot.updatedAt, confirm: !!(shot.heroKeyframeId || shot.approvedTakeId) });
      }
      linkedIds.value = chosen;
      window.dispatchEvent(new Event("milimiliProductionUpdated"));
      message.value = "出镜角色已保存，原有画面保留。";
      const [providerId, modelId] = JSON.parse(node.data.model || "[]");
      const kind = node.type === "remote-videoGenerationNode" ? "video" : "image";
      // 只刷新本节点的编译配置，不带 requestId，不提交生成任务。
      try {
        if (!providerId || !modelId) throw new Error("请先选择本节点的生成模型");
        const request = { providerId, modelId, ratio: node.data.ratio, ...(kind === "image" ? { size: node.data.size } : { mode: node.data.mode ? JSON.parse(node.data.mode) : undefined, resolution: node.data.resolution, duration: node.data.duration, generateAudio: node.data.generateAudio, cameraTrajectory: node.data.cameraTrajectory, imageAndCameraOnly: node.data.imageAndCameraOnly }) };
        const response = await axios.post<{ data: { fingerprint: string; request: { prompt?: string } } }>("/api/ai/media/production", { directory: props.directory, shotId: shot.id, kind, request }, { signal });
        signal.throwIfAborted();
        node.data.production = { shotId: shot.id, productionFingerprint: response.data.data.fingerprint };
        if (response.data.data.request.prompt) node.data.prompt = response.data.data.request.prompt;
        message.value += "生成配置已刷新。";
      } catch (cause) { message.value += `生成配置待刷新：${axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data.message || cause.message : cause instanceof Error ? cause.message : String(cause)}。`; }
    } else {
      if (!props.availableNodes.some(item => item.type === "remote-imageNode")) throw new Error("基础图片节点尚未就绪，请稍后再试");
      await props.batchHistory(async () => {
        const sources: string[] = [];
        for (const [index, assetId] of chosen.entries()) {
          const character = characters.value.find(character => character.id === assetId)!;
          const image = portraits.value[character.attributes!.authoritativeReference!];
          if (!image) throw new Error(`${character.name} 的定妆参考不可用，请重新选择`);
          let source = flow.getNodes.value.find(item => item.type === "remote-imageNode" && item.data.characterAssetId === assetId && item.data.characterReferenceId === image.id);
          if (!source) {
            const response = await fetch(mediaUrl(image.url), { signal });
            if (!response.ok) throw new Error(`${character.name} 的参考图读取失败`);
            const blob = await response.blob(), id = crypto.randomUUID();
            const mimeType = blob.type || image.mime;
            const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
            const path = await uploadNodeFile(files, id, new File([blob], `character.${extension}`, { type: mimeType }));
            signal.throwIfAborted();
            const sourceNode = { id, type: "remote-imageNode", position: { x: node.position.x - 360, y: node.position.y + index * 220 }, ...(node.parentNode ? { parentNode: node.parentNode } : {}), data: { label: `${character.name} · 角色参考`, characterAssetId: assetId, characterReferenceId: image.id, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: blob.type || image.mime } } } } };
            flow.addNodes(sourceNode);
            source = flow.findNode(id)!;
          }
          sources.push(source.id);
        }
        signal.throwIfAborted();
        flow.removeEdges(flow.edges.value.filter(edge => edge.target === node.id && edge.targetHandle === "in" && flow.findNode(edge.source)?.data.characterAssetId && !sources.includes(edge.source)));
        for (const source of sources) if (!flow.edges.value.some(edge => edge.target === node.id && edge.targetHandle === "in" && edge.source === source && edge.sourceHandle === "image")) flow.addEdges({ id: crypto.randomUUID(), source, sourceHandle: "image", target: node.id, targetHandle: "in" });
      });
      linkedIds.value = chosen;
      message.value = "角色定妆参考已连接到当前图片节点，生成时会随请求发送。";
    }
  } catch (cause) { if (cause !== "cancel" && cause !== "close") error.value = cause instanceof Error ? cause.message : "角色关联失败"; }
  finally { busy.value = false; if (target.value?.id !== node.id) void readLinked(); }
}
</script>

<style scoped lang="scss">
.canvasCharacters {
  position: absolute; top: 112px; right: 16px; z-index: 8; width: min(360px, calc(100% - 32px)); max-height: calc(100% - 190px); overflow: auto; box-sizing: border-box; padding: 16px; background: var(--studioSurface); border: 1px solid var(--studioBorder); border-radius: var(--ui-radius-large); box-shadow: var(--studioShadow);
  header { position: sticky; top: -16px; z-index: 1; background: var(--studioSurface); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .castingHint { font-size: 12px; line-height: 1.7; color: var(--studioMuted); overflow-wrap: anywhere; }
  .castingError { font-size: 13px; color: var(--el-color-danger); }
  .uploadCharacter { margin-top: 16px; summary { cursor: pointer; padding: 10px 0; } label { display: grid; gap: 8px; margin: 10px 0; font-size: 13px; } select { width: 100%; padding: 8px; background: var(--studioSurface); color: var(--studioInk); border: 1px solid var(--studioBorder); } input[type="file"] { max-width: 100%; } }
  .projectCharacters { display: grid; gap: 8px; margin: 12px 0; label { display: flex; align-items: center; gap: 10px; min-height: 48px; cursor: pointer; img { width: 40px; height: 52px; object-fit: contain; } input { accent-color: var(--studioDone); } span { font-size: 13px; overflow-wrap: anywhere; } } }
}
</style>
