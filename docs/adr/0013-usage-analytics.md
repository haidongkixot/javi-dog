# ADR-0013: Usage analytics — daily UTC aggregates, estimated cost, workspace index

- Status: **Accepted** 2026-10-28 (orchestrator, within the approved roadmap S4 "JD-M08 analytics"; no new dependency, no new cost)
- Date: 2026-10-28
- Deciders: Claude (orchestrator); owner informed via the sprint report
- Modules: JD-M08 (new, `@javis-dog/analytics`), JD-M06 (migration 0004), JD-APP; consumes JD-M06, JD-M04

## Context and problem statement

S4a shows the current state. Owners also need trends: how many tokens and how much (estimated) cost per day, per model and per project, and whether tasks complete or fail. Constraints: product rules 2–4 (source and freshness on every value, L0 only, no sample data); Claude Code says its cost metric is an approximation (ADR-0011); raw events are kept 30 days (ADR-0008); the S4a review measured a sequential scan for workspace-wide event reads (ADR-0012 Changes).

## Decision outcome

- **Read model (JD-M08).** `createAnalyticsReader(db).usage(workspaceId, { days = 14, projectId?, now? })` from `events` only (no rollup tables yet): per **UTC day** (zero-filled, oldest first) input / output / cache-read / cache-write tokens, `cost_usd` and report count from `usage.reported`; `task.completed` / `task.failed` counts per day; totals by model and by project; `lastReportAt`; `generatedAt` from the database clock. `projectId` narrows to one project **inside** the workspace (a project of another workspace yields nothing). `days` is clamped to 1–30 (retention).
- **Cost is always labelled "estimated"** wherever shown (Claude Code: "Cost metrics are approximations"); tokens are exact counts.
- **UI.** Overview "Token consumption": a 14-day chart (input and output tokens per day) with a data table equivalent, the period total and "last usage report …"; Project detail: usage by model for the project (tokens, estimated cost, reports) and 14-day task outcomes. Server-rendered on each visit (daily aggregates do not need 10 s polling); each block shows when it was computed. Charts are inline SVG following the `dataviz` skill (no chart library).
- **Index.** Migration **0004** adds `events_workspace_received_idx (workspace_id, received_at)` — serves the S4a snapshot and S4b analytics; applied to `dev-agent` after the deploy (ADR-0005 migration flow, rollback file).
- **Empty states.** No usage reports → "No usage reports in the last 14 days" (never a chart of zeros presented as measured usage).

## Consequences

- Positive: trends without new infrastructure; one index fixes both read paths.
- Negative: aggregation over raw events per page view (fine at current volume; rollups when needed); no hour granularity; UTC days may not match the viewer's local day (labelled UTC).

## Changes

- 2026-10-28 (S4b implementation): range = whole UTC days `[from 00:00, now]` bucketed by received time with `to_char(… at time zone 'UTC')` (independent of the session time zone — verified in three zones); costs summed as exact decimals and rounded to 6 places; a filtered project appears in `byProject` only with usage; a malformed or foreign `projectId` yields all zeros without a query.
- 2026-10-28 (S4b review, merged `3eb5852`): `UsageTotals.estimatedReports` — reports whose producer set `estimated: true`; when > 0 the UI says "Includes estimated token counts (N of M reports)", so tokens are only called exact when they are; usage cards show absolute UTC stamps (date shown unless it is the viewer's current UTC date, re-checked every minute) instead of relative ages that would freeze on an open page; chart axis labels never overlap, the legend names the column order, hover keeps ≥ 3:1 contrast; Overview shows "Usage by project" when ≥ 2 projects have usage; `include.byProject: false` skips that query on the project page.
- Documented, not changed: the 2–3 queries are separate statements (a batch committing between them can make totals and breakdowns differ by that batch until the next view); 0004 is a plain `CREATE INDEX` because drizzle's migrator runs in a transaction — a future index on a large table needs a manual `CREATE INDEX CONCURRENTLY` step; `cost_usd` has no upper bound in JGR v0.1 (proposal: cap it in the spec, S5).
