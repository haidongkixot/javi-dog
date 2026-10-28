# Sprint 04b — Usage analytics (JD-M08)

- Dates: 2026-10-28 (timebox 30 min) · Status: **ACTIVE**
- Goal: owners see 14-day token trends (with estimated cost), usage by model and by project, and task outcomes — from stored JGR events, workspace-scoped.
- Modules touched: JD-M08 (new), JD-M06 (migration 0004), JD-APP, docs
- Readiness gate: migration 0004 (index only) on `dev-agent` after the deploy; production has no usage events until the owner's first real run
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S4b (written before the lanes start) · ADR-0013

## Global constraints

- Cost is always labelled **estimated**; tokens are exact. No chart of zeros presented as measured usage.
- Workspace isolation; L0 only; UTC days labelled as UTC.
- Charts: inline SVG per the `dataviz` skill + a table equivalent; brand tokens only; screenshot budget **0**. No new dependency.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| M1 | Index `(workspace_id, received_at)` | JD-M06 | migration 0004 + rollback | Up/down tested on PGlite; drift clean; applied to `dev-agent` after deploy | Done (code) |
| A1 | Analytics read model | JD-M08 | events → `createAnalyticsReader(db).usage(workspaceId, opts)` | Rules of ADR-0013: UTC days zero-filled, clamp 1–30, by model/project, tasks, totals, `lastReportAt`, DB clock, project filter inside the workspace | Planned |
| W3 | Overview chart + project usage | JD-APP | analytics → Overview "Token consumption", Project detail usage | Chart + table equivalent; estimated-cost label; empty state "No usage reports in the last 14 days"; computed-at time | Planned |
| Q2 | Analytics vectors (QA, independent) | docs | `docs/jgr/conformance/analytics/*.json` | From ADR-0013 + JGR §6 text only | Planned |

## Review focus

- A usage report at 23:59:59.999 UTC and one at 00:00:00.000 land on different days (A1).
- `projectId` of another workspace → empty result, never that project's data (A1).
- No usage at all → the chart is not drawn as a flat zero line; empty state instead (W3).
- Cost shown anywhere without "estimated" (W3).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | ADR-0013, M1 migration, package scaffold, docs, merge, push, migration on `dev-agent` |
| Developer A | general-purpose, worktree | A1: `packages/analytics/src/reader.ts` (+ private modules), `packages/analytics/test/**` |
| Developer B | general-purpose, worktree | W3: `apps/web/src/components/analytics/**`, `apps/web/src/app/page.tsx`, `apps/web/src/components/dashboard/overview-view.tsx`, `apps/web/src/app/projects/[id]/page.tsx`, `apps/web/src/lib/analytics.ts`, `apps/web/test/analytics*.test.ts(x)` |
| QA | general-purpose, worktree | Q2: `docs/jgr/conformance/analytics/**` |
| Reviewer | general-purpose, read-only | combined diff |

Team log, newest first:

- 2026-10-28 — Orchestrator — ADR-0013 (no owner question: within the approved roadmap, no dependency or cost); JD-M08 scaffold with contract types; migration 0004 generated (`db:generate --name`), rollback written, up/down tests (event-store 47). Screenshot budget 0.

## Log

- 2026-10-28 — Sprint start (plan, scaffold, migration 0004 code).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `vitest run` (event-store, after 0004) | 0 | — | 47 | 0 | 0 | 0 | 0 | — |
| `db:generate` drift after 0004 | 0 | — | no changes | — | — | — | — | — |

## Decisions and deviations

- No new navigation space: analytics live in Overview and Project detail (brand guide §8 five spaces).

## Retro

- Pending.

## Guru checkpoint

G3 after S4c.
