---
'@javis-dog/realtime': minor
'@javis-dog/web': minor
---

S4a live state (ADR-0012): new JD-M07 `@javis-dog/realtime` — `createDashboardReader(db).snapshot(workspaceId)` with thread state, freshness (stale after 180 s, JGR §5), `needsAttention` (waiting and not ended), overview counters, activity and project health. JD-APP: `GET /api/dashboard/snapshot` and real Overview, Live agents and Projects pages, polled every 10 s with an 8 s request timeout; values turn "Not current" when refreshes fail.
