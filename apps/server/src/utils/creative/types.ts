export type CreativeReference = { path: string; mimeType: string };
export type CreativeField = {
  nodeId: string;
  fieldName: string;
  label: string;
  type: "string" | "number" | "boolean" | "image" | "video" | "audio";
  value?: string | number | boolean;
  options?: string[];
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
};
export type CreativeDescription = { operation?: "mesh" | "upscale" | "texture"; label?: string; fields: CreativeField[] };
export type RunningHubInput = {
  operation: "runningHub";
  mode: "app" | "workflow";
  workflowId: string;
  fields: { nodeId: string; fieldName: string; value: string | number | boolean | CreativeReference }[];
};
export type FalInput = {
  operation: "mesh" | "upscale" | "texture";
  image: CreativeReference;
  options: Record<string, unknown>;
};
export type CreativeInput = RunningHubInput | FalInput;
export type CreativeHandle = { id: string; endpoint: string; provider: "runningHub" | "fal"; metadata?: Record<string, unknown> };
export type CreativePoll = { status: "pending" | "completed" | "failed"; assets?: { url: string; mimeType?: string; name?: string }[]; error?: string };
export type CreativeContext = {
  config: Record<string, unknown>;
  fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response>;
  readMedia(reference: CreativeReference): Promise<{ data: string; mimeType: string }>;
};
