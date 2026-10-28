---
'@javis-dog/analytics': minor
'@javis-dog/event-store': minor
'@javis-dog/web': minor
---

S4b usage analytics (ADR-0013): new JD-M08 `@javis-dog/analytics` — `createAnalyticsReader(db).usage(workspaceId, { days, projectId, now, include })` with per-UTC-day tokens, estimated cost, task outcomes, by model and by project, `estimatedReports`. JD-M06 migration 0004 `events_workspace_received_idx`. JD-APP: Overview token chart (grouped columns + table), usage by project, Project detail usage; every cost labelled estimated; absolute UTC stamps.
