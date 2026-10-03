import { type Scope } from "../db.ts";
import { parseJson, runText } from "../llm.ts";
import { OBSERVATION_KINDS } from "./qc.ts";

/** Vision-based Failure Diagnostician: a vision-capable model looks at the frame and reports only issues from the closed observation vocabulary. */
export async function autoObserve(s: Scope, shotId: string, type: "keyframe" | "take", id: string, actor: string) {
    const shot = s.get("shots", shotId);
    const obj = s.get(type === "take" ? "takes" : "keyframes", id);
    if (!shot || !obj?.mediaId) return { used: false, reason: "target has no media" };
    const m = s.get("media", obj.mediaId);
    // Videos are inspected through their thumbnail; vector/animated mock output has nothing a vision model can read.
    const mediaId = m && /^image\/(png|jpeg|webp)$/.test(m.mime) ? m.id : null;
    if (!mediaId) return { used: false, reason: `no raster frame available for ${m?.mime ?? "media"}` };
    const kinds = OBSERVATION_KINDS.filter((k) => k !== "capability_mismatch");
    const r = await runText({ workspaceId: s.workspaceId, projectId: shot.projectId, actor, imageMediaIds: [mediaId], json: true, label: "qc.observe",
        system: `You are a film QC supervisor. Inspect the frame against the shot spec. Report ONLY problems you can actually see, using ONLY these kinds: ${kinds.join(", ")}. Reply JSON {"observations":[{"kind":"...","note":"..."}]}. Empty list if the frame is fine.`,
        prompt: `QC_OBSERVE\nSHOT: ${shot.title}. Action: ${shot.action}. Camera: ${shot.camera?.shotSize} ${shot.camera?.lensMm}mm. Lighting: ${shot.lighting?.key}, ${shot.lighting?.timeOfDay}.` });
    if (!r) return { used: false, reason: "no vision-capable text model" };
    try {
        const o = (parseJson(r.text) as any).observations ?? [];
        return { used: true, model: r.modelId, observations: o.filter((x: any) => kinds.includes(x?.kind)).map((x: any) => ({ kind: x.kind, note: x.note ? `vision: ${x.note}` : "vision" })) };
    } catch (e) { return { used: false, model: r.modelId, reason: `unparseable reply: ${(e as Error).message}` }; }
}
