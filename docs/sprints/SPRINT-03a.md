# Sprint 03a — JGR ingress endpoint

- Dates: 2026-10-23 (timebox 30 min) · Status: **IN PROGRESS**
- Goal: a collector holding a project ingest token can `POST /api/v1/events`; valid events are stored once, invalid ones are rejected with stable codes, and the project shows a verified last signal.
- Modules touched: JD-M05 (new package `@javis-dog/ingest`), JD-M06 (`events`, rate windows, migration 0002), JD-M04 (`verifyToken` returns project scope), JD-M01 (two issue codes), JD-APP (route)
- Readiness gate: S2 closed; local toolchain AVAILABLE; `DATABASE_URL` not on this machine → owner applies migration 0002 (Q3)
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S3a
- Decisions: ADR-0008 (events, retention, rate limit, ingress rules)

## Global constraints

- Tenant scope comes from the token only: `project_ref` in an event must name the token's project (slug or id), never another one.
- Events are stored as validated by JD-M01: nothing outside the agreed envelope; no request headers, IPs or token values are persisted or logged.
- `last_signal_at` is written only after at least one event was stored (product rule 2).
- Responses carry counts and issue codes only; DB/driver errors never reach the client.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | `events` + `ingest_rate_windows` tables, migration 0002 + rollback | JD-M06 | Unique `(project_id, producer_id, event_id)`; composite FK to `projects(id, workspace_id)` with cascade; up/down/re-apply on PGlite | Done (PGlite) · Neon pending owner |
| 2 | Event repository | JD-M06 | `insertEvents` returns stored count (duplicates skipped, also within one batch); `hitRateWindow` atomic upsert; `purgeEventsBefore`; `touchSignal` updates `last_signal_at`/`last_used_at` | Done |
| 3 | Token scope | JD-M04 | `verifyToken` also returns project slug and privacy class | Done |
| 4 | Ingest handler | JD-M05 | Auth 401, size 413 (incl. gzip bomb), malformed 400, rate 429 + `Retry-After`, partial 202 `{accepted, duplicates, rejected}`, project mismatch and privacy ceiling rejected per event, DB failure 503 | Done |
| 5 | Route | JD-APP | `POST /api/v1/events`, Node runtime, `no-store`; 503 `not_configured` without `DATABASE_URL` | Done |
| 6 | Docs | all | ADR-0008, spec §8/§13 update, READMEs, registry, changeset, memory | Done |
| 7 | Apply 0002 on `dev-agent` + live POST | owner | `db:migrate` exit 0; `db:smoke` all PASS; one real batch → 202 | **Pending owner** (commands below) |

## Owner steps (Q3)

Run in PowerShell from the repository root. Paste the `dev-agent` connection string where shown; it stays in that shell only.

```powershell
$env:DATABASE_URL = '<dev-agent connection string>'
pnpm --filter @javis-dog/event-store db:migrate
pnpm --filter @javis-dog/event-store db:smoke
Remove-Item Env:DATABASE_URL
```

Until this runs, production `POST /api/v1/events` answers `503` for valid tokens (the rate-window table does not exist yet); nothing else changes.

## Review focus

- Token of project A + event with `project_ref` of project B → rejected `project_mismatch`, nothing stored for B.
- Same batch sent twice → second response `accepted: 0, duplicates: n`; counters unchanged.
- 20 KB gzip that inflates past 256 KB → 413 without inflating it all.

## Log

- 2026-10-23 — Built tasks 1–6 on the owner's Windows machine. First full run caught: Turbopack resolving `new URL('../migrations', import.meta.url)` in app bundles → moved to the separate entry point `@javis-dog/event-store/migrations`; one test typing error; formatting. Smoke script updated for the new tables. A mutation check (disable the `project_mismatch` guard, expect red) was blocked by the session's permission classifier → NOT RUN; the guard is covered by two handler tests.
- 2026-10-23 — Sprint start; discovery delta and owner answers Q1–Q3 recorded (`DISCOVERY_SUMMARY.md`).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm format:check` / `lint` / `typecheck` / `docs:check` / `build` (Windows, Node 22.23.4) | 0 | — | all | 0 | 0 | 0 | 0 | `/api/v1/events` dynamic route built |
| `pnpm test` (workspace) | 0 | — | 243 | 0 | 0 | 0 | 0 | web 82, ingest 19, event-store 36, projects 27, identity 13, jgr-spec 29, ui 33, notify 4 |
| `db:generate` drift check | 0 | — | 1 | 0 | — | — | — | "No schema changes" |
| Mutation check on `project_mismatch` | — | — | — | — | — | 1 | — | blocked by permission classifier |
| `db:migrate` + `db:smoke` on `dev-agent` | — | — | — | — | — | — | 1 | owner step (no `DATABASE_URL` locally) |
| Live `POST /api/v1/events` on production | — | — | — | — | — | — | 1 | after migration |

Screenshots: 0.

## Decisions and deviations

- S3 split into S3a (this), S3b (JD-M02 SDK + retention purge job), S3c (JD-C01 collector, OTLP receiver).

## Retro

## Guru checkpoint

G2 due at the end of S3 (signal path proven end to end).
