import { computed, ref } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import type { NodeData } from "./connection";
import { useNodeEvent } from "./nodeEvent";
import type { NodeInputValue } from "./values";
import type { AnyTagProps } from "x-sender";
import { getPromptText } from "./promptText";

export function useNodeReferences(handleId = "in") {
  const { id, node } = useNode<NodeData & { referenceOrder?: Record<string, string[]> }>();
  const { removeEdges } = useVueFlow();
  const inputValues = ref<NodeInputValue[]>([]);
  const previews = ref(new Map<string, string>());
  const refList = computed({
    get() {
      const order = new Map(node.data.referenceOrder?.[handleId]?.map((key, index) => [key, index]));
      return [...inputValues.value].sort((a, b) => (order.get(referenceKey(a)) ?? order.size) - (order.get(referenceKey(b)) ?? order.size));
    },
    set(values: NodeInputValue[]) {
      node.data.referenceOrder = { ...node.data.referenceOrder, [handleId]: values.map(referenceKey) };
    },
  });
  const referenceMentions = computed(() => refList.value.flatMap((item, index) =>
    typeof item.dataType === "string" && ["IMAGE", "VIDEO", "AUDIO", "STRING"].includes(item.dataType)
      ? [{
          id: referenceKey(item),
          name: `参考 ${index + 1}`,
          value: `{{ref ${index + 1}}}`,
          avatar: previews.value.get(referenceKey(item)) || undefined,
        }]
      : []
  ));

  useNodeEvent().on(`input:${handleId}`, (values) => {
    inputValues.value = values;
    const ids = new Set(values.filter(item => item.dataType === "IMAGE" || item.dataType === "VIDEO").map(referenceKey));
    for (const key of previews.value.keys()) {
      if (!ids.has(key)) previews.value.delete(key);
    }
  });

  function setReferencePreview(item: NodeInputValue, url: string) {
    previews.value.set(referenceKey(item), url);
  }

  function removeReference(item: NodeInputValue) {
    removeEdges(edges => edges.filter(edge =>
      edge.target === id && edge.targetHandle === handleId && edge.source === item.source && edge.sourceHandle === item.sourceHandle
    ));
  }

  return { refList, referenceMentions, setReferencePreview, removeReference };
}

function referenceKey(item: NodeInputValue) {
  return encodeURIComponent(JSON.stringify([item.source, item.sourceHandle]));
}

export function collectReferenceViews(values: NodeInputValue[], frames?: { first?: NodeInputValue; last?: NodeInputValue }) {
  const items = frames ? [{ item: frames.first, role: "firstFrame" as const, index: 0 }, { item: frames.last, role: "lastFrame" as const, index: 0 }] : values.filter(item => item.dataType === "IMAGE").map((item, index) => ({ item, role: "image" as const, index }));
  return items.flatMap(({ item, role, index }) => item?.dataType === "IMAGE" && item.value?.view ? [{ role, index, view: item.value.view }] : []);
}

export function resolveNodePromptReferences(text: string, values: NodeInputValue[], model?: AnyTagProps[][]) {
  if (model?.length && getPromptText(model).trim() === text.trim()) {
    // 输入框可在未选中时卸载，生成仍按素材身份解析，不能用旧序号猜测当前素材。
    text = getPromptText(model, id => {
      const index = values.findIndex(item => referenceKey(item) === id);
      return `{{ref ${index + 1}}}`;
    }).trim();
  }
  return text.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => values[Number(number) - 1]?.value === undefined ? "{{ref 0}}" : marker);
}

export function resolveNodeReferenceText(text: string, values: NodeInputValue[], frames?: { first?: NodeInputValue; last?: NodeInputValue }, model?: AnyTagProps[][]) {
  text = resolveNodePromptReferences(text, values, model);
  return text.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const index = Number(number) - 1, reference = values[index];
    if (!reference || reference.value === undefined) return marker;
    if (reference.dataType === "IMAGE" && frames) return frames.first && referenceKey(reference) === referenceKey(frames.first) ? "首帧图片" : frames.last && referenceKey(reference) === referenceKey(frames.last) ? "尾帧图片" : "未分配图片";
    const labels: Record<string, string> = { IMAGE: "图片", VIDEO: "视频", AUDIO: "音频", STRING: "文字参考" };
    const label = typeof reference.dataType === "string" ? labels[reference.dataType] : undefined;
    return label ? `${label}${values.slice(0, index + 1).filter(item => item.dataType === reference.dataType).length}` : marker;
  });
}
