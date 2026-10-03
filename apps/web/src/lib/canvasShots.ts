import { isNodeOutput } from "@toonflow/nodes-scaffold/values";

export type CanvasShot = {
  id: string;
  label: string;
  kind: "image" | "video";
  path?: string;
  mimeType?: string;
  finalized: boolean;
  warning?: string;
};

export function getCanvasShots(value: unknown): CanvasShot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((node) => {
    if (!node || typeof node.id !== "string" || !node.data || typeof node.data !== "object") return [];
    const data = node.data;
    const outputs: unknown[] = data.outputs && typeof data.outputs === "object" ? Object.values(data.outputs) : [];
    const output = outputs.find((item) => isNodeOutput(item) && (item.dataType === "IMAGE" || item.dataType === "VIDEO"));
    const handles: unknown[] = Array.isArray(data.handles) ? data.handles : [];
    const video = handles.some(
      (handle) =>
        !!handle && typeof handle === "object" && "type" in handle && handle.type === "source" && "dataType" in handle && handle.dataType === "VIDEO",
    );
    const image = handles.some(
      (handle) =>
        !!handle && typeof handle === "object" && "type" in handle && handle.type === "source" && "dataType" in handle && handle.dataType === "IMAGE",
    );
    if (!output && !video && !image) return [];
    const media = isNodeOutput(output) && (output.dataType === "IMAGE" || output.dataType === "VIDEO") ? output : undefined;
    return [
      {
        id: node.id,
        label: typeof data.label === "string" ? data.label : "未命名镜头",
        kind: media ? (media.dataType === "VIDEO" ? ("video" as const) : ("image" as const)) : video ? ("video" as const) : ("image" as const),
        path: media?.value.url,
        mimeType: media?.value.mimeType,
        // ACT: 定稿绑定输出路径，重新生成后自动回到待审，避免旧定稿状态误用于新画面。
        finalized: !!media && data.shotFinalizedPath === media.value.url,
        warning: typeof data.continuityWarning === "string" ? data.continuityWarning : undefined,
      },
    ];
  });
}
