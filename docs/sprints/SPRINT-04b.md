# Sprint 04b — Usage analytics (JD-M08)

- Dates: 2026-10-28 (timebox 30 min) · Status: **BUILT** — closes with CI green on the push
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
| M1 | Index `(workspace_id, received_at)` | JD-M06 | migration 0004 + rollback | Up/down tested on PGlite; drift clean; applied to `dev-agent` after deploy | Done |
| A1 | Analytics read model | JD-M08 | events → `createAnalyticsReader(db).usage(workspaceId, opts)` | Rules of ADR-0013: UTC days zero-filled, clamp 1–30, by model/project, tasks, totals, `lastReportAt`, DB clock, project filter inside the workspace | Done |
| W3 | Overview chart + project usage | JD-APP | analytics → Overview "Token consumption", Project detail usage | Chart + table equivalent; estimated-cost label; empty state "No usage reports in the last 14 days"; computed-at time | Done |
| Q2 | Analytics vectors (QA, independent) | docs | `docs/jgr/conformance/analytics/*.json` | From ADR-0013 + JGR §6 text only | Done |

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

- 2026-10-28 — Orchestrator — Merged review fixes (`3eb5852`); changeset, ADR-0013 Changes (incl. nits 6–8 documented), module provides.
- 2026-10-28 — Developer — Review fixes 1–5, tests first: red analytics 14 / web 18 FAIL, then green (analytics 58 ×2, web 214 ×2); conformance runner unchanged and passing.
- 2026-10-28 — Reviewer — no blockers; 1 major (usage ages freeze on an open page — rule 2), 4 minor (estimated counts ignored, month labels collide, series identity, `byProject` computed but unused), 3 nits; verified isolation, UTC bucketing in 3 time zones, cost rounding, index use (92k events), 0004 hash.
- 2026-10-28 — Orchestrator — Runner `packages/analytics/test/analytics-conformance.test.ts`: 23/23 on first run. Mutations: bucketing by `occurred_at` → only vector 10 FAIL; workspace filters removed → only 19, 20, 23 FAIL; restored. Merged W3 (`1af5ad1`). Full gate 865 tests. Contract wording: a filtered project appears in `byProject` only with usage (A1 lane question, QA A6).
- 2026-10-28 — Developer B — W3: grouped columns (input vs output per UTC day, one axis — dataviz: pairs compare day to day), violet + deep-mint `positive` (brand mint #A0EBC2 failed the palette validator at 1.35:1), table toggle, "Estimated cost" everywhere; 34 tests. NOT verified: rendered layout at the breakpoints (screenshot budget 0).
- 2026-10-28 — QA — 23 vectors, A1–A12 (fractional `days` not tested: ADR silent on rounding).
- 2026-10-28 — Developer A — A1: 3 queries (+ DB clock), 30 tests; mutation (workspace filter) → 2 FAIL; EXPLAIN: with a second busy workspace all queries use `events_workspace_received_idx`.
- 2026-10-28 — Orchestrator — Migration 0004 applied to `dev-agent` after deploy `0a02c57` READY: health 5 migrations, `db:smoke` 10/10.
- 2026-10-28 — Orchestrator — ADR-0013 (no owner question: within the approved roadmap, no dependency or cost); JD-M08 scaffold with contract types; migration 0004 generated (`db:generate --name`), rollback written, up/down tests (event-store 47). Screenshot budget 0.

## Log

- 2026-10-28 — Sprint start (plan, scaffold, migration 0004 code); pushed `0a02c57` (CI 40648378728 PASS), `cd23c29` (CI 40649033508 PASS).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `vitest run` (event-store, after 0004) | 0 | — | 47 | 0 | 0 | 0 | 0 | — |
| `db:generate` drift after 0004 | 0 | — | no changes | — | — | — | — | — |
| `db:migrate` 0004 + `db:smoke` (dev-agent) | 0 | — | 10 | 0 | 0 | 0 | 0 | health: 5 migrations |
| `pnpm --filter @javis-dog/analytics test` (Developer A, 2 runs) | 0 | — | 31 | 0 | 0 | 0 | 0 | — |
| Analytics runner | 0 | — | 24 | 0 | 0 | 0 | 0 | 23 vectors + count |
| Mutation: bucket by `occurred_at` | 1 | — | 23 | 1 | 0 | 0 | 0 | vector 10 only |
| Mutation: workspace filters removed | 1 | — | 21 | 3 | 0 | 0 | 0 | 19, 20, 23 only |
| `pnpm --filter @javis-dog/web test` (Developer B, 2 runs) | 0 | — | 194 | 0 | 0 | 0 | 0 | analytics 34 |
| Full gate (`format`/`lint`/`typecheck`/`test`/`build`/`docs`) | 0 | — | 865 | 0 | 0 | 0 | 0 | before review |
| Review fixes: new tests against the old code (red first) | 1 | — | 73 | 32 | 0 | 0 | 0 | analytics 14 + web 18 |
| Rendered chart layout at 1150 / 850 / 560 px | — | — | — | — | — | — | 1 | screenshot budget 0; owner may approve a bounded visual check |

## Decisions and deviations

- No new navigation space: analytics live in Overview and Project detail (brand guide §8 five spaces).

## Retro

- Went well: QA vectors passed first time and mutation checks proved they bite; the Reviewer verified UTC bucketing across time zones and index use at volume.
- Hurt: a relative "ago" on a server-rendered card repeated S4a's truthfulness bug in a new component — the rule lived in one hook, not in a shared component.
- Change next sprint: one shared time-display component for every signal/report time; the protocol's `estimated` flag is checked whenever numbers are presented as exact.

## Guru checkpoint

G3 after S4c.
