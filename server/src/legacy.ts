import type { Scope } from "./db.ts";
import { createAsset } from "./domain/assets.ts";

/**
 * Adapter between the upstream infinite-canvas project JSON and LITTO's domain store.
 * Upstream nodes stay layout only; image nodes become References (+ optional Character/Prop assets by title convention),
 * text nodes become text References. Upstream format changes are absorbed here, not in the domain.
 */
export async function importLegacyCanvas(s: Scope, projectId: string, legacy: any) {
    const nodes: any[] = Array.isArray(legacy?.nodes) ? legacy.nodes : [];
    const created = { references: 0, assets: 0, skipped: 0 };
    const idMap: Record<string, string> = {};
    const layout: any[] = [];
    for (const n of nodes) {
        if (n.type === "text") {
            const text = n.metadata?.content ?? n.metadata?.texts?.[0]?.content;
            if (!text) { created.skipped++; continue; }
            const r = s.insert("refs", { project_id: projectId, kind: "text", name: n.title, text, source: "legacy-canvas", source_ref: n.id });
            idMap[n.id] = r.id; created.references++;
            layout.push({ id: n.id, kind: "reference", refId: r.id, x: n.position?.x ?? 0, y: n.position?.y ?? 0, w: n.width, h: n.height });
        } else if (n.type === "image" || n.type === "video" || n.type === "audio") {
            // Image bytes live in upstream's browser store; here we keep a provenance reference the user can re-upload against.
            const r = s.insert("refs", { project_id: projectId, kind: n.type, name: n.title ?? n.type, text: n.metadata?.prompt ?? null, source: "legacy-canvas", source_ref: n.id });
            idMap[n.id] = r.id; created.references++;
            const m = /^(character|角色|prop|道具|environment|场景)[:：]\s*(.+)$/i.exec(n.title ?? "");
            if (m) {
                const type = /char|角色/i.test(m[1]) ? "Character" : /prop|道具/i.test(m[1]) ? "Prop" : "Environment";
                createAsset(s, projectId, { type, name: m[2], description: n.metadata?.prompt ?? "", attributes: {}, references: [r.id], invariants: [], allowedVariations: [], forbiddenChanges: [] });
                created.assets++;
            }
            layout.push({ id: n.id, kind: "reference", refId: r.id, x: n.position?.x ?? 0, y: n.position?.y ?? 0, w: n.width, h: n.height });
        } else created.skipped++;
    }
    const edges = (legacy?.connections ?? []).filter((e: any) => idMap[e.fromNodeId] && idMap[e.toNodeId]).map((e: any) => ({ id: e.id, from: e.fromNodeId, to: e.toNodeId, semantic: "legacy" }));
    s.update("projects", projectId, { canvas: { schemaVersion: 1, nodes: layout, edges, viewport: legacy?.viewport ?? { x: 0, y: 0, k: 1 } } });
    return { ...created, edges: edges.length };
}
