# JGR v0.1 dashboard state conformance vectors (ADR-0012 read model)

Black-box cases for the JD-M07 read model `createDashboardReader(db).snapshot(workspaceId, { now })`: stored events in, thread state, overview counters, activity feed and project health out.

- **Oracle independence.** Every expectation is derived only from contract text: [ADR-0012](../../../adr/0012-dashboard-read-model-and-polling.md) "Decision outcome" (normative), [JGR spec v0.1](../../spec/v0.1.md) §3 (envelope), §4 (event types), §5 (status and freshness), §6 (usage deltas) and §10 (receipt time), and the review focus of [SPRINT-04a](../../../sprints/SPRINT-04a.md). The output shape comes from the contract types in `packages/realtime/src/types.ts`; the store columns from the JD-M06 migrations. No implementation code or test of JD-M07 or JD-APP was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)).
- **Format.** One JSON file per case, `<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07).
- **Status.** Written 2026-10-28 for S4a task Q1. The runner belongs to the Developer lane (R1) and is planned. Cases where the contract can be read more than one way say `AMBIGUOUS` in their `description` and are listed under [Ambiguities](#ambiguities).
- **Sibling suites.** [`../vectors/`](../vectors/) (single-event validation), [`../http/`](../http/) (ingest endpoint), [`../otlp/`](../otlp/) (local OTLP receiver).

## Vector file format

```json
{
  "$schema": "./schema.json",
  "description": "What the case proves",
  "contract": "ADR-0012 Decision outcome: Thread state; spec §5",
  "now": "2026-10-28T12:00:00.000Z",
  "workspaces": {
    "A": { "name": "Workspace A", "projects": [{ "slug": "web", "name": "Web app" }] },
    "B": { "name": "Workspace B", "projects": [{ "slug": "api", "name": "API", "lastSignalOffsetMs": -3600000 }] }
  },
  "events": [
    {
      "workspace": "A",
      "project": "web",
      "thread_ref": "cc_t01",
      "agent_ref": "ag_a1",
      "type": "heartbeat",
      "status": "working",
      "sequence": 1,
      "receivedOffsetMs": -180000,
      "occurredOffsetMs": -180000,
      "usage_delta": { "input_tokens": 10, "output_tokens": 2 },
      "attributes": { "tool_name": "Edit" }
    }
  ],
  "snapshotOf": "A",
  "expect": {
    "overview": { "activeProjects": { "value": 1, "lastSignalOffsetMs": -180000 } },
    "threadCount": 1,
    "threads": [{ "projectSlug": "web", "threadRef": "cc_t01", "freshness": "fresh" }],
    "threadOrder": [{ "projectSlug": "web", "threadRef": "cc_t01" }],
    "activity": { "length": 1, "items": [{ "index": 0, "toolName": "Edit" }] },
    "projectCount": 1,
    "projects": [{ "slug": "web", "freshness": "fresh", "freshThreads": 1 }],
    "absentStrings": []
  }
}
```

JGR envelope fields keep their spec names (`thread_ref`, `agent_ref`, `usage_delta`, `attributes`); runner-only fields are camelCase. Every offset is an integer number of milliseconds relative to `now`; negative means before `now`.

### Top level

| Field | Meaning |
|---|---|
| `now` | The pinned instant passed to `snapshot(workspaceId, { now })`. See [Pinned clock](#pinned-clock). |
| `workspaces` | Workspaces to create, keyed by a vector-local key (`A`, `B`). Each has a `name` and its `projects` (`slug`, `name`, optional `lastSignalOffsetMs`). |
| `events` | Rows to store. Array order is **not** meaningful: vectors 07 and 22 list events out of received order on purpose. |
| `snapshotOf` | Key of the workspace whose snapshot is taken. Every other workspace exists only to prove isolation. |
| `expect` | Partial expectations (see [Comparison](#comparison)). `absentStrings` is always present, possibly empty. |

### `events[]`

| Field | Store column (`events`) |
|---|---|
| `workspace`, `project` | `workspace_id`, `project_id` of the seeded project with that slug in that workspace. |
| `thread_ref`, `agent_ref` | Same name. Omitted `agent_ref` → `NULL`. |
| `type`, `status` | Same name. Omitted `status` → `NULL`. |
| `sequence` | Same name. Strictly increasing per (`producer_id`, `thread_ref`) in received order (spec §3 JGR-R06). |
| `receivedOffsetMs` | `received_at = now + receivedOffsetMs`, always written explicitly (never the column default `now()`). |
| `occurredOffsetMs` | `occurred_at = now + occurredOffsetMs`; omitted → equal to `received_at`. Vector 26 uses a positive value (producer clock 4 min ahead, inside the 5-minute limit of spec §10). |
| `usage_delta`, `attributes` | Same name, stored as JSON; omitted → `NULL`. |

### `expect`

| Field | Check |
|---|---|
| `overview.<counter>` | `value` exact; `lastSignalOffsetMs` when present: `null` means `lastSignalAt` is `null`, a number means it denotes `now + offset`. `tokensLastHour.reports` exact when present. |
| `threadCount` | Exact length of `snapshot.threads`. |
| `threads[]` | Each entry matches **exactly one** element of `snapshot.threads` by (`projectSlug`, `threadRef`); every other listed field is compared. `firstSignalOffsetMs` / `lastSignalOffsetMs` compare with `firstSignalAt` / `lastSignalAt`. Position is not checked here. |
| `threadOrder` | `snapshot.threads` mapped to (`projectSlug`, `threadRef`) equals this list exactly, in order. |
| `activity.length` | Exact length of `snapshot.activity`. |
| `activity.items[]` | Fields of `snapshot.activity[index]`; `atOffsetMs` compares with `at`. |
| `projectCount` | Exact length of `snapshot.projects`. |
| `projects[]` | Each entry matches exactly one element of `snapshot.projects` by `slug`; listed fields compared (`lastSignalOffsetMs` as for counters). Order is not checked. |
| `absentStrings` | None of these substrings occurs in `JSON.stringify(snapshot)`. `$PROJECT_ID:<key>:<slug>` is replaced by the id the runner assigned to that project. |

## Runner rules

### Isolation

Run each vector against a **fresh database** (PGlite with the JD-M06 migrations applied is enough). Vectors reuse slugs (`web`, `api`) and workspace isolation is itself under test, so a shared database would make a leak from another vector look like a failure of this one. A runner that must share a database creates unique workspace slugs per vector and still reports a cross-vector leak as FAIL.

### Seeding

Seed directly into the store, not through the ingest endpoint: the read model is under test, not JD-M05, and the ingest path would stamp `received_at` with the real clock.

1. Per workspace key: insert a `workspaces` row (unique `slug` of the runner's choice, `name` from the vector).
2. Per project: insert a `projects` row with `slug`, `name`, `platforms = {claude-code}`, `privacy_class = 'L0'` and `last_signal_at`:
   - `lastSignalOffsetMs` present → `now + offset` (`null` → `NULL`);
   - omitted → the newest `received_at` among this project's seeded events (the value ingest would have left, ADR-0008), or `NULL` when it has none.
3. Per event: insert an `events` row as in the [table above](#events), with `producer_id = 'prod_state_qa'`, a unique runner-generated canonical ULID `event_id`, `privacy_class = 'L0'` and `encrypted = NULL`.

Some `attributes` carry keys outside the L0 allowlist (`prompt`, `file_path`, `command`, vector 19). Ingest would reject them; they are seeded on purpose as defence in depth for ADR-0012 *Privacy* ("no attribute other than `tool_name` is read").

### Pinned clock

ADR-0012 takes every time from the database clock; the reader's `now` option replaces it for the call (see A1). The runner passes `now` as the instant the reader's option type expects (`Date` or ISO string). Because every expectation is an offset, a runner MAY rebase a vector onto another instant (for example the database clock at seeding time) as long as it seeds and snapshots with that same instant. If the reader offers no way to pin `now`, report vectors 01 and 02 BLOCKED (a 1 ms boundary cannot survive a real clock) and the rest NOT RUN rather than loosening them.

### Comparison

- **Times** compare as instants: `Date.parse(actual) === Date.parse(now) + offset`. Format (`Z` vs `+00:00`, fraction digits) is not checked.
- **Listed fields** compare exactly: integers, booleans, strings and `null` (`null` is not `0`, `""` or absent).
- **Not checked unless listed:** any field the vector omits, including `projectId` / `id`, `projectName` / `name` and `firstSignalAt`. Order of `snapshot.projects` is never checked; order of `snapshot.threads` only through `threadOrder`.

### Invariants checked in every vector

| ID | Check |
|---|---|
| I1 | `generatedAt` denotes `now`; `freshnessWindowMs` is `180000`; `windowHours` is `24`. |
| I2 | Every `projects[].id` and every `threads[].projectId` is the id of a project seeded in `snapshotOf`; every `projectSlug` / `slug` belongs to that workspace. |
| I3 | `activity` is sorted by `at`, newest first, and has at most 25 items. |
| I4 | Every `threads[].freshness` is `fresh`, `stale` or `ended`; every `status` is a spec §5 value or `null` (never `stale`). |
| I5 | `absentStrings` (above). |

### Results

Report one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED per vector, following the Orcasus contract. A seeding error is BLOCKED (setup failed), never FAIL and never PASS.

## Derived rules under test

Quoted from ADR-0012 "Decision outcome" unless noted.

| Rule | Text | Vectors |
|---|---|---|
| Window | "events received in the last 24 h" | 14, 15 |
| Freshness | "`ended` when the last event is `session.ended`; else `fresh` when `generatedAt − lastSignalAt ≤ 180 s`; else `stale`" | 01–05, 22, 26 |
| Status | "last non-null `status`" | 04, 08, 09, 14 |
| Attention | "the latest status-bearing event has status `waiting`"; "a waiting thread that went stale still shows waiting" | 06–08, 22, 25, 27 |
| Agents | "distinct `agent_ref` count" | 10, 14, 23 |
| Tokens | thread "input/output tokens"; token burn "input + output tokens reported in the last 60 min (from `usage.reported`)" | 12, 13, 14 |
| Tasks | "completed tasks"; "`task.completed` events in 24 h" | 09, 11, 14, 18 |
| Active projects | "projects with ≥ 1 fresh thread" | 01–03, 06, 24, 27 |
| Agents working | "fresh threads whose status is `working`" | 01–03, 05–08, 23, 26 |
| Activity | "the 25 most recent events in the window: time, project, opaque thread ref, type, status, `tool_name`" | 14, 18, 19, 26 |
| Projects | "every workspace project with `last_signal_at`, fresh/stale/never, fresh threads and threads needing attention" | 06, 15, 16, 24, 25, 27 |
| Isolation | "workspace-scoped SQL"; review focus "Another workspace's project id or events never appear" | 17, 20, 21 |

## Vectors

27 vectors.

| # | Vector | Case | Key expectation |
|---|---|---|---|
| 01 | [`01-fresh-at-exact-window.json`](01-fresh-at-exact-window.json) | Last signal exactly 180 000 ms old | `fresh`; active 1; working 1 |
| 02 | [`02-stale-one-ms-past-window.json`](02-stale-one-ms-past-window.json) | Last signal 180 001 ms old | `stale`, status still `working`; active 0 |
| 03 | [`03-ended-recent-session.json`](03-ended-recent-session.json) | `session.ended` 10 s ago | `ended`, not fresh; not active, not working |
| 04 | [`04-ended-an-hour-ago.json`](04-ended-an-hour-ago.json) | Ended 60 min ago | `ended`, not `stale`; status `idle` |
| 05 | [`05-ended-then-later-event.json`](05-ended-then-later-event.json) | Event after `session.ended` (A6) | `fresh`, `lastType` `heartbeat` |
| 06 | [`06-waiting-silent-five-minutes.json`](06-waiting-silent-five-minutes.json) | `waiting`, then 5 min silence | `waiting` + `stale` + attention; project `attentionThreads` 1 |
| 07 | [`07-waiting-then-resolved.json`](07-waiting-then-resolved.json) | `waiting` then `working` / `idle`, listed out of order | No attention |
| 08 | [`08-status-null-does-not-override.json`](08-status-null-does-not-override.json) | Status-less `task.*` after `waiting` / `idle` | Status and attention unchanged; `lastType` follows |
| 09 | [`09-no-status-ever.json`](09-no-status-ever.json) | Only status-less events | `status` `null`; active but not working |
| 10 | [`10-distinct-agents.json`](10-distinct-agents.json) | `ag_a1`, `ag_a2`, repeats, `NULL` (A8) | `agents` 2 and 0 |
| 11 | [`11-tasks-completed.json`](11-tasks-completed.json) | `task.started` / `completed` / `failed` | Per thread 2 and 1; overview 3 |
| 12 | [`12-usage-sums-and-token-burn.json`](12-usage-sums-and-token-burn.json) | Reports at 10, 30, 59, 61, 120 min (A9) | Thread 1507 / 263; burn 1335 from 3 reports |
| 13 | [`13-usage-only-from-usage-reported.json`](13-usage-only-from-usage-reported.json) | `usage_delta` on `heartbeat` / `task.completed` (A10) | Tokens 0; burn 0, `lastSignalAt` `null` |
| 14 | [`14-window-24h-exclusion.json`](14-window-24h-exclusion.json) | Events 24 h 1 min to 30 h old | Excluded from state, agents, tokens, tasks, activity |
| 15 | [`15-project-signal-outside-window.json`](15-project-signal-outside-window.json) | `last_signal_at` 26 h / 30 h ago | Project `stale`, no threads, counters 0 |
| 16 | [`16-project-never.json`](16-project-never.json) | Project with no signal | `never`, `lastSignalAt` `null` |
| 17 | [`17-empty-workspace.json`](17-empty-workspace.json) | No projects; B busy | All counters 0 / `null`; empty lists; B absent |
| 18 | [`18-activity-limit-25-newest-first.json`](18-activity-limit-25-newest-first.json) | 30 events | 25 items newest first; 5 oldest absent |
| 19 | [`19-activity-fields-tool-name-only.json`](19-activity-fields-tool-name-only.json) | Allowlisted and forbidden attributes | Only `toolName` shown; markers absent |
| 20 | [`20-workspace-isolation-counters.json`](20-workspace-isolation-counters.json) | B active, A quiet | A all zero; B slug, refs, tool, project id absent |
| 21 | [`21-workspace-isolation-same-slug.json`](21-workspace-isolation-same-slug.json) | Slug `web` in A and B | A's `web` `never`; B data absent |
| 22 | [`22-thread-ordering.json`](22-thread-ordering.json) | Attention, fresh, stale, ended (A12) | Order attention → fresh → stale → ended |
| 23 | [`23-agents-working-counts-fresh-working-threads.json`](23-agents-working-counts-fresh-working-threads.json) | Seven threads, mixed states (A11) | Working 2 |
| 24 | [`24-active-projects.json`](24-active-projects.json) | Fresh, stale, ended-only, mixed projects | Active 2 |
| 25 | [`25-same-thread-ref-two-projects.json`](25-same-thread-ref-two-projects.json) | One ref in two projects | Two independent threads |
| 26 | [`26-received-time-not-occurred-time.json`](26-received-time-not-occurred-time.json) | Spooled and clock-ahead events (A5) | Freshness and `at` from `received_at` |
| 27 | [`27-project-attention-and-fresh-counts.json`](27-project-attention-and-fresh-counts.json) | Fresh and stale waiting threads | `freshThreads` 2, `attentionThreads` 2 |

## Ambiguities

Line numbers refer to `docs/adr/0012-dashboard-read-model-and-polling.md` (ADR) and `docs/jgr/spec/v0.1.md` (spec) at commit `0e13e34`.

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| A1 | ADR L27 "All times come from the database clock (`now()`), returned as `generatedAt`"; R1 export `snapshot(workspaceId, { now? })` | Does `now` replace the database clock for every derivation (window, freshness, 60 min)? | Yes; `generatedAt` must denote `now` (I1). Without the option, see [Pinned clock](#pinned-clock). |
| A2 | ADR L31 "with `last_signal_at`, fresh/stale/never"; `ProjectFreshness` also allows `ended` | Is project freshness the 180 s rule on `projects.last_signal_at`, or derived from its threads? When is a project `ended`? | Column + 180 s rule, `never` when `NULL` (15 needs the column: no events in window yet `stale`). Seeding keeps the column equal to the newest event, so both readings agree elsewhere. Project freshness is not asserted when its newest event is `session.ended` (03, 04, 24 `p-ended`). |
| A3 | `Counter.lastSignalAt` "Newest signal that contributed, or null when nothing did" | Which signal contributes to each counter? | Active projects and agents working: newest `lastSignalAt` among the counted threads; token burn: newest counted `usage.reported`; tasks: newest counted `task.completed`. Asserted only where readings agree; `null` whenever the value is 0. |
| A4 | ADR L27, L29 "24 h", "last 60 min"; `tokensLastHour.reports` not in the ADR | Inclusive boundaries? What is `reports`? | Boundaries untested (23 h 59 min vs 24 h 1 min; 59 vs 61 min). `reports` = number of `usage.reported` events counted in the 60 min. |
| A5 | ADR L28 "last received time"; spec L118 "record receipt time separately for ordering" | Do "latest", activity "most recent" and activity "time" use `received_at` or `occurred_at`? | `received_at` everywhere (26). Other vectors set `occurred_at = received_at`, so they hold under either reading. |
| A6 | ADR L28 "`ended` when the last event is `session.ended`" | An event received after `session.ended` (resumed or late)? | Literal: no longer `ended`; the 180 s rule applies (05). |
| A7 | ADR L28 "Attention = the latest status-bearing event has status `waiting`" | `waiting` then `session.ended` (no status): is an ended thread still "needing attention"? `attention.requested` without `status`? Do ended threads count in `attentionThreads`? | Untested; every `attention.requested` in the vectors carries `waiting` (spec §12 hook mapping). |
| A8 | ADR L28 "distinct `agent_ref` count" | Does a thread whose main agent sends no `agent_ref` count as 1 agent? | No: `NULL` is not counted (`agents` 0, vector 10). |
| A9 | ADR L28-29 "input/output tokens", "input + output tokens"; spec L86 lists cache and reasoning counters | Are cache or reasoning tokens part of input/output? | No: only `input_tokens` and `output_tokens` (12). `estimated: true` reports still count. |
| A10 | ADR L29 "(from `usage.reported`)" names the token burn only; spec L59 does not forbid `usage_delta` elsewhere | Do thread tokens also ignore `usage_delta` on other event types? | Yes, both ignore it (13). |
| A11 | ADR L29 "agents working = fresh threads whose status is `working`" | Threads or distinct agents? | Threads: a thread with two agent refs counts once (23). |
| A12 | ADR-0012 states no thread order; QA brief and product rule 1 (*Signal before spectacle*) | Order of `snapshot.threads`? | Attention first (even when stale), then fresh, stale, ended (22). Order within a group and project order are untested. |
| A13 | ADR L28 "last non-null `status`" in the window | A thread whose only status was sent before the window? Equal `received_at` tie-breaks? | Untested; no vector has equal `received_at` within a thread or among activity items. |
| A14 | ADR L30, L33 "the only attribute shown", "no attribute other than `tool_name` is read" | Must allowlisted L0 attributes (`platform`, `model`, `error_code`) also stay out? | Yes: their values are in `absentStrings` (19), next to non-allowlisted keys seeded directly. |
