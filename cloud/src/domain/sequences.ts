import { z } from "zod";
import type { Scope } from "../db.ts";
import { bad } from "../util.ts";
import { sequenceKindSchema } from "./adDirection.ts";

export const sequenceInput = z.object({
  name: z.string().trim().min(1).max(120),
  script: z.string().max(100000).default(""),
  kind: sequenceKindSchema.default("story"),
  storyRevisionId: z.string().min(1).optional(),
  episodeNumber: z.number().int().min(1).max(100).optional(),
});

export function createSequence(s: Scope, projectId: string, input: z.infer<typeof sequenceInput>) {
  const { name, script, ...data } = input;
  const sequences = s.list("sequences", { projectId });
  if (data.episodeNumber !== undefined) {
    if (data.kind !== "serial") throw bad("只有连载短剧或中剧序列可以设置集号");
    if (sequences.some(item => item.episodeNumber === data.episodeNumber)) throw bad("本项目已有该集，请复用现有序列");
    if (sequences.some(item => item.episodeNumber > data.episodeNumber!)) throw bad("请按集号顺序建立序列，避免跨集接戏倒置");
  }
  return s.insert("sequences", { project_id: projectId, name, script, ord: Math.max(-1, ...sequences.map(item => item.ord)) + 1, data });
}
