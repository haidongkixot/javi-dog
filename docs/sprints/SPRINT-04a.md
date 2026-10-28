# Sprint 04a — Live state: read model, freshness and the real dashboard

- Dates: 2026-10-28 (timebox 30 min) · Status: **ACTIVE**
- Goal: Overview, Projects and Live agents show real, workspace-scoped JGR state with honest freshness, refreshed every 10 s.
- Modules touched: JD-M07 (new), JD-APP, docs
- Readiness gate: owner decision "Polling, 10 s" (ADR-0012); production has no real events until the owner's first run, so pages must render correct empty states
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S4a (written before the lanes start)
- Split of roadmap S4: **S4a** live state (this) · **S4b** analytics (JD-M08) · **S4c** budgets, forecast, exhaustion + email alerts (JD-M12) · then Guru G3

## Global constraints

- Product rules 2 and 4: every value shows its source and last signal time with a stale state; nothing is called live; no sample data.
- Workspace isolation: the workspace comes from the session + membership, never from request input.
- L0 only: no attribute other than `tool_name` is displayed; refs stay opaque.
- Brand: `docs/brand/BRAND_GUIDE.md`, `.claude/skills/javis-dog-brand`; accessibility per `web-design-guidelines`. Screenshot budget **0**.
- No new external dependency.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| R1 | Read model | JD-M07 | events, projects → `createDashboardReader(db).snapshot(workspaceId)`, `threadFreshness()` | Rules of ADR-0012 (freshness 180 s inclusive, ended, attention, counters, 24 h window, 25 activity items, DB clock); never returns another workspace's data | Planned |
| W1 | Snapshot route + polling hook | JD-APP | reader → `GET /api/dashboard/snapshot`; `useDashboardSnapshot(initial)` | 401 signed out, 503 without DB, `no-store`; polls every 10 s while visible, pauses when hidden; failed refresh keeps data + visible notice | Planned |
| W2 | Pages | JD-APP | snapshot → Overview, Live agents, Projects | Real values with last-signal time and stale/ended labels; empty states when no data; attention visible within a 3-second scan | Planned |
| Q1 | State vectors (QA, independent) | docs | `docs/jgr/conformance/state/*.json` | Event sequences → expected thread state / counters, from JGR §5 + ADR-0012 text only | Planned |

## Review focus

- A thread waiting for permission goes quiet for 5 min → still shows "waiting", labelled stale, counted as needing attention (R1/W2).
- Another workspace's project id or events never appear in a snapshot (R1, W1).
- The poll fails (network, 500) → last data stays with a "could not refresh" notice, never silently old (W1).
- A session that ended an hour ago is "ended", not "stale" (R1).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | ADR-0012, package scaffold + contract types, `package.json`/lockfile/`next.config.ts`, docs, merge, push |
| Developer A | general-purpose, worktree | R1: `packages/realtime/src/reader.ts`, `packages/realtime/test/**` |
| Developer B | general-purpose, worktree | W1 + W2: `apps/web/src/app/{page.tsx,agents/**,projects/page.tsx,api/dashboard/**}`, `apps/web/src/components/dashboard/**`, `apps/web/src/lib/dashboard.ts`, `apps/web/test/dashboard*.test.ts(x)` |
| QA | general-purpose, worktree | Q1: `docs/jgr/conformance/state/**` |
| Reviewer | general-purpose, read-only | combined diff; isolation, freshness truthfulness, accessibility |

Team log, newest first:

- 2026-10-28 — Orchestrator — Owner chose 10 s polling over SSE windows (ADR-0012; roadmap said SSE — deviation recorded). Vercel plan UNKNOWN (not visible via the API). Scaffolded JD-M07 with the snapshot contract (`src/types.ts`) and stubs; lockfile adds the workspace importer only. Screenshot budget 0.

## Log

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|

## Decisions and deviations

- Roadmap says "JD-M07 SSE"; owner chose polling (ADR-0012). The snapshot API can be wrapped in SSE later.

## Retro

## Guru checkpoint

G3 after S4c.
