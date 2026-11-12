import { computed, onScopeDispose, ref, type ComputedRef } from "vue";
import { ElMessageBox } from "element-plus";
import { compileVideoStoryboard, validateVideoStoryboard, storyboardTimeline, storyboardGenerateAudio, type VideoStoryboard, type VideoStoryboardShot, type NodeMediaModel, type NodeVideoRequest, type NodeInputValue } from "@toonflow/nodes-scaffold/runtime";

type StoryboardData = {
  storyboard?: VideoStoryboard;
  storyboardReferences?: { source: string; sourceHandle: string }[];
  storyboardTimeline?: string;
  production?: { shotId: string; productionFingerprint: string };
};
type Mention = { id: string; name: string; value: string; avatar?: string };
type Timeline = (Pick<VideoStoryboardShot, "start" | "end" | "description"> & Partial<Omit<VideoStoryboardShot, "start" | "end" | "description" | "id">>)[];
const timelineKey = (timeline: Timeline) => JSON.stringify(timeline.map(item => [item.editId ?? "", item.start, item.end, item.description, item.transition ?? "continuous", item.foreground ?? "", item.background ?? "", item.lensMm ?? null, item.aperture ?? null, item.cameraMove ?? ""]));
type ProductionShot = Record<string, unknown> & { id: string; updatedAt?: string; createdAt: string; duration: number; generationDuration?: number; action: string; heroKeyframeId?: string; approvedTakeId?: string; camera: Record<string, unknown> & { design?: Record<string, unknown> & { timeline?: Timeline } }; musicVideo?: Record<string, unknown> & { timeline: Timeline; audioMode: string } };

export function useStoryboard(options: {
  data: ComputedRef<StoryboardData>; references: ComputedRef<NodeInputValue[]>; mentions: ComputedRef<Mention[]>;
  model: ComputedRef<NodeMediaModel | undefined>; duration: ComputedRef<number | undefined>; mode: ComputedRef<NodeVideoRequest["mode"]>;
  basePrompt: ComputedRef<string>; request: () => Omit<NodeVideoRequest, "directory">;
  directory: () => Promise<string>; resolveText: (value: string) => string;
}) {
  const { data } = options;
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());
  const preview = ref("");
  let productionShot: ProductionShot | undefined;
  let loadedBinding = "";
  const key = (item: { source: string; sourceHandle: string }) => encodeURIComponent(JSON.stringify([item.source, item.sourceHandle]));
  function syncReferences() {
    const current = data.value.storyboardReferences ?? [];
    const added = options.references.value.filter(item => !current.some(value => key(value) === key(item))).map(({ source, sourceHandle }) => ({ source, sourceHandle }));
    if (added.length || !data.value.storyboardReferences) data.value.storyboardReferences = [...current, ...added];
  }
  const mentions = computed(() => data.value.production ? [] : (data.value.storyboardReferences ?? []).map((item, index) => {
    const mention = options.mentions.value.find(value => value.id === key(item));
    return { id: key(item), value: `{{ref ${index + 1}}}`, name: mention?.name ?? `已断开参考 ${index + 1}`, avatar: mention?.avatar };
  }));
  function resolve(plan: VideoStoryboard): VideoStoryboard {
    const text = (value: string) => value.replace(/\{\{ref (\d+)\}\}/g, (_marker, number: string) => {
      const binding = data.value.storyboardReferences?.[Number(number) - 1];
      const index = binding ? options.references.value.findIndex(item => key(item) === key(binding)) : -1;
      if (data.value.production || index < 0 || options.references.value[index]!.value === undefined) throw new Error(`分镜参考 ${number} 未连接或暂无内容，请恢复素材或移除该引用`);
      return options.resolveText(`{{ref ${index + 1}}}`);
    });
    return { ...plan, shots: plan.shots.map(shot => ({ ...shot, description: text(shot.description), foreground: text(shot.foreground), background: text(shot.background), cameraMove: text(shot.cameraMove) })) };
  }
  function validate(plan: VideoStoryboard) {
    const parsed = validateVideoStoryboard(plan, options.duration.value);
    const model = options.model.value;
    if (!model) throw new Error("请先选择视频模型");
    if (model.promptControl === "imageAndCameraOnly" || model.lipSync) throw new Error("当前模型不执行分镜文字指令，请选择支持文字控制的视频模型");
    const cut = parsed.shots.some(shot => shot.transition === "cut");
    const capability = model.multiShotCapabilities?.find(item => JSON.stringify(item.mode) === JSON.stringify(options.mode.value));
    if (cut && capability?.state !== "supported") throw new Error(capability?.state === "unsupported" ? "当前模型不支持内部切镜" : "当前模型的内部切镜能力尚未核验；可编排连续动作，或选择已支持切镜的模型");
    storyboardGenerateAudio(parsed, model.audio);
    if (data.value.production && productionShot?.musicVideo && productionShot.musicVideo.audioMode !== "generated" && (plan.music === "on" || plan.soundEffects === "on")) throw new Error("本镜使用已绑定音乐或无声素材，不能在编排中改为生成音轨；请先在镜头制作中调整声音方案");
    resolve(parsed);
  }
  function generationPlan() { if (!data.value.storyboard || data.value.production) return undefined; validate(data.value.storyboard); return resolve(data.value.storyboard); }
  function textPreview(plan: VideoStoryboard) { return compileVideoStoryboard(data.value.production ? "正式镜头沿用已保存的人物、对白、参考与视觉规格。保存后重新编译并展示完整发送内容。" : options.basePrompt.value, resolve(plan)); }
  async function json(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, { method, signal: controller.signal, headers: { "Content-Type": "application/json", "x-milimili-csrf": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error([result.message || result.error?.message || result.error || `请求失败 ${response.status}`, ...(result.details ?? []).map((item: { message: string }) => item.message)].join("；"));
    return path.startsWith("/api/") ? result.data : result;
  }
  async function load(): Promise<VideoStoryboard> {
    syncReferences(); preview.value = ""; productionShot = undefined;
    loadedBinding = data.value.production?.shotId ?? "";
    if (loadedBinding) {
      productionShot = await json(`/cloud/shots/${encodeURIComponent(loadedBinding)}`);
      if (data.value.production?.shotId !== loadedBinding) throw new Error("镜头绑定已变化，请重新打开编排");
      const shot = productionShot!;
      const timeline = shot.musicVideo?.timeline ?? shot.camera.design?.timeline;
      if (timeline && timelineKey(timeline) === data.value.storyboardTimeline && data.value.storyboard) return JSON.parse(JSON.stringify(data.value.storyboard));
      if ((timeline?.length ?? 0) > 8) throw new Error("当前正式镜头超过 8 个节拍，请在镜头制作面板编辑，原时间线已保留");
      const items: Timeline = timeline?.length ? timeline : [{ start: 0, end: shot.generationDuration ?? shot.duration, description: shot.action, transition: "continuous" }];
      return { version: 1, soundEffects: "auto", music: "auto", shots: items.map(item => ({ id: crypto.randomUUID(), ...(item.editId ? { editId: item.editId } : {}), start: item.start, end: item.end, description: item.description, transition: item.transition ?? "continuous", foreground: item.foreground ?? "", background: item.background ?? "", cameraMove: item.cameraMove ?? "", lensMm: item.lensMm, aperture: item.aperture })) };
    }
    return data.value.storyboard ? JSON.parse(JSON.stringify(data.value.storyboard)) : { version: 1, soundEffects: "auto", music: "auto", shots: [{ id: crypto.randomUUID(), start: 0, end: options.duration.value ?? 5, transition: "continuous", description: "", foreground: "", background: "", cameraMove: "" }] };
  }
  async function save(plan: VideoStoryboard) {
    validate(plan);
    if ((data.value.production?.shotId ?? "") !== loadedBinding) throw new Error("镜头绑定已变化，请重新打开编排");
    if (!loadedBinding) { data.value.storyboard = plan; preview.value = textPreview(plan); return; }
    const shot = productionShot!;
    const directory = await options.directory();
    const request = options.request();
    const signatureOf = (value: Omit<NodeVideoRequest, "directory">) => JSON.stringify({ ...value, productionFingerprint: undefined, generateAudio: storyboardGenerateAudio(plan, options.model.value?.audio, value.generateAudio) });
    const signature = signatureOf(request);
    const timeline = storyboardTimeline(resolve(plan));
    if (shot.heroKeyframeId || shot.approvedTakeId) await ElMessageBox.confirm("保存编排会更新镜头规格，原有主帧与视频保留，检查记录须重新核验。", "更新正式镜头", { confirmButtonText: "保存并重新编译", cancelButtonText: "返回编辑" });
    const assertCurrent = () => { controller.signal.throwIfAborted(); if (data.value.production?.shotId !== loadedBinding || signatureOf(options.request()) !== signature) throw new Error("配置已变化，请重新保存并编译，当前分镜草稿仍保留"); };
    assertCurrent();
    const design = { technique: "", purpose: "", start: "", end: "", subjectPath: "", cameraPath: "", timing: "", cut: "", invariants: [], acceptance: [], fallback: "", ...shot.camera.design,
      mode: timeline.some(item => item.transition === "cut") ? "multiShot" : "singleTake", timeline: shot.musicVideo ? undefined : timeline };
    // 沿用制作面板的完整规格保存与乐观锁，保留对白、接戏、表演和资产约束供重新编译核对。
    const updated = await json(`/cloud/shots/${encodeURIComponent(loadedBinding)}`, "PATCH", { ...shot, sceneId: shot.sceneId ?? undefined, camera: { ...shot.camera, design }, ...(shot.musicVideo ? { musicVideo: { ...shot.musicVideo, timeline } } : {}), generationDuration: options.duration.value, expectedUpdatedAt: shot.updatedAt ?? shot.createdAt, confirm: !!(shot.heroKeyframeId || shot.approvedTakeId) });
    productionShot = updated;
    window.dispatchEvent(new Event("milimiliProductionUpdated"));
    assertCurrent();
    data.value.storyboard = plan; data.value.storyboardTimeline = timelineKey(timeline);
    data.value.production!.productionFingerprint = "";
    let compiled;
    try { compiled = await json("/api/ai/media/production", "POST", { directory, shotId: loadedBinding, kind: "video", request: { ...request, storyboard: undefined, productionFingerprint: undefined, generateAudio: storyboardGenerateAudio(plan, options.model.value?.audio, request.generateAudio) } }); }
    catch (cause) { throw new Error(`时间线已保存，但编译未完成：${cause instanceof Error ? cause.message : String(cause)}。修正后再次保存编排即可重试。`); }
    assertCurrent();
    data.value.production!.productionFingerprint = compiled.fingerprint;
    preview.value = compiled.compiled.prompt;
  }
  return { mentions, load, save, validate, textPreview, generationPlan, preview, resolve, syncReferences };
}
