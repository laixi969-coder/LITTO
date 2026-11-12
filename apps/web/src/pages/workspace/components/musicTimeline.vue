<template>
  <section class="musicTimeline" aria-label="音乐与镜头联动">
    <h3>音乐时间轴</h3><p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <fieldset :disabled="busy">
      <label>原曲<select :value="audioId" @change="changeAudio(($event.target as HTMLSelectElement).value)"><option value="">选择项目音频</option><option v-for="item in audioReferences" :key="item.id" :value="item.mediaId">{{ item.name || item.mediaId }}</option></select></label>
      <label>上传原曲<input type="file" accept="audio/mpeg,audio/wav,audio/x-wav" @change="emit('upload', $event)" /></label>
      <template v-if="audio">
        <audio ref="player" :src="url(audio.url)" controls preload="metadata" @timeupdate="playhead = player?.currentTime ?? 0" />
        <label>原曲时间（秒）<input :value="playhead.toFixed(2)" type="number" min="0" :max="audio.duration" step="0.01" @change="seek(Number(($event.target as HTMLInputElement).value))" /></label>
        <div class="musicShots" :style="{ minHeight: `${Math.max(1, linkedShots.length) * 36}px` }">
          <button v-for="(item, index) in linkedShots" :key="item.id" type="button" :style="{ left: `${100 * item.musicVideo.sourceStart / audio.duration}%`, width: `${100 * item.duration / audio.duration}%`, top: `${index * 36}px` }" :title="`${item.title} · ${item.musicVideo.sourceStart} 秒`" @click="emit('select', item.id)">{{ item.ord + 1 }} · {{ item.title }}</button>
        </div>
        <p>点击段落定位镜头；选择镜头后可从对应原曲起点回听。镜头采用与画布定位继续使用原流程。</p>
        <button type="button" :disabled="!shotsAtTime.length" @click="emit('select', shotsAtTime[0].id)">定位当前时间的镜头</button>
        <template v-if="shot">
          <h4>{{ shot.title }} · 音乐绑定</h4>
          <label>歌曲起点（秒）<input v-model.number="sourceStart" type="number" min="0" :max="audio.duration" step="0.01" /></label>
          <p>对应 {{ (shot.generationDuration ?? shot.duration).toFixed(2) }} 秒生成素材，计划使用 {{ shot.duration }} 秒。</p>
          <label>音画要求<textarea v-model="audioDirection" rows="3" maxlength="8000" /></label>
          <label><input v-model="lipSync" type="checkbox" />画内演唱，需要检查逐字口型</label>
          <button type="button" @click="sourceStart = playhead">使用当前播放时间</button>
          <button type="button" @click="bind">保存原曲与镜头绑定</button>
          <button v-if="bindingDirty" type="button" @click="resetBinding">放弃未保存的绑定修改</button>
          <button type="button" :disabled="shot.musicVideo?.sourceMediaId !== audioId" @click="seek(shot.musicVideo.sourceStart, true)">回听当前镜头</button>
        </template>
        <h4>歌词与段落</h4>
        <label>歌词文件<input type="file" accept=".lrc,.srt,.txt,.json" @change="readLyrics" /></label>
        <label>带时间码歌词<textarea v-model="lyricText" rows="4" maxlength="100000" /></label>
        <button type="button" @click="run(saveLyrics)">保存歌词时间码</button>
        <button v-if="lyricText !== savedText" type="button" @click="lyricText = savedText">放弃未保存的歌词修改</button>
        <ul><li v-for="(cue, index) in cues" :key="index"><button type="button" @click="seek(cue.start, true)">{{ cue.start.toFixed(2) }} 秒 · {{ cue.text }}</button><span>{{ linkedShots.filter(item => cue.start >= item.musicVideo.sourceStart && cue.start < item.musicVideo.sourceStart + item.duration).map(item => item.title).join('、') }}</span></li></ul>
        <button type="button" @click="emit('assemble')">同步镜头与原曲到剪辑</button>
      </template>
    </fieldset>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { z } from "zod";
import { parseLyrics, type LyricCue } from "@/lib/musicAnalysis";
import useWorkspaceFiles from "@/lib/workspaceFiles";
const props = defineProps<{ directory: string; references: any[]; shots: any[]; shot: any; active: boolean }>();
const emit = defineEmits<{ select: [id: string]; bind: [value: any]; upload: [event: Event]; assemble: [] }>();
const files = useWorkspaceFiles(props.directory), player = ref<HTMLAudioElement>();
const audioId = ref(""), playhead = ref(0), sourceStart = ref(0), audioDirection = ref(""), lipSync = ref(false), lyricText = ref(""), savedText = ref("");
const error = ref(""), message = ref(""), busy = ref(false), cues = ref<LyricCue[]>([]);
const bindingBase = ref("");
const cueSchema = z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive().optional(), text: z.string().max(5000) })).max(5000);
const savedSchema = z.object({ milimiliMusicTimeline: z.literal(1), mediaId: z.string(), text: z.string().max(100000), cues: cueSchema });
const audioReferences = computed(() => props.references.filter(item => item.kind === "audio" && item.media?.duration > 0));
const audio = computed(() => audioReferences.value.find(item => item.mediaId === audioId.value)?.media);
const linkedShots = computed(() => props.shots.filter(item => item.musicVideo?.audioMode === "sourceTrack" && item.musicVideo.sourceMediaId === audioId.value).sort((a, b) => a.musicVideo.sourceStart - b.musicVideo.sourceStart));
const shotsAtTime = computed(() => linkedShots.value.filter(item => playhead.value >= item.musicVideo.sourceStart && playhead.value < item.musicVideo.sourceStart + item.duration));
const url = (path: string) => path.startsWith("/") ? `/cloud${path}` : path;
const bindingValue = () => JSON.stringify([sourceStart.value, audioDirection.value.trim(), lipSync.value]);
const bindingDirty = computed(() => !!props.shot && bindingValue() !== bindingBase.value);
function assertSaved() {
  if (busy.value || lyricText.value !== savedText.value) throw new Error("请先保存或放弃歌词修改，再切换镜头或关闭面板");
  if (bindingDirty.value) throw new Error("请先保存或放弃音乐绑定修改，再切换镜头或关闭面板");
}
function resetBinding() { sourceStart.value = props.shot?.musicVideo?.sourceStart ?? 0; audioDirection.value = props.shot?.musicVideo?.audioDirection ?? ""; lipSync.value = !!props.shot?.musicVideo?.lipSyncRequired; bindingBase.value = bindingValue(); }
async function run(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ""; try { await action(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { busy.value = false; } }
function pathFor(id: string) { if (!/^[a-zA-Z0-9]+$/.test(id)) throw new Error("音频 ID 无效"); return `musicTimeline${id}.json`; }
async function loadAudio(id: string) {
  player.value?.pause(); audioId.value = id; playhead.value = 0; lyricText.value = ""; savedText.value = ""; cues.value = [];
  if (!id) return;
  const path = pathFor(id), entries = (await files.list()).entries;
  if (!entries.some(entry => entry.path === path)) return;
  const value = savedSchema.parse(await files.readJson(path));
  if (value.mediaId !== id) throw new Error("歌词与原曲不一致");
  lyricText.value = savedText.value = value.text; cues.value = value.cues;
}
function changeAudio(id: string) { void run(async () => { if (lyricText.value !== savedText.value) throw new Error("请先保存当前歌词"); await loadAudio(id); }); }
function seek(time: number, play = false) {
  if (!player.value || !audio.value || !Number.isFinite(time) || time < 0 || time > audio.value.duration) return;
  player.value.currentTime = time; playhead.value = time;
  if (play) void player.value.play().catch(cause => { error.value = cause.message; });
}
function bind() {
  error.value = "";
  const duration = props.shot?.generationDuration ?? props.shot?.duration;
  if (!audio.value || !Number.isFinite(sourceStart.value) || sourceStart.value < 0 || sourceStart.value + duration > audio.value.duration + 0.001 || !audioDirection.value.trim()) { error.value = "请填写音画要求，并确认生成区间没有超出原曲时长"; return; }
  if (props.shot.camera?.design?.timeline && !props.shot.musicVideo) { error.value = "本镜已有动作时间线，请先在镜头规格中完成 MV 时间线转换，避免覆盖已有动作"; return; }
  bindingBase.value = bindingValue();
  emit("bind", { ...props.shot.musicVideo, audioMode: "sourceTrack", sourceMediaId: audioId.value, sourceStart: sourceStart.value, audioDirection: audioDirection.value.trim(), lipSyncRequired: lipSync.value, timeline: props.shot.musicVideo?.timeline ?? [{ start: 0, end: duration, description: props.shot.action }] });
}
async function saveLyrics() {
  if (!audio.value) throw new Error("请选择原曲");
  if (lyricText.value.length > 100000) throw new Error("歌词内容过长");
  const parsed = cueSchema.parse(lyricText.value.trim().startsWith("{") ? JSON.parse(lyricText.value).cues : parseLyrics(lyricText.value));
  if (!parsed.length && lyricText.value.trim()) throw new Error("没有可用时间码，请导入 LRC / SRT 或音乐分析的歌词报告");
  if (parsed.some((cue, i) => cue.start >= audio.value.duration || (cue.end !== undefined && (cue.end <= cue.start || cue.end > audio.value.duration)) || (i > 0 && cue.start < parsed[i - 1]!.start))) throw new Error("歌词时间码须顺序排列且在原曲范围内");
  await files.writeJson(pathFor(audioId.value), { milimiliMusicTimeline: 1, mediaId: audioId.value, text: lyricText.value, cues: parsed });
  cues.value = parsed; savedText.value = lyricText.value; message.value = "歌词时间码已保存，按原曲时间对应镜头";
}
function readLyrics(event: Event) { const input = event.target as HTMLInputElement, file = input.files?.[0]; if (file) void run(async () => { if (file.size > 400000) throw new Error("歌词文件过大"); lyricText.value = await file.text(); await saveLyrics(); input.value = ""; }); }
watch(() => props.shot?.id, () => {
  resetBinding();
  const id = props.shot?.musicVideo?.sourceMediaId;
  if (id && id !== audioId.value) void run(async () => { await loadAudio(id); await nextTick(); seek(sourceStart.value); });
  else if (id) seek(sourceStart.value);
}, { immediate: true });
watch(() => props.active, active => { if (!active) player.value?.pause(); });
onScopeDispose(() => player.value?.pause());
defineExpose({ assertSaved });
</script>
<style scoped lang="scss">
.musicTimeline { fieldset { border: 0; padding: 0; } label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; } input, textarea, select, button { font: inherit; padding: 8px; } input[type="checkbox"] { width: auto; } button { cursor: pointer; } audio { width: 100%; } ul { max-height: 300px; overflow: auto; padding: 0; list-style: none; li { display: flex; gap: 8px; align-items: center; } } .musicShots { position: relative; margin: 12px 0; background: var(--studioSurface); button { position: absolute; min-width: 2px; height: 32px; padding: 4px; overflow: hidden; white-space: nowrap; background: var(--studioDone); color: white; border: 0; } } [role="alert"] { color: var(--el-color-danger); } }
</style>
