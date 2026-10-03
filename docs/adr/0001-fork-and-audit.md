# ADR 0001 — Fork baseline & audit of upstream

**Status:** accepted · **Phase 0**

## Baseline
- Upstream: https://github.com/basketikun/infinite-canvas, locked at **`dab19adc0847e32e39b7fc8ff90cb392561fb826`** (see `UPSTREAM_SHA`). Imported as-is into this repo; `web/` is the untouched upstream app plus additive files.
- References (BeatDesign, polox_ai) were not vendored; they remain design references for the Phase 5 timeline.

## Audit findings (what upstream is)
| Area | Reality in upstream | Consequence |
|---|---|---|
| Runtime | Vite + React 19 + antd 6 + Tailwind 4 + Zustand, **pure browser app**, "no project backend" (AGENTS.md) | PRD §4/§14–§23 (users, tenants, credentials, queue, ledger, admin) cannot live in the browser. A server is **new**, not a refactor. |
| Canvas | `web/src/components/canvas/*`, store `stores/canvas/use-canvas-store.ts`, node registry `lib/canvas/node-registry.ts`; project JSON = `nodes[] + connections[]`, persisted via localforage | Kept intact and reachable at `/canvas`. FilmFlow does not fork its node model. |
| Generation | `services/api/{image,video,audio}.ts` call providers directly from the browser with user keys in localStorage/config | Opposite of PRD §15 (keys never in client). FilmFlow routes all generation through the server. |
| Agent / MCP | `canvas-agent/` (local agent), `lib/canvas/canvas-agent-ops.ts`, `plugins/` (Codex plugin) | Untouched; future work can expose domain ops as agent tools. |
| Plugin SDK | `lib/canvas/plugin-*.ts`, `types/canvas-plugin.ts`; nodes typed `"<pluginId>:<name>"` | The sanctioned extension point for domain nodes on the *upstream* canvas (see ADR 0003). |
| Tests | One bun test (`web/tests/image-thumbnail.test.ts`) | Baseline = that test + `tsc --noEmit` + `vite build`. |
| Conventions | AGENTS.md: terse code, Chinese UI copy, antd theme tokens, localforage for business data | Followed for all new web code. Note: AGENTS.md says "no migrations / no need to build" — that applies to upstream's local storage; FilmFlow's server DB *does* have migrations (PRD §22) and we do run build/typecheck/tests. |

## Decision
Add, don't rewrite:
- `server/` — new TypeScript service (domain, platform, admin).
- `web/src/pages/studio/**`, `web/src/layouts/studio-layout.tsx`, `web/src/services/api/filmflow.ts`, `web/src/stores/use-filmflow-store.ts` — new FilmFlow UI. Only `router.tsx` and `vite.config.ts` (dev proxy) of upstream were edited.
- Upstream updates flow in by merging `web/` normally; the only conflict surface is those two files. `importLegacyCanvas()` (server/src/legacy.ts) is the adapter for upstream's project JSON.
