import { createHash } from "node:crypto";
import { get, run, scoped, tx } from "./db.ts";
import { createProject } from "./routes/platform.ts";
import { enqueue } from "./jobs.ts";
import { ADAPTERS, upsertModel, upsertProvider } from "./providers/registry.ts";
import { ProviderError, type GenRequest, type GenResult } from "./providers/adapter.ts";

/** Host-only execution bridge. Tenant identity comes from the stored job, never its parameters. */
export function configureWorkspaceMedia(execute: (request: GenRequest) => Promise<GenResult>) {
  ADAPTERS.workspaceMedia = {
    requiresKey: false,
    async submit(request) {
      return { done: await execute(request) };
    },
    async poll() {
      throw new ProviderError("工作区生成不支持远程轮询", false);
    },
    async testConnection() {
      return { ok: true, message: "工作区执行器已连接", latencyMs: 0 };
    },
  };
  upsertProvider("workspaceMedia", {
    name: "LITTO 工作区模型",
    adapter: "workspaceMedia",
    priority: 1000,
    timeoutMs: 3600000,
    retryPolicy: { maxAttempts: 1 },
    concurrency: 4,
  });
}

export function linkWorkspaceProject(workspaceId: string, directory: string, name: string) {
  return tx(() => {
    const link = get("SELECT project_id FROM workspace_project_links WHERE workspace_id=? AND directory=?", workspaceId, directory);
    if (link && scoped(workspaceId).get("projects", link.project_id)) return link.project_id as string;
    const project = createProject(scoped(workspaceId), name);
    run(
      "INSERT INTO workspace_project_links VALUES(?,?,?) ON CONFLICT(workspace_id,directory) DO UPDATE SET project_id=excluded.project_id",
      workspaceId,
      directory,
      project.id,
    );
    return project.id as string;
  });
}

export function enqueueWorkspaceMedia(input: {
  workspaceId: string;
  userId: string;
  projectId: string;
  directory: string;
  kind: "image" | "video";
  request: { providerId: string; modelId: string; prompt: string; [key: string]: unknown };
  requestId: string;
}) {
  const modelId =
    "workspace" +
    createHash("sha256")
      .update(JSON.stringify([input.workspaceId, input.kind, input.request.providerId, input.request.modelId]))
      .digest("hex");
  upsertModel(modelId, {
    providerId: "workspaceMedia",
    externalModelId: JSON.stringify([input.request.providerId, input.request.modelId]),
    name: input.request.modelId,
    type: input.kind,
    limits: { workspaceId: input.workspaceId, workspaceExecution: true },
    price: {},
    capabilities: {},
  });
  return enqueue({
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    modelId,
    compiledPrompt: input.request.prompt,
    parameters: { directory: input.directory, request: input.request },
    inputRefs: [],
    fallbackAllowed: false,
    idempotencyKey: "workspaceMedia:" + input.requestId,
  });
}
