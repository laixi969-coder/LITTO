import { openSqlite } from "./sqlite.ts";
import { config } from "./config.ts";
import { j, now, ulid } from "./util.ts";
import { publishChange, TRACKED } from "./events.ts";

export type Row = Record<string, any>;

const MIGRATIONS: { id: string; sql: string }[] = [
    {
        id: "0001_platform",
        sql: `
CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'active', is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE login_codes(email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, created_at TEXT);
CREATE TABLE workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'personal', quota_bytes INTEGER NOT NULL DEFAULT 5368709120, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE workspace_members(workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT, PRIMARY KEY(workspace_id,user_id));
CREATE TABLE system_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
CREATE TABLE audit_logs(id TEXT PRIMARY KEY, actor_id TEXT, workspace_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, created_at TEXT);
CREATE TABLE idempotency_keys(key TEXT NOT NULL, workspace_id TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT, PRIMARY KEY(workspace_id,key));

CREATE TABLE providers(id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter TEXT NOT NULL, base_url TEXT, auth_type TEXT NOT NULL DEFAULT 'bearer', status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 100, concurrency INTEGER NOT NULL DEFAULT 4, timeout_ms INTEGER NOT NULL DEFAULT 120000, retry_policy TEXT NOT NULL DEFAULT '{"maxAttempts":2,"backoffMs":500}', platform_credential_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE models(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, external_model_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, limits TEXT NOT NULL DEFAULT '{}', resolutions TEXT NOT NULL DEFAULT '[]', aspect_ratios TEXT NOT NULL DEFAULT '[]', durations TEXT NOT NULL DEFAULT '[]', price TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 100, fallback_model_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE model_capabilities(model_id TEXT NOT NULL, capability TEXT NOT NULL, value TEXT NOT NULL DEFAULT 'true', PRIMARY KEY(model_id,capability));
CREATE TABLE api_credentials(id TEXT PRIMARY KEY, workspace_id TEXT, scope TEXT NOT NULL, project_id TEXT, provider_id TEXT NOT NULL, label TEXT, cipher TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, last4 TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_used_at TEXT, last_error TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE workspace_model_policies(workspace_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);
CREATE TABLE project_model_policies(project_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT);

CREATE TABLE media(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, mime TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT, duration REAL, width INTEGER, height INTEGER, source TEXT NOT NULL DEFAULT 'upload', storage_key TEXT NOT NULL, thumbnail_key TEXT, created_at TEXT, deleted_at TEXT);

CREATE TABLE credit_accounts(workspace_id TEXT PRIMARY KEY, balance REAL NOT NULL DEFAULT 0, held REAL NOT NULL DEFAULT 0, updated_at TEXT);
CREATE TABLE credit_ledger(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, held_delta REAL NOT NULL DEFAULT 0, balance_after REAL NOT NULL, held_after REAL NOT NULL, job_id TEXT, provider_cost REAL, platform_cost REAL, note TEXT, created_at TEXT);
CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger BEGIN SELECT RAISE(ABORT,'ledger is immutable'); END;
CREATE TRIGGER credit_ledger_no_delete BEFORE DELETE ON credit_ledger BEGIN SELECT RAISE(ABORT,'ledger is immutable'); END;
CREATE TABLE subscriptions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', period TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', created_at TEXT, updated_at TEXT);

CREATE TABLE generation_jobs(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, target_type TEXT, target_id TEXT, provider_id TEXT, model_id TEXT, model_version TEXT, compiled_prompt TEXT, parameters TEXT, input_refs TEXT, seed INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2, run_after TEXT, provider_task_id TEXT, estimated_cost REAL, actual_cost REAL, user_charge REAL, held REAL NOT NULL DEFAULT 0, duration_ms INTEGER, error TEXT, parent_job_id TEXT, fallback_chain TEXT, created_by TEXT, created_at TEXT, started_at TEXT, finished_at TEXT);
CREATE INDEX idx_jobs_status ON generation_jobs(status, run_after);
CREATE TABLE generation_outputs(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, media_id TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0, meta TEXT, created_at TEXT);
`,
    },
    {
        id: "0002_domain",
        sql: `
CREATE TABLE projects(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', schema_version INTEGER NOT NULL DEFAULT 1, canvas TEXT NOT NULL DEFAULT '{"schemaVersion":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"k":1}}', created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE worlds(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, created_at TEXT, updated_at TEXT);
CREATE TABLE looks(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project', scope_id TEXT, schema_version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, created_at TEXT, updated_at TEXT);
CREATE TABLE assets(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, schema_version INTEGER NOT NULL DEFAULT 1, approval_status TEXT NOT NULL DEFAULT 'draft', approved_version INTEGER, parent_asset_id TEXT, data TEXT NOT NULL, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE asset_versions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, approval_status TEXT NOT NULL, created_at TEXT, UNIQUE(asset_id,version));
CREATE TABLE refs(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, media_id TEXT, text TEXT, source TEXT NOT NULL DEFAULT 'upload', source_ref TEXT, created_at TEXT, deleted_at TEXT);
CREATE TABLE reference_bindings(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, reference_id TEXT NOT NULL, role TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, lock_level TEXT NOT NULL DEFAULT 'CONTROL', crop TEXT, notes TEXT, provider_compat TEXT, created_at TEXT);
CREATE INDEX idx_bind_target ON reference_bindings(target_type,target_id);
CREATE TABLE sequences(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, script TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE scenes(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence_id TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE shots(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence_id TEXT NOT NULL, scene_id TEXT, ord INTEGER NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'planned', data TEXT NOT NULL, hero_keyframe_id TEXT, approved_take_id TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE shot_states(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, shot_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, updated_at TEXT, UNIQUE(shot_id,kind));
CREATE TABLE state_deltas(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, shot_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at TEXT, updated_at TEXT);
CREATE TABLE keyframes(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, shot_id TEXT NOT NULL, job_id TEXT, media_id TEXT, status TEXT NOT NULL DEFAULT 'variant', meta TEXT NOT NULL DEFAULT '{}', created_at TEXT, deleted_at TEXT);
CREATE TABLE takes(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, shot_id TEXT NOT NULL, keyframe_id TEXT, job_id TEXT, media_id TEXT, status TEXT NOT NULL DEFAULT 'candidate', meta TEXT NOT NULL DEFAULT '{}', created_at TEXT, deleted_at TEXT);
CREATE TABLE approval_events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, scope_id TEXT, action TEXT NOT NULL, reason TEXT, actor_id TEXT, created_at TEXT);
CREATE TABLE continuity_issues(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, shot_id TEXT NOT NULL, related_shot_id TEXT, category TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, repair TEXT, status TEXT NOT NULL DEFAULT 'open', override_reason TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE qc_reports(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, shot_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, score REAL, findings TEXT NOT NULL, created_at TEXT);
CREATE TABLE repair_actions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, qc_report_id TEXT, issue_id TEXT, shot_id TEXT NOT NULL, action TEXT NOT NULL, cause TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'suggested', created_at TEXT);
`,
    },
    {
        id: "0003_team_billing_assembly",
        sql: `
CREATE TABLE workspace_invites(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, UNIQUE(workspace_id,email));
CREATE TABLE oauth_identities(provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY(provider,subject));
ALTER TABLE providers ADD COLUMN webhook_secret TEXT;
CREATE TABLE webhook_events(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, provider_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT);
CREATE TABLE payments(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, amount_usd REAL NOT NULL, credits REAL NOT NULL, provider TEXT NOT NULL, provider_ref TEXT, status TEXT NOT NULL, created_at TEXT, updated_at TEXT);
ALTER TABLE subscriptions ADD COLUMN period_end TEXT;
ALTER TABLE media ADD COLUMN proxy_key TEXT;
CREATE TABLE renders(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence_id TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT, media_id TEXT, error TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
`,
    },
    {
        id: "0004_p3",
        sql: `
CREATE TABLE sso_connections(id TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL, secret_enc TEXT NOT NULL, domains TEXT NOT NULL DEFAULT '[]', workspace_id TEXT, role TEXT NOT NULL DEFAULT 'EDITOR', enforce INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE TABLE timelines(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE TABLE skills(id TEXT PRIMARY KEY, workspace_id TEXT, slug TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, author TEXT, description TEXT, manifest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', created_by TEXT, created_at TEXT, updated_at TEXT, UNIQUE(slug,version));
CREATE TABLE skill_installs(workspace_id TEXT NOT NULL, skill_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, installed_by TEXT, installed_at TEXT, PRIMARY KEY(workspace_id,skill_id));
`,
    },
    {
        id: "0005_usage",
        sql: `
CREATE TABLE usage_events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, provider_id TEXT, model_id TEXT, units REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT 'call', cost_usd REAL, status TEXT NOT NULL DEFAULT 'ok', duration_ms INTEGER, project TEXT, detail TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_usage_ws_time ON usage_events(workspace_id, created_at);
`,
    },
    {
        id: "0006_workspaceProjects",
        sql: `CREATE TABLE workspace_project_links(workspace_id TEXT NOT NULL, directory TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(workspace_id,directory));`,
    },
    {
        id: "0007_realismReview",
        sql: `ALTER TABLE qc_reports ADD COLUMN evidence TEXT NOT NULL DEFAULT '{}';`,
    },
    {
        id: "0008_passwordLogin",
        sql: `CREATE TABLE user_passwords(user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    },
    {
        id: "0009_realismAssets",
        sql: `
-- 抽卡候选池：一批生成 = 一个候选批次，胜出者晋升为资产权威参考，摊薄后续镜头成本。
CREATE TABLE candidate_batches(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, asset_id TEXT, shot_id TEXT, kind TEXT NOT NULL, prompt_fingerprint TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE INDEX idx_batches_project ON candidate_batches(workspace_id, project_id);
CREATE TABLE candidates(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, batch_id TEXT NOT NULL, asset_id TEXT, keyframe_id TEXT, take_id TEXT, media_id TEXT, status TEXT NOT NULL DEFAULT 'candidate', scores TEXT NOT NULL DEFAULT '{}', findings TEXT NOT NULL DEFAULT '[]', promoted INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT);
CREATE INDEX idx_candidates_batch ON candidates(batch_id);
-- 租户级资产库：项目级资产采用后入池，跨项目复用同一张定妆脸，解决「同角色跨项目崩脸」。
CREATE TABLE library_assets(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_asset_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, persona_tags TEXT NOT NULL DEFAULT '{}', reuse_count INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE INDEX idx_library_type ON library_assets(workspace_id, type);
`,
    },
];

export const db = await openSqlite(config.dbFile);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000;");

export function migrate() {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT)");
    const done = new Set((db.prepare("SELECT id FROM schema_migrations").all() as Row[]).map((r) => r.id));
    for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        db.exec("BEGIN");
        try {
            db.exec(m.sql);
            db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(m.id, now());
            db.exec("COMMIT");
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
    }
}
migrate();

export const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
export const get = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

let depth = 0;
/** Re-entrant transaction: the outermost call BEGINs, nested calls use SAVEPOINTs. */
export function tx<T>(fn: () => T): T {
    const sp = `sp${depth}`;
    db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    depth++;
    try {
        const r = fn();
        depth--;
        db.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
        return r;
    } catch (e) {
        depth--;
        db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
    }
}

export function setting<T>(key: string, fallback: T): T {
    const r = get("SELECT value FROM system_settings WHERE key=?", key);
    return r ? JSON.parse(r.value) : fallback;
}
export function setSetting(key: string, value: unknown) {
    run("INSERT INTO system_settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", key, j(value), now());
}

/** Tables that carry JSON in a column; repo flattens it into API objects. */
const JSON_COLS: Record<string, string[]> = {
    worlds: ["data"], looks: ["data"], assets: ["data"], sequences: ["data"], scenes: ["data"], shots: ["data"],
    shot_states: ["data"], state_deltas: ["data"], keyframes: ["meta"], takes: ["meta"], qc_reports: ["findings", "evidence"],
    projects: ["canvas"], asset_versions: ["snapshot"], reference_bindings: ["crop", "provider_compat"],
    generation_jobs: ["parameters", "input_refs", "fallback_chain"], renders: ["manifest"], timelines: ["data"], generation_outputs: ["meta"], continuity_issues: ["repair"],
    candidates: ["scores", "findings", "meta"], library_assets: ["data", "persona_tags"],
};
export const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

export function hydrate(table: string, r: Row | undefined): Row | undefined {
    if (!r) return r;
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
        if (JSON_COLS[table]?.includes(k) && typeof v === "string") {
            const parsed = JSON.parse(v);
            // "data"-style blobs are flattened into the object; others stay under their own key.
            if (k === "data") Object.assign(out, parsed);
            else out[camel(k)] = parsed;
        } else out[camel(k)] = v;
    }
    return out;
}

/**
 * Workspace-scoped repository. Every read/write on a tenant table goes through
 * here so that workspace_id is enforced server-side, never by the UI.
 */
export function scoped(workspaceId: string) {
    const live = (table: string) => (["assets", "projects", "sequences", "scenes", "shots", "keyframes", "takes", "refs", "media", "library_assets"].includes(table) ? " AND deleted_at IS NULL" : "");
    return {
        workspaceId,
        get(table: string, id: string, includeDeleted = false) {
            return hydrate(table, get(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?${includeDeleted ? "" : live(table)}`, id, workspaceId));
        },
        list(table: string, where: Record<string, any> = {}, order = "created_at") {
            const keys = Object.keys(where);
            const cond = keys.map((k) => `${snake(k)}=?`).join(" AND ");
            const rows = all(`SELECT * FROM ${table} WHERE workspace_id=?${live(table)}${cond ? " AND " + cond : ""} ORDER BY ${order}`, workspaceId, ...keys.map((k) => where[k]));
            return rows.map((r) => hydrate(table, r)!);
        },
        insert(table: string, row: Row) {
            const rec = { id: ulid(), created_at: now(), ...row, workspace_id: workspaceId } as Row;
            const cols = Object.keys(rec);
            run(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, ...cols.map((c) => (rec[c] !== null && typeof rec[c] === "object" ? j(rec[c]) : rec[c])));
            publishChange(table, rec.id, workspaceId, rec.project_id ?? null);
            return this.get(table, rec.id, true)!;
        },
        update(table: string, id: string, patch: Row) {
            const cols = Object.keys(patch).map(snake);
            if (cols.length) {
                const vals = Object.values(patch).map((v) => (v !== null && typeof v === "object" ? j(v) : v));
                const hasUpdated = colsOf(table).includes("updated_at");
                run(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(",")}${hasUpdated ? ",updated_at=?" : ""} WHERE id=? AND workspace_id=?`, ...vals, ...(hasUpdated ? [now()] : []), id, workspaceId);
            }
            const out = this.get(table, id, true)!;
            publishChange(table, id, workspaceId, (out as any)?.projectId ?? null);
            return out;
        },
        softDelete(table: string, id: string) {
            run(`UPDATE ${table} SET deleted_at=? WHERE id=? AND workspace_id=?`, now(), id, workspaceId);
            if (TRACKED.has(table)) publishChange(table, id, workspaceId, table === "projects" ? id : ((get(`SELECT project_id FROM ${table} WHERE id=?`, id) as any)?.project_id ?? null));
        },
    };
}
const colCache = new Map<string, string[]>();
const colsOf = (t: string) => colCache.get(t) ?? (colCache.set(t, all(`PRAGMA table_info(${t})`).map((c) => c.name)), colCache.get(t)!);
export type Scope = ReturnType<typeof scoped>;

export function audit(actorId: string | null, action: string, target?: string, detail?: unknown, workspaceId?: string) {
    run("INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?)", ulid(), actorId, workspaceId ?? null, action, target ?? null, j(detail), now());
}
