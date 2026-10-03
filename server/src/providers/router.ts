import { get, setting } from "../db.ts";
import { bad } from "../util.ts";
import { credentialFor, listModels } from "./registry.ts";
import { ADAPTERS } from "./registry.ts";

/** Which model capability each ReferenceRole needs, and what happens when it is missing. */
const ROLE_CAP: Record<string, { cap: string; fallback: string; hard?: boolean }> = {
    IDENTITY: { cap: "identityReference", fallback: "no identity-reference support: identity reduced to textual invariants + first reference used as image init", hard: true },
    GEOMETRY: { cap: "multiReference", fallback: "geometry reference dropped; geometry described textually from asset invariants" },
    WARDROBE: { cap: "multiReference", fallback: "wardrobe reference dropped; wardrobe described textually" },
    ENVIRONMENT: { cap: "multiReference", fallback: "environment reference dropped; layout described textually" },
    COMPOSITION: { cap: "compositionReference", fallback: "composition reference unsupported; composition encoded as framing text" },
    LIGHTING: { cap: "multiReference", fallback: "lighting reference dropped; lighting encoded as structured text" },
    LOOK: { cap: "multiReference", fallback: "look reference dropped; look encoded as text from Look spec" },
    PERFORMANCE: { cap: "motionReference", fallback: "performance reference unsupported; performance described textually" },
    CAMERA_MOTION: { cap: "cameraControl", fallback: "native camera control unsupported; camera move written into the prompt" },
    START_FRAME: { cap: "image2video", fallback: "no image-to-video: cannot honour Hero Frame", hard: true },
    END_FRAME: { cap: "startEndFrame", fallback: "end frame unsupported; only start frame is used" },
    AUDIO: { cap: "nativeAudio", fallback: "native audio unsupported; audio must be added in assembly" },
};

export type Policy = { optimize?: "quality" | "cost" | "latency" | "balanced"; imageModelId?: string; videoModelId?: string; disabledModelIds?: string[]; allowFallback?: boolean };
export type Candidate = { modelId: string; providerId: string; score: number; degradations: { role: string; strategy: string }[]; usable: boolean; reason?: string };

/** System Default → Workspace Default → Project Default → Shot Override. */
export function resolvePolicy(workspaceId: string, projectId: string | null, shotOverride?: Policy): Policy {
    const w = get("SELECT data FROM workspace_model_policies WHERE workspace_id=?", workspaceId);
    const p = projectId ? get("SELECT data FROM project_model_policies WHERE project_id=? AND workspace_id=?", projectId, workspaceId) : undefined;
    const merge = (a: Policy, b?: Policy): Policy => ({ ...a, ...Object.fromEntries(Object.entries(b ?? {}).filter(([, v]) => v !== undefined && v !== null)) });
    return [w && JSON.parse(w.data), p && JSON.parse(p.data), shotOverride].reduce(merge, setting<Policy>("modelPolicy", { optimize: "balanced", allowFallback: true }));
}

const CLASS = { low: 0, mid: 1, high: 2 } as Record<string, number>;

export function route(opts: { kind: "image" | "video"; workspaceId: string; projectId: string | null; roles: string[]; policy: Policy; exclude?: string[] }): { chosen: Candidate | null; candidates: Candidate[] } {
    const pol = opts.policy;
    const forced = opts.kind === "image" ? pol.imageModelId : pol.videoModelId;
    const out: Candidate[] = [];
    for (const m of listModels(true)) {
        if (m.type !== opts.kind || pol.disabledModelIds?.includes(m.id) || opts.exclude?.includes(m.id)) continue;
        const prov = get("SELECT * FROM providers WHERE id=?", m.providerId)!;
        const needsKey = ADAPTERS[prov.adapter].requiresKey;
        const usable = !needsKey || !!credentialFor(prov.id, opts.workspaceId, opts.projectId);
        const caps = m.capabilities;
        const base = opts.kind === "video" ? (caps.image2video || caps.text2video) : caps.text2image;
        if (!base) continue;
        const degradations: Candidate["degradations"] = [];
        let penalty = 0;
        for (const role of new Set(opts.roles)) {
            const r = ROLE_CAP[role];
            if (!r) continue;
            // Image models: START_FRAME/END_FRAME are video-only roles.
            if (opts.kind === "image" && (role === "START_FRAME" || role === "END_FRAME" || role === "AUDIO" || role === "CAMERA_MOTION" || role === "PERFORMANCE")) continue;
            if (!caps[r.cap]) {
                degradations.push({ role, strategy: r.fallback });
                penalty += r.hard ? 40 : 8;
            }
        }
        const cost = CLASS[caps.costClass ?? "mid"], lat = CLASS[caps.latencyClass ?? "mid"];
        const weights = { quality: { q: 10, c: 0, l: 0 }, cost: { q: 2, c: 12, l: 0 }, latency: { q: 2, c: 0, l: 12 }, balanced: { q: 6, c: 4, l: 3 } }[pol.optimize ?? "balanced"];
        const quality = 1 + cost; // proxy: pricier tiers = higher quality
        let score = quality * weights.q - cost * weights.c - lat * weights.l - penalty - m.priority / 100;
        if (forced === m.id) score += 1000;
        out.push({ modelId: m.id, providerId: m.providerId, score, degradations, usable, reason: usable ? undefined : "no credential" });
    }
    out.sort((a, b) => b.score - a.score);
    const chosen = out.find((c) => c.usable) ?? null;
    return { chosen, candidates: out };
}

export function mustRoute(opts: Parameters<typeof route>[0]) {
    const r = route(opts);
    if (!r.chosen) throw bad(`no usable ${opts.kind} model (check provider status, credentials, policy)`);
    return r;
}
