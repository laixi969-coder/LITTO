import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { currentTenant } from "@/utils/tenant";
import { exportTimeline } from "@/utils/media/timeline";

const clipSchema = z.strictObject({
  path: z.string().trim().min(1).max(4096),
  name: z.string().trim().max(40).optional(),
  in: z.number().min(0).optional(),
  out: z.number().positive().optional(),
});

/**
 * 导出时间线：把按顺序排好的镜头写成 OpenTimelineIO 与 CMX3600 EDL。
 * 生成链路只负责素材与顺序，转场、J/L cut、调色、混音交给剪辑器——那里才有真正的多轨和帧级控制。
 */
export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  clips: z.array(clipSchema).min(1).max(2000),
  name: z.string().trim().max(60).optional(),
  fps: z.number().int().min(1).max(120).optional(),
  outputDirectory: z.string().trim().max(200).optional(),
}), async (req, res) => {
  if (currentTenant()?.role === "VIEWER") return res.status(403).json(error("只读成员不能写入工作区", null, 403));
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const result = await exportTimeline(cwd, req.body);
  res.json(success({
    ...result,
    hint: "OTIO 可被 filmcraft / 达芬奇 / Premiere 读取；EDL 兼容性最广，导入时选「按 EDL 重建时间线」。素材是按绝对路径引用的，跨机器要连同 assets 目录一起拷。",
  }));
});
