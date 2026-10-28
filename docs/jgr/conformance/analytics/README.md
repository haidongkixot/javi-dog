# JGR v0.1 usage analytics conformance vectors (ADR-0013 read model)

Black-box cases for the JD-M08 read model `createAnalyticsReader(db).usage(workspaceId, { days, projectId, now })`. Each case seeds stored events and checks the result: UTC day buckets, totals, breakdowns by model and by project, task outcomes and `lastReportAt`.

- **Oracle independence.** Every expectation comes only from contract text: [ADR-0013](../../../adr/0013-usage-analytics.md) "Decision outcome" (normative), [JGR spec v0.1](../../spec/v0.1.md) §3 (envelope), §4 (event types), §6 (usage deltas) and §10 (receipt time), and the review focus of [SPRINT-04b](../../../sprints/SPRINT-04b.md). The output shape and its doc comments come from the contract types in `packages/analytics/src/types.ts`. No implementation code or test of JD-M08 or JD-APP was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)).
- **Format.** One JSON file per case, `<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07).
- **Status.** Written 2026-10-28 for S4b task Q2. The runner belongs to the Developer lane and is planned. Where the contract can be read more than one way, the vector's `description` says `AMBIGUOUS` and the case is listed under [Ambiguities](#ambiguities).
- **Shared runner code.** Seeding follows the [state suite](../state/README.md#runner-rules): a fresh database per vector, rows written straight into `events` with an explicit `received_at`, offsets relative to a pinned `now`. The event fields are the same.
- **Sibling suites.** [`../state/`](../state/) (dashboard read model), [`../vectors/`](../vectors/) (single-event validation), [`../http/`](../http/) (ingest endpoint), [`../otlp/`](../otlp/) (local OTLP receiver).

## Vector file format

```json
{
  "$schema": "./schema.json",
  "description": "What the case proves",
  "contract": "ADR-0013 Decision outcome: Read model (per UTC day)",
  "now": "2026-10-28T12:00:00.000Z",
  "workspaces": {
    "A": { "name": "Workspace A", "projects": [{ "slug": "web", "name": "Web app" }] }
  },
  "events": [
    {
      "workspace": "A",
      "project": "web",
      "thread_ref": "cc_t01",
      "type": "usage.reported",
      "sequence": 1,
      "receivedOffsetMs": -43200001,
      "receivedAtUtc": "2026-10-27T23:59:59.999Z",
      "usage_delta": { "input_tokens": 100, "output_tokens": 10, "cost_usd": 0.01, "model": "claude-opus-5-5" }
    }
  ],
  "query": { "workspace": "A", "days": 14 },
  "expect": {
    "from": "2026-10-15",
    "to": "2026-10-28",
    "daysLength": 14,
    "days": [{ "date": "2026-10-27", "inputTokens": 100, "reports": 1 }],
    "otherDaysZero": true,
    "totals": { "inputTokens": 100, "estimatedCostUsd": 0.01, "reports": 1 },
    "byModelLength": 1,
    "byModel": [{ "model": "claude-opus-5-5", "inputTokens": 100 }],
    "lastReportOffsetMs": -43200001,
    "absentStrings": []
  }
}
```

JGR envelope fields keep their spec names (`thread_ref`, `agent_ref`, `usage_delta`, `attributes`). Fields used only by the runner are camelCase. Every offset is an integer number of milliseconds relative to `now`; a negative offset is before `now`.

### Top level

| Field | Meaning |
|---|---|
| `now` | The pinned instant passed as the `now` option. See [Pinned clock](#pinned-clock). |
| `workspaces` | Workspaces to create, keyed by a vector-local key (`A`, `B`). Each has a `name` and its `projects` (`slug`, `name`). A workspace may have no projects (vector 23). |
| `events` | Rows to store. Array order is **not** meaningful. |
| `query` | The call under test (below). |
| `expect` | Partial expectations (see [Comparison](#comparison)). `from`, `to`, `daysLength` and `absentStrings` are always present. |

### `events[]`

| Field | Store column (`events`) |
|---|---|
| `workspace`, `project` | `workspace_id`, `project_id` of the seeded project with that slug in that workspace. |
| `thread_ref`, `agent_ref` | Same name. Omitted `agent_ref` → `NULL`. A `thread_ref` never spans two projects in one vector. |
| `type`, `status` | Same name. Omitted `status` → `NULL`. |
| `sequence` | Same name. Strictly increasing per (`producer_id`, `thread_ref`) in received order (spec §3 JGR-R06). |
| `receivedOffsetMs` | `received_at = now + receivedOffsetMs`, always written explicitly (never the column default `now()`). Normative. |
| `receivedAtUtc` | Informative: the same instant written out for reviewers. The runner checks that it equals `now + receivedOffsetMs` and reports the vector BLOCKED (vector defect) when it does not. |
| `occurredOffsetMs` | `occurred_at = now + occurredOffsetMs`. When omitted, `occurred_at` equals `received_at`. When present, it is at most 5 minutes later than `received_at` (spec §10). |
| `usage_delta`, `attributes` | Same name, stored as JSON; omitted → `NULL`. Vector 11 puts `usage_delta` on event types other than `usage.reported` on purpose. |

### `query`

The runner calls `usage(<id of query.workspace>, options)` with:

| Field | Option |
|---|---|
| `days` | Passed as `days`. Omitted → the option is omitted (ADR default 14, vectors 04, 21, 23). Integers only, including out-of-range values (0, 45, −3) that test the clamp. |
| `project` | Slug of a project of the queried workspace; its id is passed as `projectId`. |
| `foreignProject` | `{ workspace, slug }` of a project in **another** workspace; its id is passed as `projectId` (vector 19). Never combined with `project`. |
| — | `now` is always passed (the vector's `now`). |

### `expect`

| Field | Check |
|---|---|
| `from`, `to` | Exact strings (`YYYY-MM-DD`). |
| `daysLength` | Exact length of `result.days`. |
| `days[]` | Each entry matches **exactly one** element of `result.days` by `date`; every other listed field is compared. |
| `otherDaysZero` | When `true`, every element of `result.days` whose date is not listed in `days[]` has all eight numeric fields equal to 0 (zero fill). |
| `totals` | Listed fields of `result.totals`. |
| `byModelLength`, `byProjectLength` | Exact lengths of `result.byModel`, `result.byProject`. |
| `byModelOrder` | `result.byModel` mapped to `model` equals this list exactly, in order (`null` included). |
| `byModel[]` | Each entry matches exactly one element of `result.byModel` by `model` (`null` matches `null`); listed fields compared. |
| `byProjectOrder` | `result.byProject` mapped to `slug` equals this list exactly, in order. |
| `byProject[]` | Each entry matches exactly one element of `result.byProject` by `slug`; listed fields compared. `projectId` is a `$PROJECT_ID` placeholder. |
| `lastReportOffsetMs` | `null` → `lastReportAt` is `null`; a number → `lastReportAt` denotes `now + offset`. |
| `absentStrings` | None of these substrings occurs in `JSON.stringify(result)`. `$PROJECT_ID:<key>:<slug>` is replaced by the id the runner assigned to that project. |

## Runner rules

### Isolation

Run each vector against a **fresh database** (PGlite with the JD-M06 migrations applied is enough), as in the state suite. Vectors reuse slugs (`web`, `api`), and workspace isolation is itself under test.

### Seeding

Seed directly into the store, not through the ingest endpoint. The read model is what is under test, and ingest would stamp `received_at` with the real clock. ADR-0013 reads from `events` only, so no other table needs usage data.

1. For each workspace key, insert a `workspaces` row (unique `slug` of the runner's choice, `name` from the vector).
2. For each project, insert a `projects` row with `slug`, `name`, `platforms = {claude-code}`, `privacy_class = 'L0'` and `last_signal_at` = the newest `received_at` among this project's seeded events, or `NULL` when it has none. The analytics contract does not read this column; it is set the way ingest would leave it.
3. For each event, insert an `events` row as in the [table above](#events), with `producer_id = 'prod_analytics_qa'`, a unique runner-generated canonical ULID `event_id`, `privacy_class = 'L0'` and `encrypted = NULL`.

### Pinned clock

ADR-0013 lists `now?` as an option; the range ends on the UTC date of `now` (see A1). The runner passes `now` as the instant the reader's option type expects (`Date` or ISO string). Every expectation is either an offset or a UTC date derived from `now`. A runner may therefore **not** rebase a vector onto another instant unless it keeps the same time of day, because the day-boundary cases (01–06) depend on it. If the reader offers no way to pin `now`, report vectors 01–06 BLOCKED and the rest NOT RUN. Do not loosen them.

### Comparison

- **Dates** (`from`, `to`, `days[].date`) compare as exact strings.
- **Times** compare as instants: `Date.parse(actual) === Date.parse(now) + offset`. The format (`Z` vs `+00:00`, number of fraction digits) is not checked.
- **Token counts, `reports`, `tasksCompleted`, `tasksFailed`** compare exactly as integers. ADR-0013: "tokens are exact".
- **`estimatedCostUsd`** compares with an absolute tolerance: `|actual − expected| ≤ 1e-9` (floating-point sums such as 0.1 + 0.2). It must be a number; `null` or a string fails.
- **`null`** is not `0`, `""` or absent.
- **Not checked unless listed:** any field the vector omits, including `generatedAt` (see I1), `name` and `projectId`.

### Invariants checked in every vector

| ID | Check |
|---|---|
| I1 | `generatedAt` parses as an instant. Equality with `now` is not asserted (A1). |
| I2 | `days.length` = `days` option clamped to 1–30 (14 when omitted); `days[0].date === from`; the last element's date `=== to`; `to` is the UTC date of `now`; dates ascend one day apart with no gaps (zero-filled, oldest first). |
| I3 | For each of the eight numeric fields, `totals.<field>` equals the sum over `days` (cost within the tolerance). |
| I4 | For each of the six usage fields, the sum over `byModel` and the sum over `byProject` each equal `totals.<field>`. |
| I5 | `byModel` and `byProject` are non-increasing by `inputTokens + outputTokens`. |
| I6 | Every `byProject[].projectId` is the id of a project seeded in the queried workspace, and its `slug` and `name` are that project's. |
| I7 | `lastReportAt` is `null` exactly when `totals.reports` is 0. |
| I8 | Every count is a non-negative integer. |
| I9 | `absentStrings` (above). |

### Results

Report PASS, FAIL, BLOCKED, NOT RUN or SKIPPED for each vector, following the Orcasus contract. A seeding error or a `receivedAtUtc` mismatch is BLOCKED (setup failed), never FAIL and never PASS.

## Derived rules under test

The rules are quoted from ADR-0013 "Decision outcome: Read model" unless a row says otherwise.

| Rule | Text | Vectors |
|---|---|---|
| UTC days | "per **UTC day**" | 01–06, 10 |
| Zero fill, order | "(zero-filled, oldest first)"; types.ts "Inclusive UTC date range, oldest first" | 04, 06, 08, 21–23 (I2) |
| Default and clamp | "`days = 14`"; "`days` is clamped to 1–30 (retention)" | 04, 05, 06 (1, 14, 30); 07, 08, 09 (0 → 1, 45 → 30, −3 → 1) |
| Counters | "input / output / cache-read / cache-write tokens, `cost_usd` and report count from `usage.reported`" | 11, 12, 13, 14 |
| Cost | "Cost is always labelled 'estimated' … tokens are exact counts"; types.ts "Sum of producer-reported `cost_usd`" | 13, 16 |
| Tasks | "`task.completed` / `task.failed` counts per day" | 01, 04, 15, 18 |
| By model | "totals by model"; types.ts "Sorted by input + output tokens, descending; `model` is null when reports carried none" | 16, 18 |
| By project | "totals … by project"; types.ts "Every workspace project with usage in the range (or the one requested), same sort" | 14, 17, 18, 20 |
| Project filter | "`projectId` narrows to one project **inside** the workspace (a project of another workspace yields nothing)" | 18, 19 |
| Isolation | `usage(workspaceId, …)`; SPRINT-04b "Workspace isolation" | 19, 20, 23 |
| Last report | "`lastReportAt`"; types.ts "Newest `usage.reported` received in the range, or null" | 10, 11, 18, 22 |
| Empty | "Empty states. No usage reports …" (the read model must make "no usage" detectable: `reports` 0, `lastReportAt` null) | 15, 21, 22, 23 |

## Vectors

23 vectors. Unless a row says otherwise, `now` is `2026-10-28T12:00:00.000Z`.

| # | Vector | Case | Key expectation |
|---|---|---|---|
| 01 | [`01-utc-day-boundary.json`](01-utc-day-boundary.json) | Reports and tasks at 23:59:59.999 and 00:00:00.000 | Two different days; 100 / 200 input |
| 02 | [`02-now-at-midnight-days-1.json`](02-now-at-midnight-days-1.json) | `now` 00:00:00.000, `days` 1 | Only the report at `now`; 1 ms earlier excluded |
| 03 | [`03-now-at-last-ms-of-day.json`](03-now-at-last-ms-of-day.json) | `now` 23:59:59.999, `days` 1 | Same day 24 input; previous day excluded |
| 04 | [`04-range-start-default-14-days.json`](04-range-start-default-14-days.json) | `days` omitted; reports around the range start (A3) | 14 days from 2026-10-15; only 00:00:00.000 of the first day counts |
| 05 | [`05-days-1-today-only.json`](05-days-1-today-only.json) | `days` 1 vs the last 24 h | Yesterday 12:00 and 18:00 excluded |
| 06 | [`06-days-30-month-crossing.json`](06-days-30-month-crossing.json) | `days` 30 across September / October | 30 days from 2026-09-29; midnight split |
| 07 | [`07-clamp-zero-to-one.json`](07-clamp-zero-to-one.json) | `days` 0 | Clamped to 1 day |
| 08 | [`08-clamp-45-to-30.json`](08-clamp-45-to-30.json) | `days` 45; reports 1 ms before the range, 35 and 44.5 days old | Clamped to 30; older reports excluded |
| 09 | [`09-clamp-negative-to-one.json`](09-clamp-negative-to-one.json) | `days` −3 | Clamped to 1 day |
| 10 | [`10-received-time-not-occurred-time.json`](10-received-time-not-occurred-time.json) | Spooled and clock-ahead reports (A2) | Day and `lastReportAt` from `received_at` |
| 11 | [`11-only-usage-reported-counts.json`](11-only-usage-reported-counts.json) | `usage_delta` on six other types | Only the `usage.reported` counts; task still counted |
| 12 | [`12-missing-counters-are-zero.json`](12-missing-counters-are-zero.json) | One counter per report (A8) | 101 / 22 / 3003 / 404, cost 0.26, 7 reports |
| 13 | [`13-cost-sum-with-tolerance.json`](13-cost-sum-with-tolerance.json) | 0.1 + 0.2; micro and large costs (A5, A9) | 0.3 and 1235.167801 within 1e-9 |
| 14 | [`14-reports-across-threads-and-projects.json`](14-reports-across-threads-and-projects.json) | Four threads, two projects | 4 / 1 / 1 reports per day; `api` before `web` |
| 15 | [`15-tasks-per-day.json`](15-tasks-per-day.json) | Completed, failed, started, error, failed status | 2 / 1, 0 / 1, 2 / 0; usage zero |
| 16 | [`16-by-model-null-model-and-sort.json`](16-by-model-null-model-and-sort.json) | Four models incl. none | Order opus, gemini, `null`, codex |
| 17 | [`17-by-project-membership-and-sort.json`](17-by-project-membership-and-sort.json) | Old-only and silent projects | `api`, `web` only; ids and names |
| 18 | [`18-project-filter.json`](18-project-filter.json) | `projectId` of `web` | Only `web` usage, tasks, models, `lastReportAt` |
| 19 | [`19-foreign-project-id-yields-nothing.json`](19-foreign-project-id-yields-nothing.json) | `projectId` from workspace B, same slug (A10) | All zeros, empty breakdowns, `null` |
| 20 | [`20-workspace-isolation-same-slug.json`](20-workspace-isolation-same-slug.json) | B has `web`, same model, more usage | A's numbers only; B markers absent |
| 21 | [`21-no-usage-at-all.json`](21-no-usage-at-all.json) | Activity without reports or outcomes | Zero totals, `reports` 0, `null` |
| 22 | [`22-usage-only-before-range.json`](22-usage-only-before-range.json) | Reports 1 ms before the range and older | Zero totals, `lastReportAt` `null` |
| 23 | [`23-empty-workspace-other-busy.json`](23-empty-workspace-other-busy.json) | No projects; B busy | 14 zero days; B absent |

## Ambiguities

Line numbers refer to `docs/adr/0013-usage-analytics.md` (ADR), `packages/analytics/src/types.ts` (types) and `docs/jgr/spec/v0.1.md` (spec) at commit `0a02c57`.

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| A1 | ADR L14 "`generatedAt` from the database clock"; option `now?` | Does `now` also set `generatedAt`, or only the range? | `now` sets the range (`to` is the UTC date of `now`). `generatedAt` is only checked to be an instant (I1). |
| A2 | ADR L14 "per **UTC day**" (no column named); types L31 "`usage.reported` received in the range"; spec L118 "record receipt time separately for ordering" | Bucket by `received_at` or `occurred_at`? | `received_at` for days, range and `lastReportAt` (10). Other vectors set `occurred_at = received_at`, so they pass under either reading. |
| A3 | ADR L14 "per UTC day (zero-filled, oldest first)"; types L22 "Inclusive UTC date range" | Whole UTC days, or a rolling `now − days × 24 h` window cut into days? | Whole days: `from` 00:00:00.000 through the end of `to` (04, 05, 06). Under the rolling reading, 04 and 05 fail on totals. |
| A4 | ADR L14 "`days` is clamped to 1–30" | Fractional `days` (7.6 → 7 or 8?), `NaN`, strings? | Untested. The ADR states no rounding, so the schema allows integers only. 0, 45 and −3 test the clamp (07–09). |
| A5 | types L8 "Sum of producer-reported `cost_usd`"; ADR L15 "estimated" | Is cost rounded (cents)? Is it 0 or `null` when no report carries cost? | Unrounded sum within 1e-9 (13). 0 when there are no costs (the type is `number`). |
| A6 | types L28 "Every workspace project with usage in the range (or the one requested)" | With `projectId`, is that project listed when it has no usage in the range? Is a project with only task events "with usage"? | "Usage" = at least one `usage.reported` in the range (17, 22). Both questions are untested: 15 does not assert `byProject`, and 18 filters on a project that has usage. |
| A7 | types L26 "Sorted by input + output tokens, descending" | Order of ties? | Untested; no vector has equal input + output between two models or two projects. |
| A8 | spec L86 lists `reasoning_tokens`; `UsageTotals` has no reasoning field | Does a report that carries only `reasoning_tokens` count in `reports`? | Yes, it is a `usage.reported` event; its tokens appear in no exposed counter (12). |
| A9 | ADR L15 "tokens are exact counts"; spec L86 "`estimated: true`" | Are reports with `estimated: true` summed with exact ones, excluded, or flagged? | Summed (13, 16). No field exposes the flag. |
| A10 | ADR L14 "a project of another workspace yields nothing" | Empty `days` array, zero-filled days, or an error? | Zero-filled `days` of the requested length, zero totals and tasks, empty breakdowns, `lastReportAt` `null`, no throw (19). An id that matches no project at all is untested. |
| A11 | ADR L14 "`days` … (retention)"; ADR-0008 30-day retention | Events older than 30 days that the retention job has not yet removed? | Excluded by the range itself (08 seeds reports 35 and 44.5 days old). |
| A12 | ADR L14 range ends on the day of `now` | Events received after `now` but on the same UTC day (possible only with a pinned `now`)? | Untested; every `receivedOffsetMs` is ≤ 0. |
