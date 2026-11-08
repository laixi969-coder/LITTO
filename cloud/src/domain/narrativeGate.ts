export type NarrativeGateInput = {
  workspaceId: string;
  projectId: string;
  sequenceId?: string;
  shotId?: string;
  generation?: { kind: string; prompt: string; parameters: Record<string, unknown> };
};

let inspectNarrative: ((input: NarrativeGateInput, signal?: AbortSignal) => Promise<() => Promise<void>>) | undefined;

export function configureNarrativeGate(inspect: NonNullable<typeof inspectNarrative>) {
  inspectNarrative = inspect;
}

export async function requireNarrative(input: NarrativeGateInput, signal?: AbortSignal) {
  if (!inspectNarrative) throw new Error("叙事检查服务未就绪，停止生成或定稿");
  return inspectNarrative(input, signal);
}
