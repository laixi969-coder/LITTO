<template>
  <section class="musicAnalysis" aria-label="音乐分析与卡点" :aria-busy="busy">
    <div v-if="progress || busy" class="processStatus" role="status">
      <span>{{ progress }}</span>
      <el-button v-if="busy" @click="cancel">停止处理</el-button>
    </div>
    <p v-if="error" class="errorNotice" role="alert">{{ error }}</p>
    <p v-if="!song" class="emptyHint">可直接粘贴歌词开始创作；上传 MP3 后可分析旋律与节拍。</p>
    <template v-else>
      <div class="songHeader">
        <div><h3>旋律与节拍</h3><p>{{ song?.name }}</p></div>
        <el-button :disabled="disabled || busy" @click="analyze">{{ analysis ? '重新分析' : '分析歌曲' }}</el-button>
      </div>
      <p>本地分析 · 最长 10 分钟 · 不消耗模型额度</p>
      <template v-if="analysis">
        <p>时长 {{ analysis?.duration.toFixed(2) }} 秒 · {{ analysis?.bpm ? `${analysis?.bpm?.toFixed(1)} BPM` : '节拍不确定' }} · {{ analysis?.beats.length }} 个节拍 · {{ analysis?.melody.length }} 个旋律采样点</p>
        <svg v-if="analysis?.melody.length" viewBox="0 0 480 100" role="img" aria-label="旋律候选音高随时间变化图">
          <path :d="melodyPath" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
        <p>旋律图来自音符识别；混音中可能包含伴奏，不等于已分离主唱。节拍是算法估计，须试听校准。</p>
        <p v-for="warning in analysis?.warnings" :key="warning">{{ warning }}</p>
      </template>
    </template>
    <details class="analysisSection">
      <summary>听歌识词 <span class="sectionMeta">{{ speechSource === 'server' ? serverLoading ? '读取配置中' : serverError ? '配置读取失败' : serverSpeech.configured ? '服务器已配置' : '服务器未配置' : '自定义供应商' }}</span></summary>
      <div class="sectionBody">
        <label>转写方式
          <select v-model="speechSource" :disabled="busy || disabled || saving">
            <option value="server">服务器开源转写（Speaches）</option>
            <option value="custom">自定义供应商</option>
          </select>
        </label>
        <template v-if="speechSource === 'server'">
          <p v-if="serverLoading" role="status">正在读取服务器转写配置…</p>
          <p v-else-if="serverError" role="alert">{{ serverError }}</p>
          <p v-else-if="serverSpeech.configured" class="serviceNotice">模型：{{ serverSpeech.model }}。歌曲由部署者的转写服务处理，无需个人密钥。</p>
          <p v-else class="serviceNotice">转写服务尚未部署。你可以先导入歌词、分析节拍，或切换到自定义供应商。</p>
        </template>
        <template v-else>
          <label>转写供应商
            <select v-model="providerId" :disabled="busy || disabled">
              <option value="">选择已接入的供应商</option>
              <option v-for="provider in speechProviders" :key="provider.id" :value="provider.id">{{ provider.label }}{{ provider.apiKey?.trim() ? '' : '（待填写密钥）' }}</option>
            </select>
          </label>
          <label>转写模型<input v-model="speechModel" :disabled="busy || disabled" placeholder="whisper-1" /></label>
          <p v-if="!speechProviders.length">可先保存转写模型；供应商地址和密钥后续通过“添加供应商”填写。</p>
          <p v-else-if="selectedProvider && !selectedProvider.apiKey?.trim()">供应商配置已保留，密钥待填写。本地旋律、节拍和歌词时间码仍可使用。</p>
          <div class="analysisActions">
            <el-button :disabled="busy || disabled || saving" @click="providerDialogVisible = true">{{ selectedProvider ? '编辑供应商 / 填写密钥' : '添加供应商' }}</el-button>
          </div>
          <p>需要供应商支持音频转写和逐词时间戳（如 whisper-1）。点击后将歌曲的单声道音频发送至该供应商，按其规则计费；平台文本试用额度不适用。</p>
        </template>
        <div class="analysisActions">
          <el-button v-if="speechSource === 'server'" :disabled="busy || disabled || serverLoading" @click="loadServerSpeech">{{ serverLoading ? '读取中…' : '刷新配置' }}</el-button>
          <el-button :disabled="busy || disabled || saving || (speechSource === 'custom' && !speechModel.trim())" @click="saveSpeechConfig">{{ saving ? '保存中…' : '保存转写配置' }}</el-button>
        </div>
        <p v-if="configMessage" role="status">{{ configMessage }}</p>
        <div class="analysisActions">
          <el-button :disabled="busy || disabled || !song || !speechReady" aria-describedby="speechActionHint" @click="transcribe">识别歌词与时间戳</el-button>
          <span id="speechActionHint" class="actionHint">{{ !song ? '请先上传 MP3' : !speechReady ? '完成转写配置后可用' : '识别后可逐句校正歌词' }}</span>
        </div>
        <p v-if="transcript">识别得到 {{ transcript?.words?.length ?? 0 }} 个词级时间戳。歌声、伴奏和纯音乐可能导致漏词或幻听，请对照试听修改。</p>
      </div>
    </details>
    <addCustomProviderDialog v-if="providerDialogVisible" v-model="providerDialogVisible" :provider="selectedProvider" />
    <details class="analysisSection" open>
      <summary>歌词与时间码 <span class="sectionMeta">{{ cues.length ? `${cues.length} 句已标记` : '支持粘贴或导入' }}</span></summary>
      <div class="sectionBody">
        <label v-if="lyricFiles.length">读取歌词文件
          <select v-model="lyricIndex" :disabled="busy || disabled">
            <option value="">选择歌词</option>
            <option v-for="(item, index) in lyricFiles" :key="index" :value="String(index)">{{ item.name }}</option>
          </select>
        </label>
        <label>歌词文本<textarea v-model="lyricText" rows="4" :disabled="busy || disabled" placeholder="粘贴歌词，或带有时间码的 LRC / SRT 内容" /></label>
        <el-button :disabled="busy || disabled || !lyricText.trim()" @click="useLyrics">应用歌词</el-button>
        <p>普通歌词可直接用于创作；LRC / SRT 可读取时间码。自动识词结果需要试听校正。</p>
        <div v-if="cues.length" class="cueList">
          <div v-for="(cue, index) in visibleCues" :key="cuePage * 20 + index" class="cueRow">
            <label class="cueText">第 {{ cuePage * 20 + index + 1 }} 句<input v-model="cue.text" :disabled="busy || disabled" @input="reviewed = false; cuesEdited = true" /></label>
            <label>起点（秒）<input v-model.number="cue.start" type="number" min="0" step="0.01" :aria-label="`第 ${cuePage * 20 + index + 1} 句起点（秒）`" :disabled="busy || disabled" @input="reviewed = false; cuesEdited = true" /></label>
            <label v-if="cue.end !== undefined">终点（秒）<input v-model.number="cue.end" type="number" min="0" step="0.01" :aria-label="`第 ${cuePage * 20 + index + 1} 句终点（秒）`" :disabled="busy || disabled" @input="reviewed = false; cuesEdited = true" /></label>
          </div>
        </div>
        <div v-if="cues.length > 20" class="listPagination" aria-label="歌词分页">
          <el-button :disabled="cuePage === 0" @click="cuePage--">上一页歌词</el-button>
          <span>{{ cuePage + 1 }} / {{ Math.ceil(cues.length / 20) }} 页</span>
          <el-button :disabled="(cuePage + 1) * 20 >= cues.length" @click="cuePage++">下一页歌词</el-button>
        </div>
      </div>
    </details>
    <p v-if="cues.length && !duration">上传歌曲并分析后，才能按实际时长生成卡点。</p>
    <template v-if="duration && (analysis || cues.length || transcript?.words?.length)">
      <h3>卡点时间轴</h3>
      <div class="cutFields">
        <label>卡点依据<select v-model="cutMode" :disabled="busy || disabled"><option value="beat">音乐节拍</option><option value="lyric">逐句歌词</option><option value="word">逐词时间戳</option></select></label>
        <label>帧率<select v-model.number="fps" :disabled="busy || disabled"><option :value="24">24</option><option :value="25">25</option><option :value="30">30</option><option :value="60">60</option></select></label>
        <label>每几个点切换<select v-model.number="every" :disabled="busy || disabled"><option :value="1">1</option><option :value="2">2</option><option :value="4">4</option><option :value="8">8</option></select></label>
        <label>整体偏移（毫秒）<input v-model.number="offsetMs" type="number" min="-5000" max="5000" step="1" :disabled="busy || disabled" /></label>
      </div>
      <p>{{ cuts.length }} 个帧对齐剪点。数值精确到帧不代表识别一定准确；点击时间点定位，再试听歌曲与点击声是否同步。</p>
      <div class="cutList"><button v-for="cut in visibleCuts" :key="cut.frame" type="button" :aria-pressed="previewFrom === cut.seconds" :disabled="busy || disabled" @click="previewFrom = cut.seconds">{{ cut.seconds.toFixed(3) }}s · {{ cut.frame }}f</button></div>
      <div v-if="cuts.length > 100" class="listPagination" aria-label="剪点分页">
        <el-button :disabled="cutPage === 0" @click="cutPage--">上一页剪点</el-button><span>{{ cutPage + 1 }} / {{ Math.ceil(cuts.length / 100) }} 页</span><el-button :disabled="(cutPage + 1) * 100 >= cuts.length" @click="cutPage++">下一页剪点</el-button>
      </div>
      <div v-if="song" class="analysisActions">
        <label>试听起点（秒）<input v-model.number="previewFrom" type="number" min="0" step="0.1" :disabled="busy || disabled" /></label>
        <el-button :disabled="busy || disabled" @click="preview">试听 20 秒卡点</el-button>
        <el-button v-if="playing" @click="stopPreview">停止试听</el-button>
      </div>
      <label class="reviewCheck"><input v-model="reviewed" type="checkbox" :disabled="busy || disabled" />已试听并校准本时间轴</label>
      <el-button :disabled="busy || disabled || !cuts.length" @click="downloadCuts">导出剪点 CSV</el-button>
    </template>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, defineAsyncComponent, onMounted, onScopeDispose, ref, watch } from "vue";
import { customProviders, settings, saveSettings } from "@/stores/settings";
import type { AgentAttachment } from "@/components/agent/types";
import { decodeMusic, monoMusic, musicCuts, musicWav, parseLyrics, type LyricCue, type MusicAnalysis } from "@/lib/musicAnalysis";

type Transcript = { text: string; segments?: (LyricCue & { end: number; no_speech_prob?: number })[]; words?: { start: number; end: number; word: string }[]; providerId: string; model: string; duration: number };
const props = defineProps<{ attachments: AgentAttachment[]; disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean]; ready: [value: boolean] }>();
const addCustomProviderDialog = defineAsyncComponent(() => import("@/components/settings/panels/languageModel/addCustomProviderDialog.vue"));
const providerDialogVisible = ref(false);
const song = computed(() => props.attachments.find(item => item.mimeType === "audio/mpeg")?.file);
const lyricFiles = computed(() => props.attachments.filter(item => item.mimeType === "text/plain"));
const speechProviders = computed(() => customProviders.value.filter(item => item.protocol?.startsWith("openai-")));
const savedSpeech = settings.value.musicTranscription as { source?: unknown; providerId?: unknown; model?: unknown } | undefined;
const speechSource = ref(savedSpeech?.source === "custom" || (savedSpeech?.source !== "server" && savedSpeech?.providerId) ? "custom" : "server");
const serverSpeech = ref({ configured: false, model: "" });
const serverLoading = ref(false), serverError = ref("");
const statusController = new AbortController();
const providerId = ref(typeof savedSpeech?.providerId === "string" && speechProviders.value.some(item => item.id === savedSpeech.providerId) ? savedSpeech.providerId : "");
const speechModel = ref(typeof savedSpeech?.model === "string" && savedSpeech.model.trim() ? savedSpeech.model : "whisper-1");
const selectedProvider = computed(() => speechProviders.value.find(item => item.id === providerId.value));
const speechReady = computed(() => speechSource.value === "server" ? serverSpeech.value.configured && !serverLoading.value && !serverError.value : !!selectedProvider.value?.apiKey?.trim() && /^[\w./:-]{1,200}$/.test(speechModel.value.trim()));
const saving = ref(false), configMessage = ref("");
const analysis = ref<MusicAnalysis>(), transcript = ref<Transcript>();
const busy = ref(false), progress = ref(""), error = ref("");
const lyricIndex = ref(""), lyricText = ref(""), cues = ref<LyricCue[]>([]), cueSource = ref("none"), cuesEdited = ref(false);
const fps = ref(25), offsetMs = ref(0), every = ref(4), cutMode = ref("beat"), reviewed = ref(false), previewFrom = ref(0), playing = ref(false);
const audioDuration = ref(0);
const cuePage = ref(0), cutPage = ref(0);
const visibleCues = computed(() => cues.value.slice(cuePage.value * 20, (cuePage.value + 1) * 20));
const lyricError = ref("");
let worker: Worker | undefined, controller: AbortController | undefined, previewContext: AudioContext | undefined;
let decoded: AudioBuffer | undefined, decodedFile: File | undefined;
let generation = 0;
const duration = computed(() => analysis.value?.duration ?? transcript.value?.duration ?? audioDuration.value);
const timing = computed(() => cutMode.value === "beat" ? analysis.value?.beats ?? [] : cutMode.value === "lyric" ? cues.value.map(cue => cue.start) : transcript.value?.words?.map(word => word.start) ?? []);
const cuts = computed(() => {
  if (!Number.isFinite(offsetMs.value) || Math.abs(offsetMs.value) > 5000) return [];
  return musicCuts(timing.value, duration.value, fps.value, offsetMs.value, every.value);
});
const visibleCuts = computed(() => cuts.value.slice(cutPage.value * 100, (cutPage.value + 1) * 100));
watch(() => cues.value.length, () => { cuePage.value = 0; });
watch([fps, offsetMs, every, cutMode, duration], () => { cutPage.value = 0; });
watch(() => cuts.value.length, () => { cutPage.value = 0; });
const melodyPath = computed(() => {
  let last = -1;
  return (analysis.value?.melody ?? []).map(([time, note]) => {
    const command = time - last > 0.26 ? "M" : "L"; last = time;
    return `${command}${(time / analysis.value!.duration * 480).toFixed(1)},${(95 - (note - 21) / 87 * 90).toFixed(1)}`;
  }).join(" ");
});
watch([fps, offsetMs, every, cutMode], () => { reviewed.value = false; stopPreview(); });
watch(lyricText, () => { reviewed.value = false; });
watch([speechSource, providerId, speechModel], () => { configMessage.value = ""; });
watch(speechProviders, providers => { if (!providers.some(item => item.id === providerId.value)) providerId.value = ""; });
watch([busy, saving], ([processing, pendingSave]) => emit("busy", processing || pendingSave), { flush: "sync" });
watch(() => !!lyricText.value.trim(), value => emit("ready", value), { flush: "sync", immediate: true });
watch(song, () => {
  cancel(); decoded = undefined; decodedFile = undefined; audioDuration.value = 0; analysis.value = undefined; transcript.value = undefined;
  if (cueSource.value === "automaticTranscription") { cues.value = []; cueSource.value = "none"; }
  reviewed.value = false; progress.value = ""; error.value = "";
});
watch(() => lyricIndex.value === "" ? undefined : lyricFiles.value[Number(lyricIndex.value)], async attachment => {
  if (!attachment?.file) return;
  try {
    const text = await attachment.file.text();
    if (lyricFiles.value[Number(lyricIndex.value)] !== attachment) return;
    lyricText.value = text;
    useLyrics();
  } catch { error.value = "读取歌词失败"; }
});
watch(lyricFiles, files => { if (!files.length) lyricIndex.value = ""; else if (lyricIndex.value === "") lyricIndex.value = "0"; });

function stopPreview() { const context = previewContext; previewContext = undefined; playing.value = false; if (context) void context.close(); }
function cancel() { generation++; worker?.terminate(); worker = undefined; controller?.abort(); controller = undefined; busy.value = false; stopPreview(); progress.value = "已停止，已有结果保留"; }
onMounted(loadServerSpeech);
onScopeDispose(() => { cancel(); statusController.abort(); });
async function loadServerSpeech() {
  if (serverLoading.value) return;
  serverLoading.value = true; serverError.value = "";
  try {
    const { data } = await axios.get("/api/music/status", { signal: statusController.signal, timeout: 10000 });
    if (data.code !== 200 || typeof data.data?.configured !== "boolean" || typeof data.data?.model !== "string") throw new Error();
    serverSpeech.value = { configured: data.data.configured, model: data.data.model };
  } catch {
    serverSpeech.value = { configured: false, model: "" };
    serverError.value = "无法读取服务器转写配置，请刷新重试或联系部署者";
  } finally { serverLoading.value = false; }
}
async function audio() {
  const file = song.value;
  if (!file) throw new Error("请先上传 MP3");
  if (decodedFile === file && decoded) return decoded;
  const value = await decodeMusic(file);
  if (song.value !== file) throw new Error("歌曲已更换，请重新分析");
  decoded = value; decodedFile = file; audioDuration.value = value.duration;
  return value;
}
function showError(cause: unknown) {
  error.value = axios.isAxiosError(cause) ? cause.response?.data?.message || "转写请求失败，请检查接口连接" : cause instanceof Error ? cause.message : "音乐处理失败";
}
async function saveSpeechConfig() {
  if (saving.value) return;
  const model = speechModel.value.trim();
  if (speechSource.value === "custom" && ((providerId.value && !selectedProvider.value) || !/^[\w./:-]{1,200}$/.test(model))) {
    error.value = "请选择有效的供应商，并填写有效的转写模型名称";
    return;
  }
  const config = { source: speechSource.value, providerId: providerId.value, model };
  saving.value = true; error.value = ""; configMessage.value = "";
  try {
    await saveSettings(() => ({ musicTranscription: config }));
    if (speechSource.value === config.source && providerId.value === config.providerId && speechModel.value.trim() === config.model) configMessage.value = config.source === "server"
      ? "已保存使用服务器开源转写，模型由部署者统一配置。"
      : selectedProvider.value?.apiKey?.trim()
      ? "转写配置已保存，接口可用性以实际识词结果为准。"
      : "转写配置已保存，供应商或密钥可稍后补齐。";
  } catch { error.value = "转写配置保存失败，请重试"; }
  finally { saving.value = false; }
}
async function analyze() {
  if (busy.value || props.disabled) return;
  stopPreview(); busy.value = true; error.value = ""; progress.value = "正在解码歌曲…";
  const run = ++generation;
  try {
    const buffer = await audio();
    const rhythm = await monoMusic(buffer, 44100), pitch = await monoMusic(buffer, 22050);
    if (run !== generation) return;
    worker = new Worker(new URL("../../lib/musicWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<{ progress?: string; error?: string; result?: MusicAnalysis }>) => {
      if (run !== generation) return;
      if (data.progress) progress.value = data.progress;
      if (data.error || data.result) {
        worker?.terminate(); worker = undefined; busy.value = false;
        if (data.error) { error.value = data.error; progress.value = ""; }
        else { analysis.value = data.result; reviewed.value = false; progress.value = "旋律与节拍分析完成"; }
      }
    };
    worker.onerror = () => { if (run === generation) { cancel(); error.value = "本地分析进程失败，请重试或缩短歌曲"; } };
    worker.postMessage({ rhythm, pitch }, [rhythm.buffer, pitch.buffer]);
  } catch (cause) { if (run === generation) { showError(cause); busy.value = false; progress.value = ""; } }
}
async function transcribe() {
  if (busy.value || props.disabled) return;
  if (!speechReady.value) { error.value = "请先配置服务器转写服务或有效的自定义供应商"; return; }
  stopPreview(); busy.value = true; error.value = ""; progress.value = "正在准备听歌识词…";
  const run = ++generation;
  controller = new AbortController();
  try {
    const buffer = await audio();
    const samples = await monoMusic(buffer, 16000);
    if (run !== generation) return;
    progress.value = "正在识别歌词与时间戳…";
    const { data } = await axios.post<{ data: Transcript }>("/api/music/transcribe", musicWav(samples), {
      params: speechSource.value === "server" ? { source: "server" } : { source: "custom", providerId: providerId.value, model: speechModel.value.trim() }, headers: { "Content-Type": "application/octet-stream" }, signal: controller.signal,
    });
    if (run !== generation) return;
    transcript.value = data.data;
    // 原歌词不被转写覆盖；只在尚未采用时间码时使用自动识别结果。
    if (!cues.value.length) {
      cues.value = (data.data.segments ?? []).filter(cue => (cue.no_speech_prob ?? 0) < 0.6).map(({ start, end, text }) => ({ start, end, text }));
      cueSource.value = "automaticTranscription"; cuesEdited.value = false;
    }
    reviewed.value = false;
    progress.value = data.data.text.trim() ? "歌词识别完成，请试听校正" : "未识别出歌词，可能是纯音乐或人声不清晰";
  } catch (cause) { if (run === generation) showError(cause); }
  finally { if (run === generation) { busy.value = false; controller = undefined; } }
}
function useLyrics() {
  try {
    cues.value = parseLyrics(lyricText.value); cueSource.value = cues.value.length ? "userTimecodes" : "untimedLyrics";
    cuesEdited.value = false; reviewed.value = false; error.value = ""; lyricError.value = "";
    progress.value = cues.value.length ? `已读取 ${cues.value.length} 句歌词时间码` : "已保留歌词，未发现时间码";
  } catch (cause) { showError(cause); lyricError.value = error.value; }
}
async function preview() {
  stopPreview(); error.value = "";
  try {
    const context = new AudioContext(); previewContext = context;
    await context.resume();
    const buffer = await audio();
    if (previewContext !== context) return;
    if (!Number.isFinite(previewFrom.value) || previewFrom.value < 0 || previewFrom.value >= buffer.duration) throw new Error("试听起点超出歌曲时长");
    const from = previewFrom.value, length = Math.min(20, buffer.duration - from), start = context.currentTime + 0.1;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    source.onended = () => { if (previewContext === context) stopPreview(); };
    source.start(start, from, length);
    // 歌曲和点击声共用 AudioContext 时钟，避免 setTimeout / timeupdate 的调度漂移。
    for (const cut of cuts.value.filter(item => item.seconds >= from && item.seconds < from + length)) {
      const oscillator = context.createOscillator(), gain = context.createGain();
      const time = start + cut.seconds - from;
      oscillator.frequency.value = 1200; gain.gain.setValueAtTime(0.16, time); gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
      oscillator.connect(gain).connect(context.destination); oscillator.start(time); oscillator.stop(time + 0.035);
    }
    playing.value = true;
  } catch (cause) { stopPreview(); showError(cause); }
}
function downloadCuts() {
  const csv = `frame,seconds,fps,source,reviewed\n${cuts.value.map(cut => `${cut.frame},${cut.seconds.toFixed(6)},${fps.value},${cutMode.value},${reviewed.value}`).join("\n")}\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "musicCuts.csv"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function buildAttachments(): Promise<AgentAttachment[]> {
  if (busy.value) throw new Error("请等待音乐分析完成或停止分析");
  if (lyricError.value) throw new Error(lyricError.value);
  if (!analysis.value && !transcript.value && !lyricText.value.trim() && !cues.value.length) return [];
  if (!Number.isFinite(offsetMs.value) || Math.abs(offsetMs.value) > 5000) throw new Error("卡点偏移须在 ±5000 毫秒内");
  if (cues.value.some((cue, index) => !Number.isFinite(cue.start) || cue.start < 0 || (duration.value && cue.start >= duration.value)
    || (cue.end !== undefined && (!Number.isFinite(cue.end) || cue.end <= cue.start || (duration.value && cue.end > duration.value + 0.1)))
    || (index > 0 && cue.start < cues.value[index - 1]!.start))) throw new Error("请按歌曲时长检查并排序歌词时间码");
  const digest = song.value ? await crypto.subtle.digest("SHA-256", await song.value.arrayBuffer()) : undefined;
  const source = { name: song.value?.name, sha256: digest ? [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") : undefined };
  const reports: [string, unknown][] = [["musicAnalysis.txt", {
    kind: "littoMusicAnalysis", version: 1, source, analysis: analysis.value,
    melodyColumns: ["seconds", "midiPitch", "activation"], energyStepSeconds: 0.25,
    cutPlan: { source: cutMode.value, fps: fps.value, every: every.value, offsetMs: offsetMs.value, reviewed: reviewed.value,
      columns: ["frame", "seconds"], cuts: cuts.value.map(cut => [cut.frame, Number(cut.seconds.toFixed(6))]) },
    limits: "旋律为混音中最强音符候选，不保证是主唱；自动歌词与节拍须复听。帧对齐不代表自动识别误差为零。",
  }]];
  if (lyricText.value.trim() || cues.value.length || transcript.value) reports.push(["musicLyrics.txt", {
    source, originalLyrics: lyricText.value, cues: cues.value, cueSource: cueSource.value, cuesEdited: cuesEdited.value,
    transcription: transcript.value ? { providerId: transcript.value.providerId, model: transcript.value.model, text: transcript.value.text,
      wordColumns: ["start", "end", "word"], words: transcript.value.words?.map(word => [word.start, word.end, word.word]),
      segments: transcript.value.segments } : undefined, reviewed: reviewed.value,
  }]);
  return reports.map(([name, data]) => {
    const text = JSON.stringify(data);
    const file = new File([text], name, { type: "text/plain" });
    if (text.length > 100000 || file.size > 400000) throw new Error("音乐分析报告超出附件上限，请缩短歌曲或歌词后重试");
    return { name, path: "", mimeType: "text/plain", file };
  });
}
defineExpose({ buildAttachments, stopPreview });
</script>

<style scoped lang="scss">
.musicAnalysis {
  --musicControlBorder: color-mix(in srgb, var(--studioMuted) 75%, var(--studioSurface));
  margin: 20px 0;
  border-top: 1px solid var(--studioBorder);
  color: var(--studioInk);
  font-size: 14px;
  p { margin: 12px 0; color: var(--studioMuted); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; text-wrap: pretty; }
  h3 { margin: 20px 0 8px; font-size: 16px; line-height: 1.4; font-weight: 600; }
  .emptyHint { margin: 16px 0; }
  .processStatus { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; margin: 12px 0; border-radius: var(--ui-radius); background: var(--el-fill-color-light); font-size: 13px; span { overflow-wrap: anywhere; } }
  .errorNotice, [role="alert"] { color: var(--studioAttention); }
  .errorNotice { padding: 12px; border: 1px solid currentColor; border-radius: var(--ui-radius); }
  .songHeader { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-top: 16px; div { min-width: 0; } h3 { margin: 0; } p { margin: 4px 0 0; } }
  svg { width: 100%; height: 100px; color: var(--studioDone); }
  .analysisSection {
    border-top: 1px solid var(--studioBorder);
    margin-top: 16px;
    summary { cursor: pointer; min-height: 48px; padding: 14px 4px; font-weight: 600; line-height: 20px; box-sizing: border-box;
      .sectionMeta { float: right; font-size: 12px; font-weight: 400; color: var(--studioMuted); margin-left: 12px; }
    }
    .sectionBody { padding: 0 4px 8px; }
  }
  label { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; font-size: 13px; font-weight: 500; min-width: 0; }
  input:not([type="checkbox"]), select, textarea {
    box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px;
    border: 1px solid var(--musicControlBorder); border-radius: var(--ui-radius); background: var(--studioSurface); color: var(--studioInk);
    font: inherit; font-weight: 400; line-height: 1.5;
    &:hover:not(:disabled) { border-color: var(--el-color-primary); }
    &:disabled { cursor: not-allowed; opacity: 0.6; }
    &::placeholder { color: var(--studioMuted); }
  }
  textarea { resize: vertical; min-height: 112px; }
  input[type="number"] { font-variant-numeric: tabular-nums; }
  input, select, textarea, summary, button {
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
  }
  :deep(.el-button) { min-height: 44px; margin: 0; padding: 10px 14px; }
  .serviceNotice { padding: 12px; background: var(--el-fill-color-light); border-radius: var(--ui-radius); }
  .analysisActions { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 12px 0; }
  .actionHint { font-size: 12px; color: var(--studioMuted); }
  .cutFields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
  .cueList {
    .cueRow { display: grid; grid-template-columns: minmax(0, 1fr) 108px 108px; gap: 12px; border-top: 1px solid var(--studioBorder); }
  }
  .listPagination { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding-top: 12px; font-size: 12px; font-variant-numeric: tabular-nums; }
  .cutList {
    display: flex; flex-wrap: wrap; gap: 8px; max-height: 200px; overflow-y: auto; padding: 4px;
    button { min-height: 44px; padding: 10px; border: 1px solid var(--musicControlBorder); border-radius: var(--ui-radius); color: var(--studioInk); background: var(--studioSurface); cursor: pointer; font-variant-numeric: tabular-nums;
      &:hover:not(:disabled), &[aria-pressed="true"] { border-color: var(--el-color-primary); background: var(--el-fill-color-light); }
      &[aria-pressed="true"] { box-shadow: inset 0 0 0 1px var(--el-color-primary); }
      &:disabled { opacity: 0.6; cursor: not-allowed; }
    }
  }
  .reviewCheck { flex-direction: row; align-items: center; min-height: 44px; cursor: pointer; input { width: 18px; height: 18px; accent-color: var(--el-color-primary); } }
  @media (max-width: 540px) {
    input:not([type="checkbox"]), select, textarea { font-size: 16px; }
    .cueList .cueRow { grid-template-columns: repeat(2, minmax(0, 1fr)); .cueText { grid-column: 1 / -1; margin-bottom: 0; } }
    .cutFields { gap: 0 12px; }
    .analysisSection summary .sectionMeta { font-size: 11px; margin-left: 4px; }
  }
}
</style>
