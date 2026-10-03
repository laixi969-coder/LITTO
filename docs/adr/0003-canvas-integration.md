# ADR 0003 — How the production domain relates to the infinite canvas

**Status:** accepted (with a known gap) · **Phase 2**

PRD §0/§28 forbid rewriting the canvas, and say domain nodes should be the production surface. Upstream's canvas is tightly coupled to its image/video/text node types and its browser-only store.

**Decision:** V1 ships a *domain canvas* (`web/src/pages/studio/workbench/domain-canvas.tsx`) driven by the server's domain tables: World / Look / Asset / Shot nodes, semantic edges derived from real relations (uses, reference role, state flow, governs), pan/zoom, drag-to-move (persisted as layout-only JSON), Shift-marquee batch selection, and drag-reference-onto-shot binding. The upstream free canvas stays at `/canvas` for exploration; `importLegacyCanvas()` brings its nodes in as References/Assets.

**Gap (explicit, not silent):** the domain nodes are *not yet* registered into upstream's own canvas through its Plugin SDK. That is the next step if a single unified canvas is required; the domain API is already sufficient for a plugin to render and edit these nodes. Cost of doing it now: coupling the domain to upstream's store before its contracts stabilise.
