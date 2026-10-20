import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { coverageCheck, evaluateCoverage, readCoverage, suggestSplits, writeCoverage } from "@/utils/media/coverage";
import { currentTenant } from "@/utils/tenant";

const lineSchema = z.strictObject({ speaker: z.string().trim().min(1).max(40), line: z.string().trim().max(2000),
  lipSync: z.enum(["visible", "offscreen"]).optional(), framing: z.string().trim().min(1).max(1000).optional() });
const shotSchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  duration: z.number().positive().max(600).optional(),
  visible: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  ownShot: z.boolean().optional(),
  lines: z.array(lineSchema).max(200).optional(),
  line: z.string().max(6000).optional(),
  turns: z.number().int().min(0).max(200).optional(),
  note: z.string().max(200).optional(),
});

/**
 * 对白覆盖表：写进来一份分镜台词归属，返回每行的判定与拆镜建议，并落盘 assets/coverage.json。
 * 按真实声音归属检查；多轮同框可保留，拆镜只作为风险段落的备选。
 */
export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  shots: z.array(shotSchema).min(1).max(400).optional(),
  save: z.boolean().optional(),
}), async (req, res) => {
  if (currentTenant()?.role === "VIEWER") return res.status(403).json(error("只读成员不能写入覆盖表", null, 403));
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const input = Array.isArray(req.body.shots) && req.body.shots.length
    ? req.body.shots
    : (await readCoverage(cwd))?.shots ?? [];
  if (!input.length) return res.status(400).json(error("没有可校验的覆盖表：请在 shots 里给出分镜台词，或先写入 assets/coverage.json", null, 400));

  const check = coverageCheck(input);
  const { rows } = evaluateCoverage(input);
  const splits = suggestSplits(input);
  const saved = req.body.save === false ? null : await writeCoverage(cwd, { note: "对白覆盖表，由 /api/ai/media/coverage 生成", shots: input });

  res.json(success({
    saved,
    verdict: check,
    shots: rows,
    splits,
    summary: {
      total: rows.length,
      blocked: check.level === "block" && !check.passed ? 1 : 0,
      orphan: rows.filter(row => row.problem === "orphan").length,
      overloaded: rows.filter(row => row.problem === "overloaded").length,
      offscreen: rows.filter(row => row.problem === "offscreen").length,
      multi: rows.filter(row => row.problem === "multi").length,
      crowded: rows.filter(row => row.problem === "crowded").length,
    },
  }));
});
