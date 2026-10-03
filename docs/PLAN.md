# OVIA（有戏）implementation plan & status

Source of truth: `AI_Virtual_Production_Infinite_Canvas_FINAL_PRD.md`. Status is against PRD §24–§26.

| Phase | Scope | Status |
|---|---|---|
| 0 Fork & Audit | lock SHA, audit, baseline | ✅ ADR 0001 |
| 1 Platform foundation | auth, workspace, tenancy, storage, credentials, provider/model registry, queue, admin | ✅ |
| 2 Production foundation | World/Look (+sequence/shot overrides), assets (versions/approval/rollback), references+bindings, sequence/scene/shot, keyframe/hero/take | ✅ |
| 3 Intelligence | rule-based skills (structured), Director Agent, capability router, prompt compiler, **LLM refine layer** (optional, validated, falls back to rules) | ✅ |
| 4 Continuity & QC | state deltas, continuity rules, failure diagnosis (human **and vision-model** observations), repair actions, approval gate | ✅ |
| 5 Assembly | shot strip, timeline, subtitles, audio refs, EDL/SRT/ZIP export, ffmpeg MP4 render, storyboard grids | ✅ |

## P2 (done)
OAuth (GitHub/Google/Apple), team workspaces + full RBAC + invites, auto model routing/fallback, more reference controls, proxy video + thumbnails (ffmpeg), chunked resumable upload API, basic timeline, subscriptions (Free/Monthly/Quarterly/Annual/Custom) + credit packs + Stripe/Mock payments, provider webhooks, metrics (`/admin/metrics.txt`).

## Not done (honest list)
- **P3**: advanced NLE, real-time multi-user collaboration, enterprise SSO (SAML/OIDC), 3D/Depth/360, professional color/sound, marketplace / third-party skills.
- **P2 leftovers**: Apple/Google/Stripe live flows are implemented to spec but only the GitHub-shaped flow and Stripe signature handling are exercised by automated tests (no live credentials here).
- Vision QC and LLM refinement are verified for plumbing with the mock text model; quality against real models is untested.
- Domain nodes on the upstream canvas live in the `ovia` plugin (ADR 0003); upstream connection lines cannot show labels.
