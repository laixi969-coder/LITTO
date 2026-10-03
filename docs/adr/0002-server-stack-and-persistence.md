# ADR 0002 — Server stack, persistence, tenancy

**Status:** accepted · **Phase 1**

- **Hono + Node 22+/25, TypeScript, zod** — small, standard, testable via `app.request()`. Dev runner `tsx`.
- **SQLite via `node:sqlite`** (zero native deps, WAL). The schema uses ULID text ids, `createdAt/updatedAt/deletedAt`, and is portable to Postgres: no SQLite-only types, JSON stored as TEXT. Production Postgres is a driver swap in `db.ts` (`all/get/run/tx/scoped`), not a redesign. *Trade-off:* single-writer; fine for V1/self-host, the queue's claim step is the first thing to move to `SELECT … FOR UPDATE SKIP LOCKED`.
- **Migrations:** ordered ids in `schema_migrations`, each applied in a transaction (`db.ts`). Every schema change = a new migration; none are edited in place.
- **Tenancy:** every tenant table has `workspace_id`; handlers only get a repository from `scoped(workspaceId)` where the workspace comes from the *session* (+ verified membership for `X-Workspace-Id`), never from the body. Cross-tenant ids return 404 (not 403) to avoid existence leaks.
- **Core semantics are tables, not canvas metadata** (PRD §1 rule): canvas JSON is `{nodes:[{id,kind,refId,x,y}],edges,viewport}` only.
- **`schemaVersion`** on projects, worlds, looks, assets, shots (and canvas JSON).
- **Auth:** email OTP (hashed, 10 min, 5 attempts), opaque session tokens stored hashed, HttpOnly SameSite=Lax cookie + `X-OVIA-CSRF` header on cookie-authenticated mutations; `Authorization: Bearer` for API clients. OAuth/SSO = P2.
- **Secrets:** AES-256-GCM, master key from `OVIA_MASTER_KEY` (dev: generated file, 0600). API responses carry only `••••last4`; logger redacts key-shaped strings; audit logs never receive secrets. Test `4 BYOK` greps the DB+WAL bytes for plaintext.
- **Ledger:** append-only, enforced by SQLite triggers; `balance`/`held` snapshots on each row. Provider cost, platform cost and user charge are separate columns.
- **Media:** `StorageAdapter` (local FS implemented; S3/MinIO = implement 4 methods). Type by magic bytes; signed expiring URLs; SVG served with a sandbox CSP.
