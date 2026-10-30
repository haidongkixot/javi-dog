# JD-M07 · `@javis-dog/realtime` — dashboard read model

Status: **in-progress** (S4a, ADR-0012). Derives thread state, freshness, overview counters, the activity feed and project health from stored JGR events, scoped to one workspace. JD-APP serves it as a snapshot the browser polls every 10 s.

| Export | Description |
|---|---|
| `createDashboardReader(db).snapshot(workspaceId, { now? })` | `DashboardSnapshot` for the last 24 h, times from the database clock |
| `threadFreshness(lastType, lastSignalAt, now)` | `ended` / `fresh` / `stale` (180 s window, JGR §5) |
| `FRESHNESS_WINDOW_MS`, `SNAPSHOT_WINDOW_HOURS`, `ACTIVITY_LIMIT` | Constants |
| `STATUS_REASONS` | Frozen list of self-report reasons; must equal JD-C02 `SELF_REPORT` (ADR-0017 §2) |

Agent self-report (S5d, ADR-0017 §6): a `heartbeat` with a status and a `tool_name` is the agent's own report. It sets the thread `status` until later collector activity (`task.*`, `session.*`, `agent.*`, or a `heartbeat working` without a `tool_name`) clears it. Threads and activity items carry `statusSource` (`agent` / `collector`) and `statusReason` (a listed reason from `error_code` `<status>.<reason>`, else null). A thread needs attention when its status is `waiting`, or `blocked` from the agent.
