# ADR 0003 — How the production domain relates to the infinite canvas

**Status:** accepted (supersedes the earlier "known gap" note) · **Phase 2**

PRD §0/§28 forbid rewriting the canvas and want domain nodes on it. Upstream already has the sanctioned extension point: the **Plugin SDK** (`plugins/canvas/sdk`, host contract `web/src/types/canvas-plugin.ts`).

**Decision:** domain nodes are an upstream canvas plugin, `plugins/canvas/litto` (id `litto`), registering `litto:project`, `litto:world`, `litto:look`, `litto:asset`, `litto:shot`. Zero changes to the canvas engine; one line in `plugin-loader.ts` enables this plugin by default.

Rules that keep PRD §1 ("core semantics never only in node metadata") true:
- A node's metadata is **only** `{ littoProjectId, littoKind, littoId }`. Content and Panel read/write the LITTO server (`/litto-api`, cookie session); the domain tables stay the source of truth.
- **Edges are gestures, the domain is truth.** Connecting an Asset node into a Shot node adds that asset to the shot's `assetIds` (reconciled in `ShotContent`). Shot→Shot edges mean state flow. Connecting an upstream *image* node to a Shot offers "register as Reference + bind role" (Reference Routing from existing nodes). Disconnecting does **not** silently remove domain data.
- The hub node (`litto:project`) pulls the project's domain objects onto the canvas idempotently (deterministic node ids) and can run the Director on a pasted script.
- Mutations broadcast `litto:changed` on the plugin event bus so every LITTO node refreshes.

**Limits:** upstream connections have no labels, so edge *semantics* are implied by node types rather than drawn; node panels cover the golden path (spec, bind, keyframes/Hero, takes/approve + continuity override, asset approve/version/rollback, World/Look) while QC diagnosis, state view and history stay in the `/studio` workbench. The `/studio` workbench keeps its own domain canvas as a standalone view.
