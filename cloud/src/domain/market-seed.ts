import { get } from "../db.ts";
import { publish } from "./market.ts";

/** Two example third-party skills, published idempotently so the marketplace is never empty. */
export function seedSkills() {
    const items = [
        { slug: "acme-noir-lighting", name: "Noir Lighting (ACME)", version: "1.0.0", author: "ACME Cine Labs", description: "Proposes a low-key noir lighting setup for a shot based on its action, world and mood.", target: "shot",
            inputSchema: { type: "object", properties: { mood: { type: "string", enum: ["tense", "melancholic", "menacing"], description: "Mood to emphasise" } }, required: ["mood"] },
            outputSchema: { type: "object", properties: { lighting: { type: "object", properties: { key: { type: "string" }, fill: { type: "string" }, negativeFill: { type: "string" }, exposure: { type: "string" }, keyDirection: { type: "string", enum: ["left", "right", "front", "back", "top", "none"] } }, required: ["key", "fill", "negativeFill", "exposure", "keyDirection"] }, rationale: { type: "string" } }, required: ["lighting"] },
            systemPrompt: "You are a noir cinematographer. Reply ONLY with JSON matching the requested fields. Motivate every light source; no filler words.",
            promptTemplate: "Shot: {{shot.title}}. Action: {{shot.action}}. Camera: {{shot.camera.shotSize}} {{shot.camera.lensMm}}mm. World: {{world.era}}, {{world.architecture}}, weather {{world.weather}}. Mood: {{input.mood}}. Propose a low-key lighting plan.",
            apply: [{ to: "shot.lighting", from: "/lighting" }] },
        { slug: "acme-prop-continuity", name: "Prop Invariants (ACME)", version: "1.2.0", author: "ACME Cine Labs", description: "Derives continuity invariants for a prop or product from its description.", target: "asset",
            inputSchema: { type: "object", properties: { strictness: { type: "string", enum: ["normal", "strict"] } }, required: [] },
            outputSchema: { type: "object", properties: { invariants: { type: "array", items: { type: "string" } }, forbiddenChanges: { type: "array", items: { type: "string" } } }, required: ["invariants"] },
            systemPrompt: "You are a continuity supervisor for props. Reply ONLY with JSON {invariants:[...], forbiddenChanges:[...]} as short imperative strings.",
            promptTemplate: "Asset: {{asset.name}} ({{asset.type}}). Description: {{asset.description}}. Existing invariants: {{asset.invariants}}. Strictness: {{input.strictness}}. List what must never change between shots.",
            apply: [{ to: "asset.invariants", from: "/invariants" }, { to: "asset.forbiddenChanges", from: "/forbiddenChanges" }] },
    ] as any[];
    for (const m of items) if (!get("SELECT 1 FROM skills WHERE slug=? AND version=?", m.slug, m.version)) publish(m, "seed");
}
