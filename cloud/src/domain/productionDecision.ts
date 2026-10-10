import { createHash } from "node:crypto";
import { z } from "zod";
import type { QuestionRequest, QuestionAnswer } from "@toonflow/tools-scaffold/runtime";
import { run, tx, type Scope, type Row } from "../db.ts";
import { bad, conflict, notFound } from "../util.ts";
import { mediaView } from "../storage.ts";
import { assetInput, worldSchema, lookSchema } from "./schema.ts";
import { approveAsset, assetVersions, event, newAssetVersion, rollbackAsset, updateAsset } from "./assets.ts";
import { createBatch, promoteCandidate, registerCandidates } from "./candidates.ts";
import { importFromLibrary, publishToLibrary, updateLibraryReference } from "./library.ts";
import { approveTake, promoteHero, takeView } from "./lifecycle.ts";
import { runQc, OBSERVATION_KINDS } from "./qc.ts";
import { requireReviewed, shotFingerprint } from "./realism.ts";
import { shotPartial, updateShot } from "./shots.ts";
import { applyOps, editView, getEdit, opSchema } from "./nle.ts";
import { finalQualityView, reviewFinalQuality, sequenceFingerprint } from "./finalQuality.ts";
import { assembleApprovedSequence } from "./assembly.ts";

const id = z.string().min(1).max(128);
const ids = z.array(id).min(1).max(60).refine(value => new Set(value).size === value.length, "候选不能重复");
const decisionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("approveAssets"), data: z.object({ assetIds: ids }) }),
  z.object({ operation: z.literal("selectCandidate"), data: z.object({ candidateIds: ids, asHero: z.boolean().default(false) }) }),
  z.object({ operation: z.literal("selectReference"), data: z.object({ assetId: id, mediaIds: ids }) }),
  z.object({ operation: z.literal("approveTake"), data: z.object({ takeIds: ids, overrideReason: z.string().trim().min(3).max(2000).optional() }) }),
  z.object({ operation: z.literal("reviewOutput"), data: z.object({ targetType: z.enum(["keyframe", "take"]), targetId: id }) }),
  z.object({ operation: z.literal("world"), data: worldSchema.partial() }),
  z.object({ operation: z.literal("look"), data: lookSchema.partial() }),
  z.object({ operation: z.literal("updateShot"), data: z.object({ shotId: id, patch: shotPartial }) }),
  z.object({ operation: z.literal("updateAsset"), data: z.object({ assetId: id, patch: assetInput.partial() }) }),
  z.object({ operation: z.literal("rollbackAsset"), data: z.object({ assetId: id, version: z.number().int().positive() }) }),
  z.object({ operation: z.literal("removeBinding"), data: z.object({ bindingId: id }) }),
  z.object({ operation: z.literal("publishAsset"), data: z.object({ assetId: id }) }),
  z.object({ operation: z.literal("importAsset"), data: z.object({ libraryId: id }) }),
  z.object({ operation: z.literal("libraryReference"), data: z.object({ libraryId: id, mediaId: id }) }),
  z.object({ operation: z.literal("editTimeline"), data: z.object({ sequenceId: id, ops: z.array(opSchema).min(1).max(200) }) }),
  z.object({ operation: z.literal("reviewFinal"), data: z.object({ renderId: id }) }),
]);

const checkLabels = { surface: "材质与人物细节", imaging: "曝光与成像", world: "空间与接触关系", motion: "运动与表演", cinematic: "电影感与构图" };
const finalLabels = { surface: "材质与人物细节", motion: "动作与表演", lighting: "光线与成像", continuity: "镜头连续性", sound: "声音与接缝" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
const fieldLabels: Record<string, string> = {
  era: "年代", locationLogic: "地点关系", architecture: "建筑", culture: "文化", weather: "天气", time: "时间", material: "材质", physics: "物理规则", realism: "真实感", environmentalConstraints: "环境约束",
  contrast: "对比度", saturation: "饱和度", palette: "色彩", skinTone: "肤色", blackLevel: "黑位", highlightRolloff: "高光过渡", shadowBehavior: "暗部", grain: "颗粒", halation: "光晕", bloom: "泛光", lensCharacter: "镜头质感", texture: "纹理", sharpnessPhilosophy: "锐度", colorReferenceIds: "色彩参考",
  name: "名称", type: "类型", description: "说明", attributes: "设定", references: "参考", invariants: "固定特征", allowedVariations: "允许变化", forbiddenChanges: "禁止变化", personaTags: "气质标签",
  title: "标题", narrativeFunction: "叙事作用", action: "动作", performance: "表演", blocking: "调度", camera: "摄影", lighting: "光线", duration: "时长", generationDuration: "生成时长", intendedStateDelta: "计划状态变化", assetIds: "使用资产", constraints: "约束", subtitle: "字幕", musicVideo: "音乐编排", freedomMap: "变化范围",
  trackId: "轨道", start: "开始时间", in: "素材入点", out: "素材出点", sourceIn: "后镜入点", sourceOut: "前镜出点", speed: "速度", transition: "转场", gainDb: "音量（dB）", fadeIn: "淡入", fadeOut: "淡出", label: "说明", t: "时间", segments: "分段", mode: "方式", clip: "片段", ripple: "后续顺排",
};
function describe(value: unknown): string {
  if (Array.isArray(value)) return value.map(describe).join("\n");
  if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${fieldLabels[key] ?? key}：${describe(item)}`).join("\n");
  return value === null || value === undefined || value === "" ? "未设置" : String(value);
}

export function prepareProductionDecision(s: Scope, projectId: string, input: unknown, reconsider = false) {
  const action = decisionSchema.parse(input);
  if (!s.get("projects", projectId)) throw notFound("project");
  const records: unknown[] = [];
  const request: QuestionRequest = { title: "确认制作选择", question: "", options: ["确认保存", "暂不决定"], images: [], media: [] };
  let completed = false;
  let selectedId: string | undefined;
  const record = (table: string, targetId: string, projectScoped = true) => {
    const item = s.get(table, targetId);
    if (!item || projectScoped && item.projectId !== projectId) throw notFound("当前项目记录");
    records.push(item);
    return item;
  };
  const preview = (mediaId: string, title: string) => {
    const media = record("media", mediaId, false);
    const view = mediaView(media);
    const url = view.url.startsWith("/") ? `/cloud${view.url}` : view.url;
    if (media.mime.startsWith("image/")) request.images!.push({ id: media.id, title, url });
    else if (/^(video|audio)\//.test(media.mime)) request.media!.push({ id: media.id, title, url, kind: media.mime.startsWith("video/") ? "video" : "audio" });
    return media;
  };
  const assetContext = (asset: Row) => {
    for (const refId of asset.references ?? []) {
      const ref = record("refs", refId);
      if (ref.mediaId) preview(ref.mediaId, asset.name);
    }
    if (asset.attributes?.authoritativeReference && !request.images!.some(item => item.id === asset.attributes.authoritativeReference)) preview(asset.attributes.authoritativeReference, asset.name);
    return `${asset.name} · 第 ${asset.version} 版\n${asset.description || ""}\n固定特征：${(asset.invariants ?? []).join("；")}\n允许变化：${(asset.allowedVariations ?? []).join("；")}\n禁止变化：${(asset.forbiddenChanges ?? []).join("；")}\n当前设定：${describe(asset.attributes ?? {})}`;
  };
  const outputContext = (type: "keyframe" | "take", item: Row) => {
    const shot = record("shots", item.shotId);
    records.push(shotFingerprint(s, shot.id));
    const report = s.list("qc_reports", { targetType: type, targetId: item.id }, "created_at DESC, rowid DESC")[0];
    records.push(report ?? null);
    preview(item.mediaId, `${shot.title} · 候选 ${item.id.slice(-5)}`);
    return { shot, report };
  };
  switch (action.operation) {
    case "approveAssets": {
      const assets = action.data.assetIds.map(assetId => record("assets", assetId));
      completed = assets.every(asset => asset.approvalStatus === "approved" && asset.approvedVersion === asset.version);
      request.title = "采用资产设定";
      request.question = assets.map(assetContext).join("\n\n") + "\n\n采用后，这些特征将用于后续生成。";
      break;
    }
    case "selectReference": {
      const asset = record("assets", action.data.assetId);
      if (!asset.invariants?.length) throw bad("请先保存资产的固定特征，再采用定妆");
      request.title = `选择并采用「${asset.name}」定妆`;
      request.question = assetContext(asset) + "\n\n同时采用以上资产设定和所选定妆，后续镜头沿用。";
      request.options = action.data.mediaIds.map((_id, index) => `采用候选 ${index + 1}`).concat("暂不决定");
      for (const [index, mediaId] of action.data.mediaIds.entries()) {
        record("media", mediaId);
        if (!preview(mediaId, `候选 ${index + 1}`).mime.startsWith("image/")) throw bad("定妆参考必须是图片");
      }
      selectedId = action.data.mediaIds.find(id => id === asset.attributes?.authoritativeReference);
      completed = !!selectedId && asset.approvalStatus === "approved";
      break;
    }
    case "selectCandidate": {
      const candidates = action.data.candidateIds.map(candidateId => record("candidates", candidateId));
      if (!candidates[0]!.assetId || candidates.some(item => item.assetId !== candidates[0]!.assetId)) throw bad("请选择同一资产的定妆候选");
      const asset = record("assets", candidates[0]!.assetId);
      if (!asset.invariants?.length) throw bad("请先保存资产的固定特征，再采用定妆");
      request.title = `选择「${asset.name}」定妆图`;
      request.question = assetContext(asset) + "\n\n同时采用以上资产设定和所选定妆，图片将成为后续镜头的身份参考；旧图保留。";
      request.options = candidates.map((item, index) => `采用候选 ${index + 1}`);
      for (const [index, item] of candidates.entries()) {
        if (!preview(item.mediaId, `候选 ${index + 1}`).mime.startsWith("image/")) throw bad("定妆候选必须是图片");
        if (action.data.asHero) {
          const frame = record("keyframes", item.keyframeId);
          outputContext("keyframe", frame);
          request.question += "\n同时设为镜头主关键帧，请核对材质、成像、空间与电影感。";
        }
      }
      const selected = candidates.find(item => item.promoted && asset.attributes?.authoritativeReference === item.mediaId);
      completed = !!selected && asset.approvalStatus === "approved" && (!action.data.asHero || s.get("shots", s.get("keyframes", selected.keyframeId)?.shotId)?.heroKeyframeId === selected.keyframeId);
      selectedId = selected?.id;
      request.options.push("暂不决定");
      break;
    }
    case "approveTake":
    case "reviewOutput": {
      const type = action.operation === "approveTake" ? "take" : action.data.targetType;
      const items = (action.operation === "approveTake" ? action.data.takeIds : [action.data.targetId]).map(itemId => record(type === "take" ? "takes" : "keyframes", itemId));
      if (items.some(item => item.shotId !== items[0]!.shotId)) throw bad("一次比较同一镜头的候选");
      const contexts = items.map(item => outputContext(type, item));
      const shot = contexts[0]!.shot;
      request.media!.forEach((item, index) => { item.title = `候选 ${index + 1} · ${shot.title}`; });
      request.title = `${action.operation === "approveTake" ? "采用视频" : "记录画面检查"}：${shot.title}`;
      request.question = "请直接查看下方素材，填写实际观察。尚未检查的项目不要勾选。";
      request.options = undefined;
      request.fields = [];
      if (items.length > 1) request.fields.push({ field: "selection", title: "采用哪个版本", type: "radio", required: true, options: items.map((_item, index) => `候选 ${index + 1}`) });
      if (type === "take") request.fields.push({ field: "fullPlayback", title: "已完整播放并试听所选视频", type: "checkbox", required: true, options: ["已完整播放并试听"] });
      request.fields.push({ field: "reviewed", title: action.operation === "approveTake" ? "采用前须完成全部画面检查" : "已实际检查的项目", type: "checkbox", required: true, minSelected: action.operation === "approveTake" ? 5 : 1, options: Object.entries(checkLabels).filter(([key]) => type === "take" || key !== "motion").map(([, label]) => label) });
      const findings = contexts.flatMap(({ report }) => report?.findings ?? []).filter(item => !item.kind.startsWith("continuity:"));
      if (findings.length) {
        request.question += "\n\n已有告警：\n" + findings.map(item => `${item.kind}：${item.cause} ${item.note || ""}`).join("\n");
        request.fields.push({ field: "dismissedKinds", title: "复核后确认不成立的旧告警（没有则留空）", type: "checkbox", options: [...new Set<string>(findings.map(item => item.kind))] });
      }
      request.fields.push({ field: "observations", title: "仍需修复的问题（没有则留空）", type: "checkbox", options: OBSERVATION_KINDS });
      request.fields.push({ field: "note", title: "实际问题、时间码或排除告警的依据", type: "textarea" });
      if (type === "take") {
        const assets = (shot.assetIds as string[]).map(assetId => record("assets", assetId));
        request.question += "\n请填写人物/道具在视频结束时的实际状态，下一镜会沿用这些观察。";
        assets.forEach((asset, index) => request.fields!.push({ field: `state${index}`, title: `${asset.name}：实际结束状态`, type: "textarea", required: true }));
        if (action.operation === "approveTake" && action.data.overrideReason) request.question += `\n\n本次提议保留连续性问题的理由：${action.data.overrideReason}`;
      }
      request.fields.push({ field: "decision", title: "本次决定", type: "radio", required: true, options: [action.operation === "approveTake" ? "采用所选视频" : "保存检查记录", "暂不决定"] });
      if (action.operation === "approveTake") {
        const selected = items.find(item => item.id === shot.approvedTakeId && item.status === "approved");
        if (selected) {
          try { requireReviewed(s, "take", selected); completed = true; selectedId = selected.id; }
          catch (error) { if ((error as { code?: string }).code !== "review_required") throw error; }
        }
      }
      break;
    }
    case "world":
    case "look": {
      const table = action.operation === "world" ? "worlds" : "looks";
      const current = s.list(table, { projectId }).find(item => action.operation === "world" || item.scope === "project");
      if (!current) throw notFound(table);
      records.push(current, s.list("shots", { projectId }).map(shot => [shot.id, shot.heroKeyframeId, shot.approvedTakeId]));
      const schema = action.operation === "world" ? worldSchema : lookSchema;
      completed = hash(schema.parse(current)) === hash(schema.parse({ ...current, ...action.data }));
      request.title = action.operation === "world" ? "修改世界设定" : "修改整体影调";
      request.question = `当前设定：\n${describe(schema.parse(current))}\n\n拟修改为：\n${describe(schema.parse({ ...current, ...action.data }))}\n\n受影响的已采用镜头需要重新检查，旧素材保留。`;
      break;
    }
    case "updateShot": {
      const shot = record("shots", action.data.shotId);
      records.push(shotFingerprint(s, shot.id));
      completed = Object.entries(action.data.patch).every(([key, value]) => hash(shot[key] ?? null) === hash(value));
      request.title = `修改镜头：${shot.title}`;
      request.question = `修改前：\n${describe(Object.fromEntries(Object.keys(action.data.patch).map(key => [key, shot[key]])))}\n\n拟修改：\n${describe(action.data.patch)}\n\n旧素材保留，受影响的检查记录需要重新核对。`;
      break;
    }
    case "updateAsset":
    case "rollbackAsset":
    case "publishAsset": {
      const asset = record("assets", action.data.assetId);
      request.question = assetContext(asset);
      if (action.operation === "updateAsset") {
        for (const refId of action.data.patch.references ?? []) record("refs", refId);
        request.title = `修改资产：${asset.name}`;
        request.question += `\n\n拟修改：\n${describe(action.data.patch)}\n已批准资产会建立新版本，原版本保留。`;
        completed = Object.entries(action.data.patch).every(([key, value]) => hash(asset[key] ?? null) === hash(value));
      } else if (action.operation === "rollbackAsset") {
        const versions = assetVersions(s, asset.id); records.push(versions);
        const version = versions.find(item => item.version === action.data.version);
        if (version?.approvalStatus !== "approved") throw bad("只能恢复已批准的资产版本");
        request.title = `恢复「${asset.name}」第 ${version.version} 版`;
        request.question += `\n\n恢复内容：\n${describe(version.snapshot)}\n恢复为新版本，历史保留。`;
        completed = asset.approvalStatus === "approved" && hash(assetInput.parse(asset)) === hash(assetInput.parse(version.snapshot));
      } else {
        request.title = `将「${asset.name}」加入工作区角色库`;
        request.question += "\n\n供本工作区的其他项目复用同一套设定和定妆图。";
        const entry = s.list("library_assets", { sourceAssetId: asset.id })[0]; records.push(entry ?? null); completed = !!entry;
      }
      break;
    }
    case "removeBinding": {
      const binding = s.get("reference_bindings", action.data.bindingId);
      if (binding && binding.projectId !== projectId) throw notFound("project binding");
      records.push(binding ?? null); completed = !binding;
      if (binding) { const ref = record("refs", binding.referenceId); if (ref.mediaId) preview(ref.mediaId, ref.name || "参考素材"); }
      request.title = "解除参考绑定";
      request.question = "解除所示参考将改变镜头约束，受影响的输出需重新检查。素材本身保留。";
      break;
    }
    case "importAsset":
    case "libraryReference": {
      const entry = record("library_assets", action.data.libraryId, false);
      preview(entry.authoritativeReference, `${entry.name} · 当前定妆`);
      request.title = action.operation === "importAsset" ? `复用角色库资产：${entry.name}` : `更新角色库定妆：${entry.name}`;
      request.question = `${entry.description || ""}\n固定特征：${(entry.invariants ?? []).join("；")}`;
      if (action.operation === "importAsset") {
        const imported = s.list("assets", { projectId }).find(asset => asset.attributes?.importedFrom === entry.id);
        records.push(imported ?? null); completed = !!imported; selectedId = imported?.id;
      } else {
        preview(action.data.mediaId, "新的定妆参考");
        request.question += "\n\n将更新工作区角色库供后续项目使用的参考。";
        completed = entry.authoritativeReference === action.data.mediaId;
      }
      break;
    }
    case "editTimeline": {
      const sequence = record("sequences", action.data.sequenceId);
      const edit = getEdit(s, sequence.id, true); records.push(edit, sequenceFingerprint(s, sequence.id));
      for (const operation of action.data.ops) {
        if ("mediaId" in operation) { record("media", operation.mediaId); preview(operation.mediaId, "剪辑素材"); }
        if (operation.type === "map_segments") for (const segment of operation.segments) {
          if (record("shots", segment.shotId).sequenceId !== sequence.id) throw bad("分段镜头不属于当前序列");
        }
        if (operation.type === "add_clip") {
          if (operation.clip.mediaId) record("media", operation.clip.mediaId);
          if (operation.clip.shotId && record("shots", operation.clip.shotId).sequenceId !== sequence.id) throw bad("镜头不属于当前序列");
        }
      }
      request.title = `保存剪辑选择：${sequence.name}`;
      request.question = `本次剪辑调整：\n${describe(action.data.ops)}\n\n会保存到当前时间线，可撤销，原始素材保留。`;
      break;
    }
    case "reviewFinal": {
      const render = record("renders", action.data.renderId);
      const quality = finalQualityView(s, render); records.push(quality, sequenceFingerprint(s, render.sequenceId));
      if (!quality.analysisId || quality.status === "stale") throw conflict("请先通过 productionSpec inspectFinal 检测当前成片", "review_required");
      preview(render.mediaId, "最终成片");
      request.title = "最终声画验收";
      request.question = "请完整观看并试听下方成片，记录各项实际结论。";
      request.options = undefined;
      request.fields = [{ field: "fullPlayback", title: "已完整播放并试听此成片", type: "checkbox", required: true, options: ["已完整播放并试听"] },
        ...Object.entries(finalLabels).map(([field, title]) => ({ field, title, type: "radio" as const, required: true, options: ["已检查通过", "需要返修", "未验证"] })),
        { field: "note", title: "时间码、观察证据与结论（至少 10 字）", type: "textarea", required: true }];
      for (const [index, finding] of quality.findings.entries()) {
        request.question += `\n${finding.message}`;
        if (finding.severity !== "block") request.fields.push({ field: `reason${index}`, title: `${finding.message}：复查依据（通过时至少 10 字）`, type: "textarea" });
      }
      request.fields.push({ field: "decision", title: "本次决定", type: "radio", required: true, options: ["保存最终验收", "暂不决定"] });
      completed = quality.status === "pass";
      break;
    }
  }
  request.images = request.images!.filter((item, index, list) => list.findIndex(other => other.id === item.id) === index);
  const fingerprint = hash(records);
  const key = hash(action);
  const receipt = s.list("approval_events", { projectId, entityType: "production_decision", entityId: key }, "created_at DESC, rowid DESC")[0];
  if (receipt?.reason === fingerprint) completed = true;
  return { action, request, fingerprint, key, completed: completed && !reconsider, selectedId };
}

export function applyProductionDecision(s: Scope, projectId: string, prepared: ReturnType<typeof prepareProductionDecision>, response: QuestionAnswer, actor: string) {
  const current = prepareProductionDecision(s, projectId, prepared.action, true);
  if (current.fingerprint !== prepared.fingerprint) throw conflict("展示的素材、规格或检查记录已改变，请重新核对；本次未覆盖", "stale");
  const { action, request } = prepared;
  const values = response.values ?? {};
  if (response.skipped || (request.fields?.length ? !["采用所选视频", "保存检查记录", "保存最终验收"].includes(String(values.decision)) : !request.options?.slice(0, -1).includes(response.answer))) return { applied: false };
  const result = tx(() => {
    let result: unknown;
    switch (action.operation) {
      case "approveAssets": result = action.data.assetIds.map(id => { const asset = s.get("assets", id)!; return asset.approvalStatus === "approved" && asset.approvedVersion === asset.version ? asset : approveAsset(s, id, actor); }); break;
      case "selectReference": {
        const mediaId = action.data.mediaIds[request.options!.indexOf(response.answer)]!;
        const asset = s.get("assets", action.data.assetId)!;
        if (asset.attributes?.authoritativeReference !== mediaId) {
          const batch = createBatch(s, { projectId, kind: "image", assetId: asset.id, promptFingerprint: hash(action.data.mediaIds) }, actor);
          const [candidate] = registerCandidates(s, batch.id, [mediaId]);
          result = promoteCandidate(s, candidate!.id, actor);
        }
        if (s.get("assets", asset.id)!.approvalStatus !== "approved") approveAsset(s, asset.id, actor);
        result = { assetId: asset.id, authoritativeReference: mediaId }; break;
      }
      case "selectCandidate": {
        const candidateId = action.data.candidateIds[request.options!.indexOf(response.answer)]!;
        const candidate = s.get("candidates", candidateId)!;
        if (candidate.promoted && s.get("assets", candidate.assetId)?.attributes?.authoritativeReference === candidate.mediaId) {
          result = candidate;
        } else result = promoteCandidate(s, candidateId, actor);
        if (s.get("assets", candidate.assetId)!.approvalStatus !== "approved") approveAsset(s, candidate.assetId, actor);
        if (action.data.asHero) {
          const frame = s.get("keyframes", candidate.keyframeId)!;
          runQc(s, frame.shotId, { type: "keyframe", id: frame.id }, [], { reviewed: ["surface", "imaging", "world", "cinematic"], actor, note: "用户在聊天中查看并确认定妆及主关键帧" });
          promoteHero(s, frame.id, actor);
        }
        break;
      }
      case "approveTake":
      case "reviewOutput": {
        const type = action.operation === "approveTake" ? "take" : action.data.targetType;
        const ids = action.operation === "approveTake" ? action.data.takeIds : [action.data.targetId];
        const selection = ids.length === 1 ? 0 : request.fields!.find(field => field.field === "selection")!.options!.indexOf(String(values.selection));
        if (selection < 0) throw bad("请选择实际候选");
        const item = s.get(type === "take" ? "takes" : "keyframes", ids[selection]!)!;
        const shot = s.get("shots", item.shotId)!;
        const labels = z.array(z.string()).parse(values.reviewed);
        const reviewed = Object.entries(checkLabels).filter(([, label]) => labels.includes(label)).map(([key]) => key);
        const fullPlayback = Array.isArray(values.fullPlayback) && values.fullPlayback.includes("已完整播放并试听");
        const note = z.string().max(4000).parse(values.note ?? "");
        const observations = z.array(z.string()).parse(values.observations ?? []).map(kind => ({ kind, note }));
        if (observations.length && !note.trim()) throw bad("请写明实际看到的问题");
        let observedStateDelta: Record<string, unknown> | undefined;
        if (type === "take") {
          // ACT: 用户文字观察按资产保存，不用计划状态冒充视频实际末态；精细字段可在后续反馈中补充。
          observedStateDelta = {};
          for (const [index, assetId] of (shot.assetIds ?? []).entries()) {
            const observed = z.string().trim().min(1).max(8000).parse(values[`state${index}`]);
            const asset = s.get("assets", assetId)!;
            const kind = ({ Character: "characters", Creature: "characters", Wardrobe: "wardrobe", Environment: "environment" } as Record<string, string>)[asset.type] ?? "props";
            (observedStateDelta[kind] ??= {} as Record<string, unknown>);
            (observedStateDelta[kind] as Record<string, unknown>)[assetId] = { note: observed };
          }
        }
        result = runQc(s, shot.id, { type, id: item.id }, observations, { reviewed, note, actor, fullPlayback, observedStateDelta, dismissedKinds: z.array(z.string()).parse(values.dismissedKinds ?? []) });
        if (action.operation === "approveTake") result = takeView(approveTake(s, item.id, actor, action.data.overrideReason ? { reason: action.data.overrideReason } : undefined));
        break;
      }
      case "world":
      case "look": {
        const table = action.operation === "world" ? "worlds" : "looks";
        const current = s.list(table, { projectId }).find(item => action.operation === "world" || item.scope === "project")!;
        const schema = action.operation === "world" ? worldSchema : lookSchema;
        result = s.update(table, current.id, { data: schema.parse({ ...current, ...action.data }) }); break;
      }
      case "updateShot": result = updateShot(s, action.data.shotId, action.data.patch, true); break;
      case "updateAsset": { const asset = s.get("assets", action.data.assetId)!; result = asset.approvalStatus === "approved" ? newAssetVersion(s, asset.id, action.data.patch) : updateAsset(s, asset.id, action.data.patch); break; }
      case "rollbackAsset": result = rollbackAsset(s, action.data.assetId, action.data.version, actor); break;
      case "removeBinding": run("DELETE FROM reference_bindings WHERE id=? AND workspace_id=?", action.data.bindingId, s.workspaceId); result = { removed: true }; break;
      case "publishAsset": result = publishToLibrary(s, action.data.assetId, actor); break;
      case "importAsset": result = importFromLibrary(s, action.data.libraryId, projectId, actor); break;
      case "libraryReference": result = updateLibraryReference(s, action.data.libraryId, action.data.mediaId, actor); break;
      case "editTimeline": result = editView(s, applyOps(s, action.data.sequenceId, action.data.ops, getEdit(s, action.data.sequenceId, false).version)); break;
      case "reviewFinal": {
        const render = s.get("renders", action.data.renderId)!;
        const quality = finalQualityView(s, render);
        const statuses: Record<string, string> = { "已检查通过": "pass", "需要返修": "fail", "未验证": "unverified" };
        result = reviewFinalQuality(s, render.id, { analysisId: quality.analysisId, fullPlayback: Array.isArray(values.fullPlayback) && values.fullPlayback.includes("已完整播放并试听"),
          checks: Object.fromEntries(Object.keys(finalLabels).map(key => [key, statuses[String(values[key])]])), note: values.note,
          acknowledgements: quality.findings.flatMap((finding: Row, index: number) => values[`reason${index}`] ? [{ id: finding.id, reason: values[`reason${index}`] }] : []),
        }, actor); break;
      }
    }
    const after = prepareProductionDecision(s, projectId, action, true);
    event(s, projectId, "production_decision", prepared.key, "apply", actor, after.fingerprint);
    return result;
  });
  let autoRender: unknown;
  let autoRenderError: string | undefined;
  if (action.operation === "approveTake") {
    try { const take = s.get("takes", (result as Row).id)!; autoRender = assembleApprovedSequence(s, s.get("shots", take.shotId)!.sequenceId, actor); }
    catch (error) { autoRenderError = `视频已采用，自动合成未启动：${error instanceof Error ? error.message : String(error)}`; }
  }
  return { applied: true, result, autoRender, autoRenderError };
}
