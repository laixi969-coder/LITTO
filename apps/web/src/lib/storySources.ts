import { readStory, updateStory } from "./storyClient";
import type { AgentAttachment } from "@/components/agent/types";

/** 复用已经保存的附件，保留原文件与提取正文的关联；不重复复制资料。 */
export async function registerStorySources(directory: string, attachments: AgentAttachment[]) {
  let project = await readStory(directory);
  if (!project.version) return;
  const textPaths = new Set<string>();
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.path || textPaths.has(attachment.path) || project.sources.some(source => source.path === attachment.path || source.textPath === attachment.path)) continue;
    const next = attachments[index + 1];
    const extracted = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(attachment.mimeType)
      && next?.name === `${attachment.name.slice(0, 251)}.txt` && next.mimeType === "text/plain" ? next : undefined;
    if (extracted) textPaths.add(extracted.path);
    if (!/^(text\/plain|image\/|video\/|application\/pdf|application\/vnd.openxmlformats-officedocument.wordprocessingml.document)/.test(attachment.mimeType)) continue;
    project = await updateStory(directory, project.version, { type: "source", value: { id: crypto.randomUUID(), name: attachment.name, path: attachment.path, textPath: extracted?.path, mimeType: attachment.mimeType, purpose: "reference", observations: [], coverage: "", unknowns: ["尚未分析；上传成功不等于已理解内容"] } });
  }
}
