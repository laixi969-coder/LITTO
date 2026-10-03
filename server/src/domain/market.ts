import { z } from "zod";
import { all, get, run, type Scope } from "../db.ts";
import { bad, HttpError, now, ulid } from "../util.ts";
import { assetDirector, cinematographer, motionDirector, visualDirector } from "./skills.ts";
import { cameraSchema, lightingSchema } from "./schema.ts";

/**
 * Declarative skill packages. A skill is DATA (prompt template + schemas + apply mapping); no third-party code is ever executed.
 * The prompt can only read a whitelisted slice of the caller's own workspace rows; results are schema-validated before they can be applied.
 */

// ---- JSON-schema subset ----
const PRIM = z.enum(["string", "number", "boolean"]);
type Prop = { type: "string" | "number" | "boolean" | "array" | "object"; enum?: (string | number)[]; description?: string; items?: { type: "string" | "number" | "boolean" }; properties?: Record<string, Prop>; required?: string[]; default?: unknown };
const propSchema: z.ZodType<Prop> = z.lazy(() =>
    z.object({
        type: z.enum(["string", "number", "boolean", "array", "object"]), enum: z.array(z.union([z.string().max(80), z.number()])).max(40).optional(), description: z.string().max(300).optional(),
        items: z.object({ type: PRIM }).optional(), properties: z.record(z.string().regex(/^\w{1,40}$/), propSchema).optional(), required: z.array(z.string()).max(40).optional(), default: z.unknown().optional(),
    }).strict(),
);
const objSchema = z.object({ type: z.literal("object"), properties: z.record(z.string().regex(/^\w{1,40}$/), propSchema).refine((o) => Object.keys(o).length <= 30, "too many properties"), required: z.array(z.string()).max(30).optional() }).strict();
export type ObjSchema = z.infer<typeof objSchema>;

export const TARGETS = ["shot", "asset", "sequence", "project"] as const;
export const APPLY_TARGETS = ["shot.camera", "shot.lighting", "shot.performance", "shot.action", "asset.invariants", "asset.allowedVariations", "asset.forbiddenChanges"] as const;

// Placeholders resolvable in prompts. Everything else (credentials, other tenants, media, ids…) is simply not addressable.
const SHOT_KEYS = ["title", "narrativeFunction", "action", "subtitle", "duration", ...["shotSize", "lensMm", "height", "angle", "motion", "motivation", "position", "focus", "depth"].map((k) => `camera.${k}`), ...["key", "fill", "negativeFill", "exposure", "timeOfDay", "colorTemp", "motivatedLight", "keyDirection"].map((k) => `lighting.${k}`), ...["emotion", "intensity", "eyeline", "gesture", "timing"].map((k) => `performance.${k}`)];
const ASSET_KEYS = ["name", "type", "description", "invariants", "allowedVariations", "forbiddenChanges"];
const WORLD_KEYS = ["era", "locationLogic", "architecture", "culture", "weather", "time", "material", "physics", "realism"];
const WHITELIST: Record<string, string[]> = { shot: SHOT_KEYS, asset: ASSET_KEYS, world: WORLD_KEYS, sequence: ["name", "script"], project: ["name"] };
const TARGET_CTX: Record<string, string[]> = { shot: ["shot", "world", "project"], asset: ["asset", "world", "project"], sequence: ["sequence", "world", "project"], project: ["world", "project"] };
const PH = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const manifestSchema = z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,48}$/), name: z.string().min(1).max(80), version: z.string().regex(/^\d+\.\d+\.\d+$/), author: z.string().max(80).default(""), description: z.string().max(500).default(""),
    target: z.enum(TARGETS), inputSchema: objSchema, outputSchema: objSchema, systemPrompt: z.string().min(1).max(2000), promptTemplate: z.string().min(1).max(4000),
    apply: z.array(z.object({ to: z.enum(APPLY_TARGETS), from: z.string().regex(/^(\/[\w]+)+$/).max(120) }).strict()).max(10).default([]),
}).strict().superRefine((m, ctx) => {
    const err = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const r of [...(m.inputSchema.required ?? [])]) if (!(r in m.inputSchema.properties)) err(`inputSchema.required "${r}" is not a property`);
    for (const r of [...(m.outputSchema.required ?? [])]) if (!(r in m.outputSchema.properties)) err(`outputSchema.required "${r}" is not a property`);
    for (const [, raw] of [...m.promptTemplate.matchAll(PH)].map((x) => [x[0], x[1]] as const)) {
        const [root, ...rest] = raw.split(".");
        const key = rest.join(".");
        if (root === "input") { if (!(rest[0] in m.inputSchema.properties) || rest.length !== 1) err(`placeholder {{${raw}}}: unknown input`); }
        else if (!TARGET_CTX[m.target].includes(root) || !WHITELIST[root]?.includes(key)) err(`placeholder {{${raw}}} is not allowed for target "${m.target}"`);
    }
    const stray = m.promptTemplate.replace(PH, "").match(/\{\{|\}\}/);
    if (stray) err("malformed placeholder");
    for (const a of m.apply) {
        if (a.to.split(".")[0] !== m.target) err(`apply target ${a.to} requires skill target "${a.to.split(".")[0]}"`);
        if (!pointer(m.outputSchema as any, a.from)) err(`apply.from ${a.from} does not exist in outputSchema`);
    }
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Resolve a JSON pointer against a *schema* (returns the property schema) so bad mappings are caught at publish time. */
function pointer(schema: { properties?: Record<string, Prop> }, ptr: string): Prop | null {
    let cur: any = schema;
    for (const part of ptr.split("/").filter(Boolean)) { cur = cur?.properties?.[part]; if (!cur) return null; }
    return cur;
}
const at = (v: unknown, ptr: string) => ptr.split("/").filter(Boolean).reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), v);

// ---- validation of values against the schema subset ----
export function validateValue(sch: Prop | ObjSchema, v: unknown, path = "$"): string[] {
    const errs: string[] = [];
    const t = sch.type;
    if (t === "string") { if (typeof v !== "string") errs.push(`${path}: expected string`); else if (v.length > 4000) errs.push(`${path}: too long`); }
    else if (t === "number") { if (typeof v !== "number" || !Number.isFinite(v)) errs.push(`${path}: expected number`); }
    else if (t === "boolean") { if (typeof v !== "boolean") errs.push(`${path}: expected boolean`); }
    else if (t === "array") { if (!Array.isArray(v)) errs.push(`${path}: expected array`); else { if (v.length > 50) errs.push(`${path}: too many items`); const it = (sch as Prop).items?.type; if (it) v.forEach((x, i) => typeof x !== it && errs.push(`${path}[${i}]: expected ${it}`)); } }
    else if (t === "object") {
        if (!v || typeof v !== "object" || Array.isArray(v)) return [`${path}: expected object`];
        const o = sch as { properties?: Record<string, Prop>; required?: string[] };
        for (const r of o.required ?? []) if (!(r in (v as any))) errs.push(`${path}.${r}: required`);
        for (const [k, val] of Object.entries(v)) { const p = o.properties?.[k]; if (!p) errs.push(`${path}.${k}: unexpected property`); else errs.push(...validateValue(p, val, `${path}.${k}`)); }
    }
    if ((sch as Prop).enum && v !== undefined && !(sch as Prop).enum!.includes(v as any)) errs.push(`${path}: must be one of ${(sch as Prop).enum!.join(", ")}`);
    return errs;
}

/** Deterministic "perfect model" reply for the offline mock text model (plumbing only). */
export function sampleOutput(sch: Prop | ObjSchema): unknown {
    const p = sch as Prop;
    if (p.enum?.length) return p.enum[0];
    switch (sch.type) {
        case "string": return ""; case "number": return 0; case "boolean": return false;
        case "array": return [];
        default: return Object.fromEntries(Object.entries((sch as any).properties ?? {}).map(([k, v]) => [k, sampleOutput(v as Prop)]));
    }
}

// ---- context + rendering ----
const getp = (o: any, path: string) => path.split(".").reduce<any>((x, k) => (x == null ? undefined : x[k]), o);
export function buildContext(s: Scope, skill: { target: string }, ids: { shotId?: string; assetId?: string; sequenceId?: string; projectId?: string }) {
    const ctx: Record<string, any> = {};
    let projectId = ids.projectId;
    if (skill.target === "shot") { const sh = ids.shotId ? s.get("shots", ids.shotId) : null; if (!sh) throw new HttpError(404, "shot not found", "not_found"); ctx.shot = sh; projectId = sh.projectId; }
    if (skill.target === "asset") { const a = ids.assetId ? s.get("assets", ids.assetId) : null; if (!a) throw new HttpError(404, "asset not found", "not_found"); ctx.asset = a; projectId = a.projectId; }
    if (skill.target === "sequence") { const q = ids.sequenceId ? s.get("sequences", ids.sequenceId) : null; if (!q) throw new HttpError(404, "sequence not found", "not_found"); ctx.sequence = { name: q.name, script: String(q.script ?? "").slice(0, 2000) }; projectId = q.projectId; }
    const project = projectId ? s.get("projects", projectId) : null;
    if (!project) throw new HttpError(404, "project not found", "not_found");
    ctx.project = { name: project.name };
    ctx.world = (s.list("worlds", { projectId: project.id })[0] as any) ?? {};
    return { ctx, projectId: project.id };
}
const show = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
export function renderPrompt(m: Manifest, input: Record<string, unknown>, ctx: Record<string, any>) {
    // Single pass: substituted values are never re-scanned, so user/model text containing "{{...}}" cannot pull in more context.
    return m.promptTemplate.replace(PH, (_, raw: string) => {
        const [root, ...rest] = raw.split(".");
        const key = rest.join(".");
        if (root === "input") return show(input[rest[0]]);
        if (!WHITELIST[root]?.includes(key)) return "";
        return show(getp(ctx[root], key));
    });
}

// ---- catalog ----
export type CatalogSkill = { id: string; slug: string; name: string; version: string; author: string; description: string; builtin: boolean; target: string; runnable: boolean; status: string; inputSchema?: unknown; outputSchema?: unknown; apply?: unknown; installed?: boolean };
const objOf = (props: Record<string, Prop>, required: string[] = []): ObjSchema => ({ type: "object", properties: props, required });

type Builtin = { id: string; name: string; description: string; target: string; inputSchema: ObjSchema; run?: (i: any, ctx: any) => any; apply?: { to: (typeof APPLY_TARGETS)[number]; from: string }[] };
const BUILTINS: Builtin[] = [
    { id: "builtin:assetDirector", name: "Asset Director", description: "Invariants, allowed variations, forbidden changes and required views for an asset.", target: "asset", inputSchema: objOf({}), run: (_i, c) => assetDirector(c.asset.type, c.asset.name, c.asset.description ?? ""), apply: [{ to: "asset.invariants", from: "/invariants" }, { to: "asset.allowedVariations", from: "/allowedVariations" }, { to: "asset.forbiddenChanges", from: "/forbiddenChanges" }] },
    { id: "builtin:cinematographer", name: "Cinematographer", description: "Lens, shot size, lighting and optical behaviour for a shot's narrative function.", target: "shot", inputSchema: objOf({}), run: (_i, c) => cinematographer(c.shot.narrativeFunction, c.shot.performance?.emotion ?? "", c.shot.lighting?.timeOfDay === "night") },
    { id: "builtin:motionDirector", name: "Motion Director", description: "Biomechanics notes: anticipation, centre of mass, contact, inertia, secondary motion, timing.", target: "shot", inputSchema: objOf({}), run: (_i, c) => motionDirector(c.shot.action ?? "", c.shot.duration ?? 4) },
    { id: "builtin:visualDirector", name: "Visual Director", description: "Look / palette / material language from free-text reference notes.", target: "project", inputSchema: objOf({ notes: { type: "string", description: "Reference notes" } }, ["notes"]), run: (i) => visualDirector(String(i.notes ?? "")) },
    { id: "builtin:storyboardDirector", name: "Storyboard Director", description: "Script → shots by narrative function. Use the Director Agent (POST /projects/:id/director/run).", target: "project", inputSchema: objOf({}) },
    { id: "builtin:continuitySupervisor", name: "Continuity Supervisor", description: "Cross-shot continuity checks. Use POST /sequences/:id/continuity.", target: "sequence", inputSchema: objOf({}) },
    { id: "builtin:failureDiagnostician", name: "Failure Diagnostician", description: "QC → cause + repair action. Use POST /shots/:id/qc.", target: "shot", inputSchema: objOf({}) },
];
export const builtinById = (id: string) => BUILTINS.find((b) => b.id === id);
const builtinView = (b: Builtin): CatalogSkill => ({ id: b.id, slug: b.id.slice(8), name: b.name, version: "builtin", author: "FilmFlow", description: b.description, builtin: true, target: b.target, runnable: !!b.run, status: "published", inputSchema: b.inputSchema, apply: b.apply ?? [], installed: true });
const rowView = (r: any, installed: Set<string>): CatalogSkill => { const m: Manifest = JSON.parse(r.manifest); return { id: r.id, slug: r.slug, name: r.name, version: r.version, author: r.author ?? "", description: r.description ?? "", builtin: false, target: m.target, runnable: true, status: r.status, inputSchema: m.inputSchema, outputSchema: m.outputSchema, apply: m.apply, installed: installed.has(r.id) }; };

export function catalog(ws: string, includeDrafts = false): CatalogSkill[] {
    const inst = new Set(all("SELECT skill_id FROM skill_installs WHERE workspace_id=? AND enabled=1", ws).map((r) => r.skill_id));
    const rows = all(`SELECT * FROM skills ${includeDrafts ? "" : "WHERE status='published'"} ORDER BY slug, version`);
    return [...BUILTINS.map(builtinView), ...rows.map((r) => rowView(r, inst))];
}
export function skillById(ws: string, id: string, includeDrafts = false) {
    const b = builtinById(id);
    if (b) return { builtin: b, view: builtinView(b) };
    const r = get("SELECT * FROM skills WHERE id=?", id);
    if (!r || (r.status !== "published" && !includeDrafts)) throw new HttpError(404, "skill not found", "not_found");
    const inst = new Set(all("SELECT skill_id FROM skill_installs WHERE workspace_id=? AND enabled=1", ws).map((x) => x.skill_id));
    return { row: r, manifest: JSON.parse(r.manifest) as Manifest, view: rowView(r, inst) };
}

export function setInstalled(ws: string, id: string, installed: boolean, actor: string) {
    if (builtinById(id)) throw bad("built-in skills are always available");
    const r = get("SELECT status FROM skills WHERE id=?", id);
    if (!r || r.status !== "published") throw new HttpError(404, "skill not found", "not_found");
    if (installed) run("INSERT INTO skill_installs VALUES(?,?,1,?,?) ON CONFLICT(workspace_id,skill_id) DO UPDATE SET enabled=1", ws, id, actor, now());
    else run("DELETE FROM skill_installs WHERE workspace_id=? AND skill_id=?", ws, id);
}

// ---- patches ----
const PATCH_VALIDATORS: Record<string, z.ZodTypeAny> = {
    "shot.camera": cameraSchema.partial().strict(), "shot.lighting": lightingSchema.partial().strict(),
    "shot.performance": z.object({ emotion: z.string(), intensity: z.number().min(0).max(1), eyeline: z.string(), gesture: z.string(), timing: z.string() }).partial().strict(),
    "shot.action": z.string().max(2000), "asset.invariants": z.array(z.string().max(300)).max(50), "asset.allowedVariations": z.array(z.string().max(300)).max(50), "asset.forbiddenChanges": z.array(z.string().max(300)).max(50),
};
export function checkPatch(to: string, value: unknown) {
    const v = PATCH_VALIDATORS[to];
    if (!v) throw bad(`unknown apply target ${to}`);
    const r = v.safeParse(value);
    if (!r.success) throw new HttpError(422, `patch for ${to} is invalid`, "invalid_output", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    return r.data;
}
export function patchesFor(apply: { to: string; from: string }[], output: unknown) {
    const out: { to: string; value: unknown }[] = [];
    for (const a of apply) { const v = at(output, a.from); if (v !== undefined) out.push({ to: a.to, value: checkPatch(a.to, v) }); }
    return out;
}

// ---- publish ----
export function publish(manifestRaw: unknown, actor: string, status: "published" | "draft" = "published") {
    if (JSON.stringify(manifestRaw ?? null).length > 32_000) throw bad("manifest too large");
    const p = manifestSchema.safeParse(manifestRaw);
    if (!p.success) throw new HttpError(422, "invalid skill manifest", "invalid_manifest", p.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`));
    const m = p.data;
    const ex = get("SELECT id FROM skills WHERE slug=? AND version=?", m.slug, m.version);
    if (ex) run("UPDATE skills SET name=?,author=?,description=?,manifest=?,status=?,updated_at=? WHERE id=?", m.name, m.author, m.description, JSON.stringify(m), status, now(), ex.id);
    else run("INSERT INTO skills(id,workspace_id,slug,name,version,author,description,manifest,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ulid(), null, m.slug, m.name, m.version, m.author, m.description, JSON.stringify(m), status, actor, now(), now());
    return get("SELECT * FROM skills WHERE slug=? AND version=?", m.slug, m.version)!;
}
export const allSkillsAdmin = () => all("SELECT * FROM skills ORDER BY slug, version").map((r) => ({ id: r.id, slug: r.slug, name: r.name, version: r.version, author: r.author, description: r.description, status: r.status, createdAt: r.created_at, installs: get("SELECT COUNT(*) n FROM skill_installs WHERE skill_id=?", r.id)!.n, manifest: JSON.parse(r.manifest) }));

// per-workspace run rate limit (30 / minute)
const runs = new Map<string, number[]>();
export function rateLimit(ws: string) {
    const t = Date.now(), list = (runs.get(ws) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= 30) throw new HttpError(429, "skill run rate limit exceeded", "rate_limited");
    list.push(t); runs.set(ws, list);
}
export { sampleOutput as _sample };
