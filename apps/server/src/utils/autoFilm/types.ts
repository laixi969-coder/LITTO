export type AutoFilmStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface AutoFilmTask {
  id: string;
  directory: string;
  projectId: string;
  userId: string;
  workspaceId: string;
  status: AutoFilmStatus;
  createdAt: string;
  updatedAt: string;
  script: string;
  references: { name: string; path: string; mimeType: string; mediaId: string }[];
  sessionFile?: string;
  sequenceIds: string[];
  storyRevisionId?: string;
  generationCount: number;
  attempts: Record<string, number>;
  toolCalls: number;
  playbacks: { mediaId: string; hash: string; note: string }[];
  progress: string;
  error?: string;
  decisions: { tool: string; title: string; answer: string; values?: Record<string, string | number | boolean | string[]>; reason: string }[];
  output?: { renderId: string; sequenceId: string; mediaId: string; url: string };
}
