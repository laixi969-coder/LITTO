import { nextTick } from "vue";
import type { useVueFlow } from "@vue-flow/core";
import { graphlib, layout } from "@dagrejs/dagre";
import { getSelectionTree, groupCanvasNodes } from "./selectionNodes";

export async function arrangeResults(flow: ReturnType<typeof useVueFlow>) {
  const nodes = flow.getNodes.value.filter(node => !node.parentNode && !node.hidden);
  const category = (node: typeof nodes[number]) => {
    if (node.type === "remote-imageNode") return "image";
    if (node.type === "remote-videoNode") return "video";
    if (node.type !== "canvasGroup" || !node.data.productionUnitId) return undefined;
    const children = flow.getNodes.value.filter(item => item.parentNode === node.id);
    return children.some(item => item.type === "remote-videoNode") ? "video"
      : children.some(item => item.type === "remote-imageNode") ? "image" : undefined;
  };
  const groups = ["image", "video"].map(kind => nodes.filter(node => category(node) === kind)
    .sort((left, right) => left.position.y - right.position.y || left.position.x - right.position.x));
  const selected = groups.flat();
  if (!selected.length) throw new Error("画布中没有可整理的图片或视频结果");
  if (selected.some(node => node.draggable === false || !node.dimensions.width || !node.dimensions.height)) throw new Error("结果节点不可移动或尺寸尚未就绪");
  const snapshot = selected.map(node => ({ id: node.id, position: { ...node.position }, parentNode: node.parentNode }));
  const sectionIds: string[] = [];
  const others = nodes.filter(node => !selected.includes(node));
  const x = Math.min(...selected.map(node => node.position.x));
  let y = others.length ? Math.max(...others.map(node => node.position.y + (node.dimensions.height || 600))) + 100
    : Math.min(...selected.map(node => node.position.y));
  for (const group of groups) {
    if (!group.length) continue;
    const currentGroup = group.map(node => flow.findNode(node.id)!).filter(Boolean);
    let left = x;
    let rowHeight = 0;
    for (const [index, node] of currentGroup.entries()) {
      if (index && index % 4 === 0) { left = x; y += rowHeight + 80; rowHeight = 0; }
      node.position = { x: left, y };
      left += node.dimensions.width + 80;
      rowHeight = Math.max(rowHeight, node.dimensions.height);
    }
    y += rowHeight + 140;
    await nextTick();
    const kind = category(currentGroup[0]!);
    const [id] = groupCanvasNodes(flow, currentGroup, kind === "image" ? "图片素材" : "视频片段");
    if (id) {
      const section = flow.findNode(id);
      if (section) section.data.resultSection = kind;
      sectionIds.push(id);
    }
  }
  return { snapshot, sectionIds };
}

export function nextCanvasPosition(flow: ReturnType<typeof useVueFlow>, width = 920, height = 600) {
  const nodes = flow.getNodes.value.filter(node => !node.parentNode);
  const columns = Math.max(2, Math.min(4, Math.floor((flow.dimensions.value.width || 1600) / (width + 80))));
  const origin = { x: Math.min(0, ...nodes.map(node => node.position.x)), y: Math.min(0, ...nodes.map(node => node.position.y)) };
  // ACT: 数百节点内扫描网格空位，O(n²)；更大画布可升级为空间索引，避免横向无限追加。
  for (let slot = 0; ; slot++) {
    const position = { x: origin.x + slot % columns * (width + 80), y: origin.y + Math.floor(slot / columns) * (height + 80) };
    if (!nodes.some(node => position.x < node.position.x + (node.dimensions.width || 400) + 40
      && position.x + width + 40 > node.position.x && position.y < node.position.y + (node.dimensions.height || 520) + 40
      && position.y + height + 40 > node.position.y)) return position;
  }
}

export async function arrangeCanvas(flow: ReturnType<typeof useVueFlow>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await nextTick();
  signal?.throwIfAborted();
  flow.updateNodeInternals(flow.getNodes.value.map((node) => node.id));
  await nextTick();
  signal?.throwIfAborted();

  const nodes = flow.getNodes.value.filter((node) => !node.parentNode);
  const snapshot = nodes.map((node) => ({ id: node.id, position: { ...node.position } }));
  if (!nodes.length) return { snapshot, viewport: { ...flow.viewport.value }, arrangedNodeIds: [] };
  for (const node of nodes) {
    if (node.draggable === false) throw new Error(`节点 ${node.id} 不允许移动`);
    const { width, height } = node.dimensions;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`节点 ${node.id} 尚未完成尺寸测量，请等待节点显示后重试`);
    }
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      throw new Error(`节点 ${node.id} 的位置无效`);
    }
  }

  const widths = nodes.map(node => node.dimensions.width).sort((left, right) => left - right);
  const heights = nodes.map(node => node.dimensions.height).sort((left, right) => left - right);
  const nodeGap = Math.max(96, Math.min(160, heights[Math.floor(heights.length / 2)]! / 4));
  const rankGap = Math.max(160, Math.min(320, widths[Math.floor(widths.length / 2)]! / 2));
  const hasCanvasGroups = nodes.some(node => node.type === "canvasGroup");
  const groupGap = hasCanvasGroups ? 120 : Math.max(nodeGap, rankGap) * 1.5;
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", rankalign: "top", nodesep: nodeGap, ranksep: rankGap, edgesep: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((node) => graph.setNode(node.id, { width: node.dimensions.width, height: node.dimensions.height }));
  const rootIds = new Map<string, string>();
  for (const node of getSelectionTree(flow.getNodes.value, flow.getNodes.value)) {
    const rootId = node.parentNode ? rootIds.get(node.parentNode) : node.id;
    if (rootId) rootIds.set(node.id, rootId);
  }
  flow.getEdges.value.forEach((edge) => {
    // 共享素材的历史参考线不把所有镜头合并成一个巨型分组；生成→结果与实际执行依赖仍参与布局。
    if (edge.data?.lineageKind === "reference") return;
    const source = rootIds.get(edge.source);
    const target = rootIds.get(edge.target);
    if (source && target && source !== target) graph.setEdge(source, target);
  });
  const groups = graphlib.alg.components(graph).map(ids => {
    const members = new Set(ids);
    const subgraph = graph.filterNodes(id => members.has(id));
    subgraph.setGraph({ ...graph.graph() });
    layout(subgraph);
    return {
      ids,
      graph: subgraph,
      width: subgraph.graph().width as number,
      height: subgraph.graph().height as number,
    };
  });
  const { width, height } = flow.dimensions.value;
  const aspectRatio = width > 0 && height > 0 ? Math.max(0.75, Math.min(2, width / height)) : 1.6;
  const area = groups.reduce((sum, group) => sum + (group.width + groupGap) * (group.height + groupGap), 0);
  const pairWidth = hasCanvasGroups && groups.length > 1 && aspectRatio >= 1.4 ? groups[0]!.width + groups[1]!.width + groupGap : 0;
  const rowWidth = Math.max(pairWidth, ...groups.map(group => group.width), Math.sqrt(area * aspectRatio));
  const origin = { x: Math.min(...nodes.map(node => node.position.x)), y: Math.min(...nodes.map(node => node.position.y)) };
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  // ACT: 以连通分组分行排布，保持每条流程完整；不追求全局最紧凑的矩形装箱。
  const positions = groups.flatMap(group => {
    if (x > 0 && x + group.width > rowWidth) {
      x = 0;
      y += rowHeight + groupGap;
      rowHeight = 0;
    }
    const result = group.ids.map(id => {
      const node = group.graph.node(id);
      const position = { x: origin.x + x + node.x - node.width / 2, y: origin.y + y + node.y - node.height / 2 };
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error(`节点 ${id} 的排列位置无效`);
      return { id, position };
    });
    x += group.width + groupGap;
    rowHeight = Math.max(rowHeight, group.height);
    return result;
  });
  positions.forEach(({ id, position }) => flow.updateNode(id, { position }));
  await nextTick();
  signal?.throwIfAborted();
  await flow.fitView({ duration: 0 });
  signal?.throwIfAborted();
  return { snapshot, viewport: { ...flow.viewport.value }, arrangedNodeIds: nodes.map((node) => node.id) };
}
