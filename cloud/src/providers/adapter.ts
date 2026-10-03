export type GenKind = "image" | "video" | "text";

export type GenInput = { role: string; mime: string; data?: Buffer; text?: string; weight: number };

export type GenRequest = {
    kind: GenKind;
    externalModelId: string;
    prompt: string;
    negativePrompt?: string;
    params: { width?: number; height?: number; aspectRatio?: string; duration?: number; seed?: number; count?: number; [k: string]: unknown };
    inputs: GenInput[];
    apiKey?: string;
    baseUrl?: string;
    attempt: number;
    label?: string;
};

export type GenOutput = { data: Buffer; mime: string; duration?: number };
export type GenResult = { outputs: GenOutput[]; costUsd: number };

export type PollResult = { status: "running" } | { status: "done"; result: GenResult } | { status: "failed"; error: string; retryable?: boolean };

/** Every external provider is reached through this contract; business objects never reference a concrete model. */
export interface ProviderAdapter {
    readonly requiresKey: boolean;
    /** Returns a task id for async providers. Synchronous providers may return `done` immediately. */
    submit(req: GenRequest): Promise<{ taskId: string } | { done: GenResult }>;
    poll(taskId: string, ctx: { apiKey?: string; baseUrl?: string }): Promise<PollResult>;
    testConnection(ctx: { apiKey?: string; baseUrl?: string }): Promise<{ ok: boolean; message: string; latencyMs: number }>;
}

export class ProviderError extends Error {
    constructor(
        message: string,
        public retryable = true,
    ) {
        super(message);
    }
}
