import type { NodeInputValue } from "@toonflow/nodes-scaffold/runtime";

export type FrameBinding = { source: string; sourceHandle: string };
export type VideoFrames = { first: FrameBinding | null; last: FrameBinding | null };
export const referenceKey = (value: FrameBinding) => JSON.stringify([value.source, value.sourceHandle]);

export function readVideoFrames(references: NodeInputValue[], mode: unknown, bindings?: VideoFrames) {
  const images = references.filter(item => item.dataType === "IMAGE");
  const binding = (item?: NodeInputValue): FrameBinding | null => item ? { source: item.source, sourceHandle: item.sourceHandle } : null;
  const selected = bindings ?? {
    first: mode === "startFrameOptional" && images.length === 1 ? null : binding(images[0]),
    last: mode === "singleImage" ? null : binding(images[mode === "startFrameOptional" && images.length === 1 ? 0 : 1]),
  };
  const find = (binding: FrameBinding | null) => binding ? images.find(item => referenceKey(item) === referenceKey(binding)) : undefined;
  return { bindings: selected, first: find(selected.first), last: mode === "singleImage" ? undefined : find(selected.last) };
}

export function validateVideoReferences(references: NodeInputValue[], mode: unknown, bindings?: VideoFrames) {
  const counts = { image: references.filter(item => item.dataType === "IMAGE").length, video: references.filter(item => item.dataType === "VIDEO").length, audio: references.filter(item => item.dataType === "AUDIO").length };
  if (references.some(item => item.value === undefined)) throw new Error("引用节点暂无输出，请先补充素材");
  if (Array.isArray(mode)) {
    if (!counts.image && !counts.video && !counts.audio) throw new Error("请连接混合参考素材");
    for (const [type, count] of Object.entries(counts)) {
      const maximum = Number(mode.find(item => String(item).startsWith(`${type}Reference:`))?.split(":")[1] ?? 0);
      if (count > maximum) throw new Error(`${{ image: "图片", video: "视频", audio: "音频" }[type]}参考 ${count} 个，当前模式最多 ${maximum} 个`);
    }
    return;
  }
  if (mode === "text") { if (counts.image || counts.video || counts.audio) throw new Error("文生视频不接受媒体参考，请改选参考模式或移除连接"); return; }
  if (counts.video || counts.audio) throw new Error("首尾帧模式仅接受图片与文字，请改选混合参考或移除视频、音频连接");
  const frames = readVideoFrames(references, mode, bindings);
  if (frames.bindings.first && !frames.first || mode !== "singleImage" && frames.bindings.last && !frames.last) throw new Error("已指定的首尾帧已断开，请重新选择；不会自动替换为其他图片");
  if (mode !== "startFrameOptional" && !frames.first) throw new Error("请指定首帧");
  if (["startFrameOptional", "startEndRequired"].includes(String(mode)) && !frames.last) throw new Error("请指定尾帧");
  const used = new Set([frames.first, frames.last].filter(Boolean).map(item => referenceKey(item!)));
  if (used.size !== counts.image) throw new Error("存在未分配到首尾槽位的图片，请分配槽位或移除多余连接");
}
