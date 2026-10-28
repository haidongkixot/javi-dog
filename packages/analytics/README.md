# JD-M08 · `@javis-dog/analytics` — usage analytics

Status: **in-progress** (S4b, ADR-0013). Daily UTC aggregates of tokens, estimated cost and task outcomes, by model and by project, from stored JGR events of one workspace.

| Export | Description |
|---|---|
| `createAnalyticsReader(db).usage(workspaceId, { days?, projectId?, now? })` | `UsageAnalytics` for the last `days` UTC days (default 14, max 30) |
| `ANALYTICS_DEFAULT_DAYS`, `ANALYTICS_MAX_DAYS` | Constants |

Cost is the sum of producer-reported `cost_usd` and is always an **estimate**.
