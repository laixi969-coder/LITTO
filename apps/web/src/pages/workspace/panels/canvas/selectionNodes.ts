import { getRectOfNodes, type GraphNode, type Node, type useVueFlow } from "@vue-flow/core";

export function getSelectionRoots(selection: GraphNode[], nodes: GraphNode[]) {
  const selected = new Map(selection.map(node => [node.id, node]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  return [...selected.values()].filter(node => {
    const visited = new Set([node.id]);
    let parentId = node.parentNode;
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentNode;
    }
    return true;
  });
}

export function getSelectionTree(selection: GraphNode[], nodes: GraphNode[]) {
  const children = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (!node.parentNode) continue;
    const siblings = children.get(node.parentNode) ?? [];
    siblings.push(node);
    children.set(node.parentNode, siblings);
  }
  const result: GraphNode[] = [];
  const visited = new Set<string>();
  function visit(node: GraphNode) {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    result.push(node);
    children.get(node.id)?.forEach(visit);
  }
  getSelectionRoots(selection, nodes).forEach(visit);
  selection.forEach(visit);
  return result;
}

export function fitGroupBounds(nodes: GraphNode[], groups: Set<GraphNode>) {
  for (const group of getSelectionTree([...groups], nodes).reverse()) {
    if (!groups.has(group)) continue;
    const children = nodes.filter(node => node.parentNode === group.id);
    if (!children.length || children.some(node => !node.dimensions.width || !node.dimensions.height)) continue;
    const left = Math.min(...children.map(node => node.position.x)) - 24;
    const top = Math.min(...children.map(node => node.position.y)) - 40;
    const width = Math.max(...children.map(node => node.position.x + node.dimensions.width)) - left + 24;
    const height = Math.max(...children.map(node => node.position.y + node.dimensions.height)) - top + 24;
    if (left || top) {
      group.position = { x: group.position.x + left, y: group.position.y + top };
      for (const child of children) child.position = { x: child.position.x - left, y: child.position.y - top };
    }
    const style = typeof group.style === "function" ? group.style(group) : group.style;
    group.style = { ...style, width: `${width}px`, height: `${height}px` };
    if (group.dimensions.width !== width || group.dimensions.height !== height) group.dimensions = { width, height };
  }
}

export function finishGroupDrag(nodes: GraphNode[], draggedNodes: GraphNode[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const affected = new Set<GraphNode>();
  function ancestors(node: GraphNode) {
    const result: GraphNode[] = [];
    const visited = new Set([node.id]);
    let parent = byId.get(node.parentNode ?? "");
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      result.push(parent);
      parent = byId.get(parent.parentNode ?? "");
    }
    return result;
  }
  // 所有归属判断使用松手时的矩形，避免先贴合的组吸收原本不相交的节点。
  const rectangles = new Map(nodes.map(node => {
    const parents = ancestors(node);
    const position = parents.reduce((point, parent) => ({ x: point.x + parent.position.x, y: point.y + parent.position.y }), { ...node.position });
    return [node.id, { ...position, ...node.dimensions, depth: parents.length }];
  }));
  const groups = nodes.filter(node => node.type === "canvasGroup" && !node.hidden).sort((a, b) => {
    const first = rectangles.get(a.id)!;
    const second = rectangles.get(b.id)!;
    return second.depth - first.depth || first.width * first.height - second.width * second.height;
  });
  function intersects(node: GraphNode, group: GraphNode) {
    const a = rectangles.get(node.id)!;
    const b = rectangles.get(group.id)!;
    return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
      && a.x < b.x + b.width && a.x + a.width > b.x
      && a.y < b.y + b.height && a.y + a.height > b.y;
  }
  let reparented = false;
  for (const node of getSelectionRoots(draggedNodes.filter(node => byId.get(node.id) === node), nodes)) {
    const parent = byId.get(node.parentNode ?? "");
    ancestors(node).filter(ancestor => ancestor.type === "canvasGroup").forEach(ancestor => affected.add(ancestor));
    if (!node.dimensions.width || !node.dimensions.height) continue;
    const retainsParent = parent?.type === "canvasGroup" && intersects(node, parent);
    const target = groups.find(group => {
      const parents = ancestors(group);
      return group !== node && intersects(node, group) && !parents.includes(node) && (!retainsParent || parents.includes(parent));
    }) ?? (retainsParent ? parent : undefined);
    if (target === parent || (!target && parent?.type !== "canvasGroup")) continue;
    const position = rectangles.get(node.id)!;
    const parentPosition = target ? rectangles.get(target.id)! : { x: 0, y: 0 };
    node.parentNode = target?.id;
    node.position = { x: position.x - parentPosition.x, y: position.y - parentPosition.y };
    node.extent = undefined;
    node.expandParent = false;
    reparented = true;
    ancestors(node).filter(ancestor => ancestor.type === "canvasGroup").forEach(ancestor => affected.add(ancestor));
  }

  fitGroupBounds(nodes, affected);
  if (reparented) nodes.splice(0, nodes.length, ...getSelectionTree(nodes, nodes));
}

export function groupCanvasNodes(flow: ReturnType<typeof useVueFlow>, selection: GraphNode[], label = "分组") {
  const roots = getSelectionRoots(selection, flow.getNodes.value);
  if (!roots.length) return [];
  if (roots.some(node => node.draggable === false || !node.dimensions.width || !node.dimensions.height)) throw new Error("节点不可移动或尺寸尚未就绪，暂不能组合");
  const rootIds = new Set(roots.map(node => node.id));
  const bounds = getRectOfNodes(roots);
  const parentNode = roots.every(node => node.parentNode === roots[0]!.parentNode) ? roots[0]!.parentNode : undefined;
  const parentPosition = flow.findNode(parentNode)?.computedPosition ?? { x: 0, y: 0 };
  const position = { x: bounds.x - 24, y: bounds.y - 40 };
  const id = crypto.randomUUID();
  const group: Node = {
    id,
    type: "canvasGroup",
    parentNode,
    position: { x: position.x - parentPosition.x, y: position.y - parentPosition.y },
    style: { width: `${bounds.width + 48}px`, height: `${bounds.height + 64}px` },
    connectable: false,
    expandParent: false,
    data: { label },
  };
  const nodes: Node[] = flow.getNodes.value.map(node => rootIds.has(node.id) ? {
    ...node,
    parentNode: id,
    position: { x: node.computedPosition.x - position.x, y: node.computedPosition.y - position.y },
    extent: undefined,
    expandParent: false,
  } : node);
  nodes.splice(nodes.findIndex(node => rootIds.has(node.id)), 0, group);
  flow.setNodes(nodes);
  return [id];
}
