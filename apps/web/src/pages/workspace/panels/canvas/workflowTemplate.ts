import { z } from "zod";
import type { Node, Edge } from "@vue-flow/core";

// ACT: 只保留已知可移植设置；插件私有状态、素材、执行记录和领域绑定必须在目标项目重建。
const settings = z.object({
  label: z.string().max(500).optional(), prompt: z.string().max(30000).optional(),
  ratio: z.string().max(30).optional(), size: z.string().max(30).optional(),
  resolution: z.string().max(30).optional(), duration: z.number().finite().positive().max(600).optional(),
  generateAudio: z.boolean().optional(),
});
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
export const workflowSchema = z.object({
  milimiliWorkflow: z.literal(1), name: z.string().trim().min(1).max(100),
  nodes: z.array(z.object({ id: z.string().min(1).max(128), type: z.string().regex(/^(canvasGroup|remote-[a-zA-Z0-9]+)$/), position: point, parentNode: z.string().optional(), data: settings,
    style: z.object({ width: z.string().regex(/^\d+(\.\d+)?px$/).optional(), height: z.string().regex(/^\d+(\.\d+)?px$/).optional() }).optional(),
  })).min(1).max(200),
  edges: z.array(z.object({ id: z.string().min(1).max(128), source: z.string(), target: z.string(), sourceHandle: z.string().nullable().optional(), targetHandle: z.string().nullable().optional() })).max(1000),
}).superRefine((value, ctx) => {
  const nodes = new Map(value.nodes.map(node => [node.id, node]));
  if (nodes.size !== value.nodes.length || new Set(value.edges.map(edge => edge.id)).size !== value.edges.length) ctx.addIssue({ code: "custom", message: "节点或连线 ID 重复" });
  for (const node of value.nodes) {
    const seen = new Set([node.id]); let parent = node.parentNode;
    while (parent) {
      if (seen.has(parent) || nodes.get(parent)?.type !== "canvasGroup") { ctx.addIssue({ code: "custom", message: "分组关系无效" }); break; }
      seen.add(parent); parent = nodes.get(parent)?.parentNode;
    }
  }
  if (value.edges.some(edge => !nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target)) ctx.addIssue({ code: "custom", message: "连线端点无效" });
});
export type WorkflowTemplate = z.infer<typeof workflowSchema>;
export function createWorkflow(name: string, nodes: Node[], edges: Edge[]) {
  const ids = new Map(nodes.map((node, index) => [node.id, `node${index + 1}`]));
  return workflowSchema.parse({ milimiliWorkflow: 1, name, nodes: nodes.map(node => ({
    id: ids.get(node.id), type: node.type, position: node.position, parentNode: ids.get(node.parentNode ?? ""),
    data: settings.parse(node.data), style: node.type === "canvasGroup" ? node.style : undefined,
  })), edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map((edge, index) => ({ id: `edge${index + 1}`, source: ids.get(edge.source), target: ids.get(edge.target), sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle })) });
}
