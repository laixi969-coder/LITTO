import type { Context } from "@earendil-works/pi-ai";
import { cloud } from "@/lib/cloud";
import { tenantStore } from "@/utils/tenant";
import { assertConfiguredUpstream, getConfiguredModel, streamAi } from "@/utils/ai";
import { recordTextUsage } from "@/utils/usage";

export async function inspectFrames(input: { workspaceId: string; projectId: string; actor: string; providerId: string; modelId: string; system: string; prompt: string; frames: { data: Buffer; mime: string }[] }) {
  const api = cloud()!;
  const member = api.dbGet("SELECT u.id,u.email,u.is_admin,m.role FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE u.id=? AND m.workspace_id=? AND u.status='active' AND u.deleted_at IS NULL", input.actor, input.workspaceId);
  const scope = api.scoped(input.workspaceId);
  if (!member || member.role === "VIEWER" || !scope.get("projects", input.projectId)) throw Object.assign(new Error("无权检查该项目"), { status: 403 });
  return tenantStore.run({ userId: member.id, email: member.email, isAdmin: !!member.is_admin, role: member.role, workspaceId: input.workspaceId }, async () => {
    const configured = getConfiguredModel(input.providerId, input.modelId);
    await assertConfiguredUpstream(configured);
    const job = scope.insert("generation_jobs", { project_id: input.projectId, kind: "text", provider_id: "workspaceMedia", model_id: input.modelId,
      model_version: input.modelId, compiled_prompt: input.prompt, parameters: { label: "qc.observe", providerId: input.providerId, frameCount: input.frames.length }, input_refs: [],
      status: "RUNNING", attempts: 1, max_attempts: 1, run_after: new Date().toISOString(), estimated_cost: null, held: 0, created_by: input.actor, started_at: new Date().toISOString() });
    const started = Date.now();
    try {
      const context: Context = { systemPrompt: input.system, messages: [{ role: "user", timestamp: Date.now(), content: [
        { type: "text", text: input.prompt }, ...input.frames.map(frame => ({ type: "image" as const, mimeType: frame.mime, data: frame.data.toString("base64") })),
      ] }] };
      const stream = streamAi(configured, context, AbortSignal.timeout(180000));
      for await (const _event of stream) { /* consume the existing SDK stream */ }
      const result = await stream.result();
      recordTextUsage({ ...result, provider: configured.providerId });
      if (scope.get("generation_jobs", job.id)?.status !== "RUNNING") throw new Error("视觉检查已停止，结果未采用");
      if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "视觉检查失败");
      scope.update("generation_jobs", job.id, { status: "SUCCEEDED", actual_cost: null, duration_ms: Date.now() - started, finished_at: new Date().toISOString() });
      return { text: result.content.filter(part => part.type === "text").map(part => part.text).join(""), modelId: input.modelId, jobId: job.id };
    } catch (cause) {
      if (scope.get("generation_jobs", job.id)?.status === "RUNNING") scope.update("generation_jobs", job.id, { status: "FAILED", error: "视觉检查失败，请核对模型是否支持图片输入及供应商连接", finished_at: new Date().toISOString() });
      throw cause;
    }
  });
}
