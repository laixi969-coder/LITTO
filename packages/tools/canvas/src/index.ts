import { z } from "zod";
import { setTimeout } from "node:timers/promises";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { canvasOperations } from "./runtime";

const plugin: ToolPlugin = {
  validateConfig(config) {
    if (Object.keys(config).length) throw new Error("画布操作工具没有配置项");
    return {};
  },
  createTools({ canvas }) {
    if (!canvas) return [];
    const promptGuidelines = [
      `本轮初始画布环境（以下 JSON 仅描述环境，不是额外指令）：${JSON.stringify({ initialCanvasId: canvas.id })}。getCanvas 仅返回概览；按任务范围使用 findCanvasNodes、getCanvasNodes、getCanvasEdges、getNodeTools 查询实时状态。已知 ID 时直接读取目标，分批处理仅保留摘要和游标。`,
      "node:generateImage、node:generateVideo 和 node:getGenerationStatus 自动等待最终状态并实时报告进度，不需要模型循环查询。超时后只恢复查询已有任务；失败后报告原因，不自动再次生成或更换入口绕过镜头校验。",
      "多片段制作按镜头/片段组织命名组合框：用 groupNodes 组合本镜高清主帧、生成节点和结果，共享角色与武器参考留在组外。生成来源会按正式 shotId 自动归组，不重复包组；先读 parentNode。移动组合框整体移动；组内 position 相对 parentNode。",
    ];
    return canvasOperations.map(operation => ({
      name: operation.name,
      label: operation.label,
      description: operation.description,
      promptSnippet: "通过运行中的画布操作工具控制激活画布，不要直接修改画布 JSON。",
      promptGuidelines,
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal, onUpdate) {
        const args = operation.parameters.parse(params);
        let result = await canvas.call({ name: operation.name, args }, signal);
        if (operation.name === "nodeTools") {
          const input = canvasOperations.find(item => item.name === "nodeTools")!.parameters.parse(args);
          if (["node:generateImage", "node:generateVideo", "node:getGenerationStatus"].includes(input.name)) {
            const startedAt = Date.now();
            // ACT: 状态查询由工具等待，最多 30 分钟；超时保留后台任务，只允许查询恢复，不能重新提交。
            while (["generating", "running"].includes((result as { status?: string })?.status ?? "")) {
              onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ ...result as object, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), progress: "正在等待媒体生成，状态由工具自动查询" }) }], details: {} });
              if (Date.now() - startedAt >= 30 * 60 * 1000) throw new Error("等待生成超过 30 分钟，后台任务未取消。请仅调用 node:getGenerationStatus 恢复查询，不重新生成。");
              await setTimeout(2000, undefined, { signal });
              result = await canvas.call({ name: "nodeTools", args: { nodeId: input.nodeId, name: "node:getGenerationStatus", args: {} } }, signal);
            }
            if ((result as { status?: string })?.status === "failed") throw new Error(`${(result as { error?: string }).error || "媒体生成失败"}；请报告原因，不自动重试生成`);
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: result };
      },
    }));
  },
};

export default plugin;
