# JGR v0.1 budget conformance vectors (ADR-0014 budgets, forecast and alerts)

Black-box cases for the JD-M12 budget repository (`createBudgetRepository(db)` from `@javis-dog/resilience`). Each case seeds users, workspaces with members and roles, projects with optional budgets, stored events and optional `budget_alerts` rows. It then runs a list of steps: read the budget status, claim an alert (also concurrently), mark a claimed alert sent or failed, set or clear a budget, add events, inspect `budget_alerts`.

- **Oracle independence.** Every expectation comes only from contract text: [ADR-0014](../../../adr/0014-budgets-forecast-and-alerts.md) "Decision outcome" (normative), [JGR spec v0.1](../../spec/v0.1.md) §6 (usage deltas) and §10 (receipt time), the backlog and review focus of [SPRINT-04c](../../../sprints/SPRINT-04c.md), and [TEST_PLAN](../../../agent-ops/TEST_PLAN.md) §S4c. Output shapes and their doc comments come from the contract files `packages/resilience/src/{types,tables,index}.ts`. No implementation code or test of JD-M12, JD-M06 budgets or JD-APP budget code was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)).
- **Format.** One JSON file per case, `<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07).
- **Status.** Written 2026-10-28 for S4c task Q3. The runner belongs to the Developer lane and is planned. Where the contract can be read more than one way, the vector's `description` says `AMBIGUOUS` and the case is listed under [Ambiguities](#ambiguities).
- **Shared runner code.** Event seeding follows the [analytics suite](../analytics/README.md#runner-rules): a fresh database per vector, rows written straight into `events` with an explicit `received_at`, offsets relative to a pinned `now`.
- **Sibling suites.** [`../analytics/`](../analytics/) (usage read model), [`../state/`](../state/) (dashboard read model), [`../vectors/`](../vectors/) (single-event validation), [`../http/`](../http/) (ingest endpoint), [`../otlp/`](../otlp/) (local OTLP receiver).

## Vector file format

```json
{
  "$schema": "./schema.json",
  "description": "What the case proves",
  "contract": "ADR-0014 Decision outcome: Thresholds",
  "now": "2026-10-28T12:00:00.000Z",
  "users": { "o1": { "email": "owner1.q3@example.com", "emailVerified": true } },
  "workspaces": {
    "A": {
      "name": "Workspace A",
      "members": [{ "user": "o1", "role": "owner" }],
      "projects": [{ "slug": "web", "name": "Web app", "budget": { "limitUsd": 100 } }]
    }
  },
  "events": [
    {
      "workspace": "A",
      "project": "web",
      "thread_ref": "cc_q10",
      "type": "usage.reported",
      "sequence": 1,
      "receivedOffsetMs": -698400000,
      "receivedAtUtc": "2026-10-20T10:00:00.000Z",
      "usage_delta": { "input_tokens": 100, "cost_usd": 80 }
    }
  ],
  "alerts": [],
  "steps": [
    { "op": "claimAlert", "workspace": "A", "project": "web", "label": "j1",
      "expect": { "threshold": 80, "recipients": ["owner1.q3@example.com"] } },
    { "op": "markAlert", "job": "j1", "outcome": "sent", "expect": { "ok": true } },
    { "op": "status", "workspace": "A", "project": "web", "expect": { "alerted": [80] } }
  ]
}
```

JGR envelope fields keep their spec names (`thread_ref`, `usage_delta`). Fields used only by the runner are camelCase. Every offset is an integer number of milliseconds relative to `now`; a negative offset is before `now`.

### Top level

| Field | Meaning |
|---|---|
| `now` | The pinned instant. A step runs at `now + atOffsetMs` (default `now`). See [Pinned clock](#pinned-clock). |
| `users` | Users to create, keyed by a vector-local key (`o1`, `ad`). Each has an `email` and `emailVerified`. |
| `workspaces` | Workspaces keyed by `A`, `B`, … with `name`, `members` (`user` key, `role` `owner` / `admin` / `member`) and `projects` (`slug`, `name`, optional `budget.limitUsd`). |
| `events` | Event rows stored before the first step. Array order is **not** meaningful. |
| `alerts` | Optional `budget_alerts` rows stored before the first step. |
| `steps` | Operations run strictly in order, each after the previous one settled. |

### `events[]`

Same fields and rules as the [analytics suite](../analytics/README.md#events): `workspace` + `project` (slug) select the project; `receivedOffsetMs` is normative; `receivedAtUtc` is the same instant written out and a mismatch is a vector defect (BLOCKED); `occurredOffsetMs` omitted means `occurred_at = received_at`, and it is at most 5 minutes later than `received_at` (spec §10). `sequence` increases strictly per `thread_ref` in received order. `attributes` is not used. Vector 03 puts `usage_delta` with `cost_usd` on non-usage types on purpose.

### `alerts[]`

| Field | Store column (`budget_alerts`) |
|---|---|
| `workspace`, `project` | `project_id` of that seeded project. |
| `month` | `month` (first day of the UTC month, `YYYY-MM-01`). |
| `threshold`, `status`, `attempts` | Same name. |
| `claimedOffsetMs` / `claimedAtUtc` | `claimed_at = now + claimedOffsetMs`; the UTC string is informative and checked like `receivedAtUtc`. |
| `sentOffsetMs` / `sentAtUtc` | `sent_at`; omitted → `NULL`. |

### `steps[]`

Method names and signatures of the repository are not in any contract text (A1). The runner maps each `op` to the repository method with that intent. Every call receives the step clock (`now + atOffsetMs`).

| `op` | Call | `expect` |
|---|---|---|
| `status` | Budget status of `project` (a slug of `workspace`) or `foreignProject` (`{ workspace, slug }` of another workspace), read in the context of `workspace`. | `null` → the result is `null`. Object → partial [`BudgetStatus`](#comparison). |
| `claimAlert` | Evaluate the budget of `project` and claim the highest newly crossed threshold. With `parallel: n`, start `n` calls together (`Promise.all`) and await all. | `null` → every result is `null`. Object → exactly **one** result matches it and the other `n − 1` are `null`; `label` names that job. `acceptNull: true` (A5 only) → a `null` result also passes. |
| `markAlert` | Report the outcome (`sent` / `failed`) of the job named by `job` (its `alertId`). | `{ "ok": true }` → it does not throw. |
| `setBudget` | Set (`limitUsd` number) or clear (`limitUsd: null`) the budget of `project` or `foreignProject` in the context of `workspace`; `by` is the acting user (recorded as `updated_by`). | `{ "ok": true }` or `{ "ok": false, "errorKind": … }`: the call throws or returns an error result; `errorKind` is informative (A9). The following `status` steps prove nothing changed. |
| `insertEvents` | Store more `events` (same rules) between two steps. | — |
| `alertRows` | Read the `budget_alerts` rows of the project straight from the table (tables.ts contract). | `rows[]`: each entry matches exactly one row by (`month`, `threshold`); listed fields compared. `exact: true` → the project has no other rows. |

## Runner rules

### Isolation

Run each vector against a **fresh database** (PGlite with the JD-M06 migrations through 0005 is enough). Vectors reuse slugs (`web`, `api`) and emails, and workspace isolation is itself under test.

### Seeding

Seed directly into the store, not through ingest or the UI: the read and claim logic is under test, and ingest would stamp `received_at` with the real clock.

1. For each user, insert a `users` row (`name` = the key, `email`, `email_verified`).
2. For each workspace key, insert a `workspaces` row (unique `slug` of the runner's choice, `name`), then one `workspace_members` row per member with its `role`.
3. For each project, insert a `projects` row as in the analytics suite (`platforms = {claude-code}`, `privacy_class = 'L0'`, `last_signal_at` = newest seeded `received_at` or `NULL`). With `budget`, insert a `project_budgets` row (`workspace_id` of its workspace, `monthly_limit_usd = limitUsd`, `updated_by = NULL`).
4. Insert `events` as in the analytics suite with `producer_id = 'prod_budgets_qa'`, a unique canonical ULID `event_id`, `privacy_class = 'L0'`, `encrypted = NULL`.
5. Insert `alerts` rows.

### Pinned clock

ADR-0014 measures spend "up to the database `now()`", forecast elapsed time and the 10-minute staleness from a clock. Every expectation here is relative to the vector's `now` (or the step clock), so the runner must be able to pin that clock for every call: a `now` option, an injected clock, or a database whose `now()` is pinned. If the repository offers none, report every vector BLOCKED (each one depends on the month of its `now`). Do not loosen them, and do not rebase a vector onto another instant (month and day boundaries depend on it).

### Concurrency

`parallel` steps start all calls before awaiting any. Against PGlite (one connection) the calls interleave at statement level, which proves the claim logic; a pooled Postgres run is stronger and is the Developer lane's call. A runner that serialises the calls one by one must report the step NOT RUN, not PASS.

### Comparison

- **`limitUsd`**: a number (a string such as `"100.00"`, as numeric columns often arrive from drivers, fails), `|actual − expected| ≤ 1e-9`.
- **`spendUsd`**: number, `|actual − expected| ≤ 1e-6`.
- **`percentUsed`**: number or `null`, `≤ 0.01` percentage points (A3).
- **`forecastUsd`**: number or `null`, `≤ 0.01` USD (A3).
- **`month`**: exact string (`YYYY-MM`). **`reports`, `estimatedReports`, `attempts`, `threshold`**: exact integers.
- **`alerted`, `recipients`**: set equality (order ignored; a duplicate fails).
- **`null`** is not `0`, `""`, `[]` or absent.
- **Not checked unless listed:** any field the vector omits, including `generatedAt` (I1), `alertId`, `claimedAt`, `sentAt`.

### Invariants checked at every `status` result and every claimed job

| ID | Check |
|---|---|
| I1 | `generatedAt` parses as an instant (equality with the step clock is not asserted). |
| I2 | `percentUsed` is `null` exactly when `limitUsd` is `null`; otherwise `abs(percentUsed − spendUsd ÷ limitUsd × 100) ≤ 0.01`. |
| I3 | `forecastUsd` is `null` exactly when less than 24 h of the step clock's UTC month have elapsed; otherwise `forecastUsd ≥ spendUsd − 1e-6`. |
| I4 | `month` is the UTC month of the step clock; `0 ≤ estimatedReports ≤ reports`; `spendUsd ≥ 0`. |
| I5 | `alerted` ⊆ {80, 100} without duplicates. |
| I6 | A job's `projectId`, `workspaceId`, `projectSlug`, `projectName` are the seeded project's; `job.status.limitUsd` is not `null`; `job.status.percentUsed ≥ threshold − 0.01`; every recipient is the email of a verified owner of the job's workspace (I6 alone fails a job that mails an admin, member, unverified or foreign user). |
| I7 | After every step, every `budget_alerts` row has `1 ≤ attempts ≤ 5` and `status` ∈ {pending, sent, failed, covered}. |

### Results

Report PASS, FAIL, BLOCKED, NOT RUN or SKIPPED per vector, following the Orcasus contract. A seeding error or a `*AtUtc` mismatch is BLOCKED (setup failed), never FAIL and never PASS.

## Derived rules under test

Quoted from ADR-0014 "Decision outcome" unless a row says otherwise.

| Rule | Text | Vectors |
|---|---|---|
| Calendar month | "received in the current **UTC calendar month** up to the database `now()`" | 01, 02, 05, 06, 07, 08, 20 |
| Received time | "events **received**"; spec §10 "record receipt time separately" | 02 |
| Only usage | "`usage_delta.cost_usd` of the project's `usage.reported` events"; `estimatedReports` "shown alongside" | 03 |
| Per project | "One optional monthly limit per project"; TEST_PLAN "Isolation" | 04, 21, 24 |
| Forecast | "linear: `spend × month length ÷ elapsed`, only once ≥ 24 h of the month have elapsed"; types.ts "null before 24 h" | 01, 02, 05, 06, 07, 08, 25 |
| Thresholds | "80 % and 100 % of the limit"; "highest newly crossed threshold" | 09, 10, 11, 12, 13, 19 |
| Covered | "When 100 % is crossed directly, the 80 % alert is recorded as covered, not sent separately"; types.ts `alerted` "sent or covered" | 13, 14 |
| Exactly once | "`INSERT … ON CONFLICT DO NOTHING RETURNING`"; "idempotent across concurrent ingests and retries"; review focus "exactly one email" | 10, 11, 14, 15 |
| Retry | "on failure `status = failed` and a later ingest may reclaim it (`failed`, or `pending` older than 10 min) up to 5 attempts" | 15, 16, 17, 18 |
| Raised limit | "Raising a limit mid-month does not re-send a threshold already alerted this month" | 19 |
| Per month | "Exactly-once per (project, month, threshold)"; tables.ts "First day of the UTC month" | 20 |
| Recipients | "emails the workspace **owners** (verified `users.email` via `workspace_members.role = 'owner'`)" | 21, 22 |
| Budget optional | "One optional monthly limit"; "Set or cleared"; types.ts "null when the project has no budget" | 04, 23 |
| Limit range | "`numeric(12,2)` with `0 < x ≤ 1 000 000`"; SPRINT-04c B3 "(validated)" | 25 |
| Workspace scope | TEST_PLAN "status/set/clear only within the workspace … foreign project → null / refused" | 24 |

## Vectors

25 vectors. Unless a row says otherwise, `now` is `2026-10-28T12:00:00.000Z` (27.5 days into a 31-day month: forecast factor 31 ÷ 27.5), every workspace has one verified owner `o1`, and limits are in USD.

| # | Vector | Case | Key expectation |
|---|---|---|---|
| 01 | [`01-month-start-boundary.json`](01-month-start-boundary.json) | Reports at 09-30 23:59:59.999 and 10-01 00:00:00.000 | Spend 4 (the 5 and 9 USD September reports excluded), 4 %, forecast 4.51, no claim |
| 02 | [`02-received-time-not-occurred-time.json`](02-received-time-not-occurred-time.json) | Spooled report vs clock-ahead report across the month start | Spend 4.5 by `received_at`, forecast 5.07 |
| 03 | [`03-only-usage-reported-counts.json`](03-only-usage-reported-counts.json) | `cost_usd` on five other types (149.99 USD) | Spend 4, reports 3, estimatedReports 1, no claim |
| 04 | [`04-project-and-workspace-isolation.json`](04-project-and-workspace-isolation.json) | Sibling project and same slug in B | Each project sees only its own spend |
| 05 | [`05-forecast-null-before-24h.json`](05-forecast-null-before-24h.json) | `now` 2026-11-02 00:00; step at −1 ms | `null` at 24 h − 1 ms, 60 at 24 h |
| 06 | [`06-forecast-31-day-month-on-day-31.json`](06-forecast-31-day-month-on-day-31.json) | `now` 2026-10-31 23:00; report on day 1 | Spend 743 incl. day 1, forecast 744 |
| 07 | [`07-forecast-february-28-days.json`](07-forecast-february-28-days.json) | `now` 2026-02-08 00:00 | Forecast 28, month `2026-02` |
| 08 | [`08-forecast-february-29-days-leap-year.json`](08-forecast-february-29-days-leap-year.json) | `now` 2028-02-08 00:00 | Forecast 29, month `2028-02` |
| 09 | [`09-threshold-79-99-percent-no-alert.json`](09-threshold-79-99-percent-no-alert.json) | 79.99 of 100 | No claim, no row |
| 10 | [`10-threshold-80-percent-exact.json`](10-threshold-80-percent-exact.json) | 80.00 of 100 | One job at 80; after sent `alerted` [80]; no second job |
| 11 | [`11-threshold-99-99-then-100-percent.json`](11-threshold-99-99-then-100-percent.json) | 80 sent; 99.99, then +0.01 | No job at 99.99; one job at 100 |
| 12 | [`12-threshold-80-percent-decimal-sum.json`](12-threshold-80-percent-decimal-sum.json) | 64.60 + 14 × 1.10 (A4) | One job at 80 |
| 13 | [`13-jump-to-100-covers-80.json`](13-jump-to-100-covers-80.json) | 0 → 120 % | Job at 100; 80 `covered`; `alerted` [80, 100] |
| 14 | [`14-parallel-claims-exactly-one-job.json`](14-parallel-claims-exactly-one-job.json) | 5 parallel claims at 100 % | One job, four `null`; then five `null` |
| 15 | [`15-parallel-reclaim-of-failed-alert.json`](15-parallel-reclaim-of-failed-alert.json) | Failed row (attempts 2), 5 parallel claims | One job; attempts 3 |
| 16 | [`16-failed-alert-retried-by-later-claim.json`](16-failed-alert-retried-by-later-claim.json) | Send fails, next claim | Retried (attempts 2); failed not in `alerted` |
| 17 | [`17-retry-capped-at-5-attempts.json`](17-retry-capped-at-5-attempts.json) | Failed rows at attempts 4 and 5 (A8) | 4 → one retry to 5; 5 → never |
| 18 | [`18-stale-pending-reclaimed-fresh-not.json`](18-stale-pending-reclaimed-fresh-not.json) | Pending claimed 11 min vs 9 min ago (A7) | 11 min reclaimed (attempts 2); 9 min not |
| 19 | [`19-raised-limit-does-not-realert.json`](19-raised-limit-does-not-realert.json) | 80 sent at 100, limit → 200, spend 170 then 210 | No second 80; one job at 100 |
| 20 | [`20-previous-month-alerts-do-not-count.json`](20-previous-month-alerts-do-not-count.json) | September rows and spend | October `alerted` [] then new 80 job |
| 21 | [`21-recipients-verified-owners-only.json`](21-recipients-verified-owners-only.json) | Owners (verified, unverified), admin, member, cross-workspace users | A: {o1, o3}; B: {bo, bx} |
| 22 | [`22-no-verified-owner.json`](22-no-verified-owner.json) | Only owner unverified (A5) | `null` or job with no recipients |
| 23 | [`23-no-budget-then-set-then-clear.json`](23-no-budget-then-set-then-clear.json) | No budget, set 100, clear | `null` limit and percent, no claim; then 90 % and job at 80; cleared → no claim |
| 24 | [`24-foreign-project-status-null-set-refused.json`](24-foreign-project-status-null-set-refused.json) | Project id of B used from A | Status `null`; set refused; B unchanged |
| 25 | [`25-set-budget-validation.json`](25-set-budget-validation.json) | 0, −1, 1 000 000.01, 12.345, 1 000 000, 0.01 (A10, A13) | Four refused (limit stays 50); bounds accepted; forecast 0 |

## Ambiguities

Line numbers refer to `docs/adr/0014-budgets-forecast-and-alerts.md` (ADR), `packages/resilience/src/types.ts` (types) and `packages/resilience/src/tables.ts` (tables) at commit `025e35d`.

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| A1 | `index.ts` exports `createBudgetRepository` and `BudgetRepository` only; ADR L15 "up to the database `now()`" | Method names, argument order, and how a caller pins the clock are not specified. | Ops are named by intent (`status`, `claimAlert`, `markAlert`, `setBudget`); the runner maps them. No way to pin the clock → BLOCKED ([Pinned clock](#pinned-clock)). |
| A2 | ADR L15 "received in the current UTC calendar month up to the database `now()`" | Is a report received exactly at `now` (or after it, possible with a pinned clock) included? | Untested: every report is at least 1 ms before its step clock. The start bound is inclusive (01, 05, 06: 00:00:00.000 counts). |
| A3 | types L12 "spend / limit × 100"; ADR L16 "linear" | Are `percentUsed` and `forecastUsd` rounded (integer percent, cents)? | Unrounded within 0.01; integer rounding fails 01, 02, 06, 09, 11. Display rounding belongs to the UI. |
| A4 | ADR L14 `numeric(12,2)`; spec §6 "`cost_usd` (non-negative number)" | Are costs summed as decimals or binary floats when compared with 80 % / 100 %? | Decimal (cents): 64.60 + 14 × 1.10 = 80.00 crosses 80 % (12), although every float summation order gives 79.99999999999991–79.99999999999999. |
| A5 | ADR L17 "emails the workspace owners (verified `users.email` …)" | No verified owner: is a row claimed with no recipients, or nothing claimed? Is it retried later? | Either `null` or a job at 80 with `recipients: []` passes (22); never an admin or member address. Follow-up behaviour is untested. |
| A6 | ADR L17 "the 80 % alert is recorded as covered"; tables `covered (a higher one was sent)` | Is the covered 80 row written at claim time or when 100 is marked sent; what `attempts` does it carry; what if the 100 send fails, or 80 was `failed` when 100 is crossed? | Checked only after the 100 job is marked sent (13, 14), without `attempts`. The other cases are untested. |
| A7 | ADR L18 "`pending` older than 10 min" | Exactly 10 min: stale or not? Measured from `claimed_at`? | 11 min reclaimed, 9 min not, both from seeded `claimed_at` (18). The exact boundary is untested. |
| A8 | ADR L18 "up to 5 attempts"; tables L61 `attempts` default 1 | Does `attempts` count the first claim; is a row at 5 ever reclaimed; is there a back-off before a retry? | The first claim is attempt 1; each reclaim adds 1; a row at 5 is never reclaimed (17). A failed row is reclaimable by the very next claim, without back-off (16). |
| A9 | ADR L14 "Set or cleared by workspace owners and admins only" | Does the repository enforce roles, or the server action (B3)? Is a refusal a throw or a result value? | Roles are not tested here (B3 component and server-action tests own the role matrix); `by` is only recorded. A refusal is a throw or an error result; `errorKind` is informative, and the following `status` proves no change (24, 25). |
| A10 | ADR L14 `numeric(12,2)` | 12.345: refuse, or store as 12.35 (what Postgres would do silently)? | Refused, never silently rounded (25). |
| A11 | types L4–L12 (`limitUsd`, `percentUsed` null without a budget) | Without a budget, is `spendUsd` still computed; is `forecastUsd` given; does `alerted` keep rows after the budget is cleared? | `spendUsd` and `reports` are computed (04, 23). Forecast and `alerted` after clearing are not asserted (23). |
| A12 | types L17 `alerted` "sent or covered" | Are `pending` and `failed` thresholds alerted? | No (15, 16, 17, 18 assert `[]` while only pending or failed rows exist). |
| A13 | ADR L16 forecast "only once ≥ 24 h" | Zero spend after 24 h: forecast `0` or `null`? | `0` (25). |
| A14 | TEST_PLAN "foreign project → null / refused" | `claimAlert` with a foreign project id; an id that matches no project; `not_found` vs `forbidden`? | Untested for claims and unknown ids; `setBudget` refusal kind is informative (24). |
| A15 | ADR L18 "Raising a limit mid-month does not re-send" | Lowering a limit; a `failed` threshold that is no longer crossed after a raise? | Untested. |
| A16 | ADR L16 "month length ÷ elapsed" | Is the month the UTC month of the step clock and elapsed `clock − month start`? What at elapsed 0? | Yes (05–08: 30, 31, 28 and 29 days). Elapsed 0 is untested, but it is below 24 h, so it must be `null`. |
