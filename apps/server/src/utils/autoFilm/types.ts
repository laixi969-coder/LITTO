export type AutoFilmStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface AutoFilmCheck {
  verdict: "pass" | "revise" | "unverified";
  note: string;
}

export interface AutoFilmNarrativeReview {
  key: string;
  source: AutoFilmCheck;
  scenes: ({ sceneId: string } & Record<"fidelity" | "causality" | "staging" | "timing" | "continuity", AutoFilmCheck>)[];
}

export interface AutoFilmPlayback {
  mediaId: string;
  hash: string;
  note: string;
  planKey?: string;
  storyKey?: string;
  observerKey?: string;
  visualChecks?: Record<"surface" | "imaging" | "lighting" | "color", AutoFilmCheck>;
  lipSyncReviews?: ({ id: string; faceVisible: boolean; start: number; end: number } & AutoFilmCheck)[];
  storyChecks?: Record<"narrative" | "performance" | "continuity" | "dialogueCoverage" | "lipSync" | "editing" | "sound", AutoFilmCheck>;
  dialogueReviews?: { id: string; speakerId: string; transcript: string; start: number | null; end: number | null; verdict: "pass" | "revise" | "unverified"; note: string }[];
  cameraReviews?: {
    takeId: string;
    fingerprint: string;
    checks: { id: string; verdict: "pass" | "revise" | "unverified"; note: string }[];
  }[];
}

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
  narrativeReviews?: AutoFilmNarrativeReview[];
  generationCount: number;
  attempts: Record<string, number>;
  toolCalls: number;
  playbacks: AutoFilmPlayback[];
  voicePlaybacks?: { lineId: string; takeId: string; hash: string; sourceKey: string; audioRead: boolean; verdict: "pass" | "revise" | "unverified"; transcript: string; note: string }[];
  progress: string;
  error?: string;
  decisions: { tool: string; title: string; answer: string; values?: Record<string, string | number | boolean | string[]>; reason: string }[];
  output?: { renderId: string; sequenceId: string; mediaId: string; url: string };
}
