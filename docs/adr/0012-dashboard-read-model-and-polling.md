# ADR-0012: Dashboard read model, freshness and 10-second polling

- Status: **Accepted** 2026-10-28 (owner: "Polling, 10 s")
- Date: 2026-10-28
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules: JD-M07 (new, `@javis-dog/realtime`), JD-APP; consumes JD-M06, JD-M04

## Context and problem statement

S4 turns the empty Overview, Projects and Live agents pages into a real dashboard. Constraints:

- Product rule 2 *Live means verified*: every value shows its source, last update time and a stale state; nothing is called live without a fresh signal.
- JGR §5: `stale` is never sent; the receiver derives it when a thread sends nothing within its freshness window — default **3 × the heartbeat interval = 180 s**.
- The database is Neon over HTTP (no `LISTEN/NOTIFY`), so any "push" is server-side polling anyway. Agent signals already lag: hooks send on activity, OTel usage every 60 s.
- The Vercel plan is UNKNOWN; long-lived functions cost memory for their whole wall time under Fluid compute.

## Considered options

1. **Client polling of a JSON snapshot every 10 s** (paused while the tab is hidden).
2. Server-sent events in ~50 s windows, polling the DB every ~3 s per open tab.
3. Server rendering only, refreshed by navigation.

## Decision outcome

**Option 1** (owner, 2026-10-28). Short requests on any plan, cheapest, simplest to test. The snapshot API can later be wrapped in SSE without changing the UI (roadmap wording "SSE" is satisfied in spirit; recorded as a deviation).

- **Read model (JD-M07).** `createDashboardReader(db).snapshot(workspaceId, opts)` derives everything from `events` and `projects` with workspace-scoped SQL — no new tables. Window: events received in the last 24 h. All times come from the **database clock** (`now()`), returned as `generatedAt`.
- **Thread state.** Per `(project, thread_ref)` in the window: last received time, last event type, last non-null `status`, distinct `agent_ref` count, completed tasks, input/output tokens. **Freshness:** `ended` when the last event is `session.ended`; else `fresh` when `generatedAt − lastSignalAt ≤ 180 s`; else `stale`. **Attention** = the latest status-bearing event has status `waiting`. Status and freshness are shown together (a waiting thread that went stale still shows "waiting", labelled stale) — never hidden, never called live.
- **Overview counters** (each with `lastSignalAt`): active projects = projects with ≥ 1 fresh thread; agents working = fresh threads whose status is `working`; token burn = input + output tokens reported in the last 60 min (from `usage.reported`, which only exists for attributed sessions, ADR-0011); tasks completed = `task.completed` events in 24 h.
- **Activity feed:** the 25 most recent events in the window: time, project, opaque thread ref, type, status, `tool_name` (the only attribute shown; L0 allowlist).
- **Projects:** every workspace project with `last_signal_at`, fresh/stale/never, fresh threads and threads needing attention.
- **Transport.** `GET /api/dashboard/snapshot` (session cookie; workspace from the session + membership, never from input; `401` signed out; `Cache-Control: no-store`; `503` without a database). Pages render the first snapshot on the server; a client hook re-fetches every 10 s while visible. A failed refresh keeps the last data with a visible "could not refresh — showing data from HH:MM:SS" notice.
- **Privacy.** Only L0 data exists; thread and agent refs are opaque hashes; no attribute other than `tool_name` is read.
- **Cost/performance.** One snapshot = 3 workspace-scoped queries over ≤ 24 h (+ 1 for the DB clock). Measured on PGlite (review, 10 000 events per workspace): the thread aggregate is a sequential scan and the activity query uses `events_received_idx` then filters by workspace, so cost grows with every tenant's 24 h volume; ~80 ms at that size. A `(workspace_id, received_at)` index is deferred to S4b, where the analytics queries decide its exact shape.

## Consequences

- Positive: honest freshness on every value; works on any plan; testable on PGlite and with jsdom.
- Negative: up to 10 s extra latency; one small request per open tab every 10 s; no push for alerts (S4c uses email).
- Usage numbers appear only for attributed sessions; until the owner's first real run confirms the session-id match (ADR-0011), token figures may stay empty — shown as "no usage reports yet", never as zero.

## Changes

- 2026-10-28 (S4a implementation): window is `(now − 24 h, now]` (events after the snapshot clock are excluded); DB `now()` truncated to ms; token-burn hour is `> now − 60 min`; project freshness can also be `ended` (all its threads ended); `attention` keeps the literal rule, while sorting and every attention count exclude ended threads (`needsAttention`); the route answers `503 not_configured` before looking up a session; absolute times are shown in UTC so server and browser render the same text.
- 2026-10-28 (S4a review, merged `1c099ce`): `ThreadState.needsAttention` (waiting and not ended) drives every attention count, sort and label; ages run on `generatedAt` + the time since the snapshot arrived in the browser, re-rendered every 5 s — a fresh thread turns stale client-side after 180 s, and while refreshes fail values show "Not current" / "Last confirmed HH:MM:SS UTC" with a neutral headline; requests time out after 8 s and polling always continues; the notice reads "showing data from HH:MM:SS UTC … while this tab is visible"; "Live activity" → "Recent activity"; token card "No usage reports in the last hour"; session-lookup failures answer `503 unavailable`.
