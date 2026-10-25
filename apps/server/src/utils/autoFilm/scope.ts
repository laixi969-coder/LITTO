import { AsyncLocalStorage } from "node:async_hooks";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";

// ACT: 授权仅沿本次后台任务的异步调用链传播，不修改全局设置或普通聊天。
export const autoFilmScope = new AsyncLocalStorage<{
  directory: string;
  beforeGeneration(kind: "image" | "video" | "audio", request: MediaGenerationRequest): Promise<void>;
}>();
