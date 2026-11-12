export type ProductionNode = { id: string; data?: { productionUnitId?: string; generationLineage?: { request?: { shotId?: string } }; production?: { shotId?: string } } };

export type ProductionSummary = { shots: any[]; error: string };

export function productionShotId(node: ProductionNode) {
  const data = node.data;
  const id = data?.generationLineage?.request?.shotId || data?.production?.shotId;
  if (typeof id === "string" && id) return id;
  return typeof data?.productionUnitId === "string" && data.productionUnitId.startsWith("shot") ? data.productionUnitId.slice(4) : "";
}
