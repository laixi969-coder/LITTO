import type { GraphNode, useVueFlow } from "@vue-flow/core";
import { fitGroupBounds, groupCanvasNodes } from "./selectionNodes";

type CanvasFlow = ReturnType<typeof useVueFlow>;
type ResultKind = "image" | "video";

export function placeResult(flow: CanvasFlow, node: GraphNode, kind: ResultKind) {
  if (node.parentNode || node.draggable === false || !node.dimensions.width || !node.dimensions.height) return false;
  const nodes = flow.getNodes.value;
  const sections = nodes.filter(item => !item.parentNode && item.type === "canvasGroup" && item.data.resultSection === kind && item.draggable !== false);
  const section = sections.at(-1);
  if (section) {
    const children = nodes.filter(item => item.parentNode === section.id);
    const rows: GraphNode[][] = [];
    for (const child of children) {
      const row = rows.find(items => Math.abs(items[0]!.position.y - child.position.y) < 10);
      if (row) row.push(child); else rows.push([child]);
    }
    const row = rows.at(-1) ?? [];
    const x = row.length < 4 ? Math.max(24, ...row.map(item => item.position.x + item.dimensions.width + 80)) : 24;
    const y = row.length < 4 ? row[0]?.position.y ?? 40 : Math.max(...children.map(item => item.position.y + item.dimensions.height)) + 80;
    const width = Math.max(section.dimensions.width, x + node.dimensions.width + 24);
    const height = Math.max(section.dimensions.height, y + node.dimensions.height + 24);
    const overlaps = nodes.some(item => !item.parentNode && item !== section && item !== node && !item.hidden
      && section.position.x < item.position.x + (item.dimensions.width || 500) + 40
      && section.position.x + width + 40 > item.position.x && section.position.y < item.position.y + (item.dimensions.height || 600) + 40
      && section.position.y + height + 40 > item.position.y);
    if (!overlaps) {
      flow.updateNode(node.id, { parentNode: section.id, position: { x, y }, extent: undefined, expandParent: false });
      fitGroupBounds(nodes, new Set([section]));
      return true;
    }
  }
  const roots = nodes.filter(item => !item.parentNode && item !== node && !item.hidden);
  const x = sections[0]?.position.x ?? Math.min(0, ...roots.map(item => item.position.x));
  const y = roots.length ? Math.max(...roots.map(item => item.position.y + (item.dimensions.height || 600))) + 120 : 0;
  const [id] = groupCanvasNodes(flow, [node], kind === "image" ? "图片素材" : "视频片段");
  const created = flow.findNode(id!);
  if (created) {
    created.data.resultSection = kind;
    flow.updateNode(created.id, { position: { x, y } });
  }
  return true;
}
