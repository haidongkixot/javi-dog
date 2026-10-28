# Sprint 04c — Budgets, forecast and alerts (JD-M12, Resilience v1)

- Dates: 2026-10-28 (timebox 30 min) · Status: **BUILT** (CI green on `e968421`); real alert email waits on the owner's first real run
- Goal: owners set a monthly USD budget per project, see month-to-date estimated spend with a forecast, and workspace owners get one email at 80 % and at 100 % — triggered on ingest.
- Modules touched: JD-M12 (new), JD-M06 (migration 0005, retention cutoff), JD-M09, JD-M05, JD-APP, docs
- Readiness gate: owner decisions 2026-10-28 (ADR-0014); Resend + `eagodi.com` verified (S2c); migration 0005 on `dev-agent` after deploy; no `CRON_SECRET` needed
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S4c (written before the lanes start)

## Global constraints

- Money is always "estimated"; tokens per ADR-0013 `estimatedReports`.
- Exactly one email per (project, UTC month, threshold) across concurrent ingests and retries.
- Only owners/admins change budgets; only owners receive alerts; addresses never logged.
- Ingest latency unchanged: alert work runs after the response (`after()`); its failures never fail ingest.
- Screenshot budget **0**; no new dependency.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| M2 | Tables + migration 0005 | JD-M12, JD-M06 | `project_budgets`, `budget_alerts` | Composite FK (project, workspace); limit check; unique alert key; up/down tested | Done |
| B1 | Budget logic + repository; retention keeps the current month | JD-M12, JD-M06 | `forecastSpend`, `crossedThreshold`, `utcMonth`, `createBudgetRepository`; `retentionCutoff` | ADR-0014 rules; claim exactly once (concurrency test); retry failed/stale pending ≤ 5; covered lower threshold | Done |
| B2 | Alert email + ingest hook + route wiring | JD-M09, JD-M05, JD-APP | `budgetAlertEmail`, `sendBudgetAlertEmail`; handler `onStored`; route `after()` | Email L0 + "estimated"; hook only when usage stored for the project; send → markAlert; errors logged by name | Done |
| B3 | Budget UI | JD-APP | repository → Project detail budget card + server actions; Projects list column | Owners/admins edit (validated), members read-only; percent with text; forecast or "too early"; alerts this month | Done |
| Q3 | Budget vectors (QA, independent) | docs | `docs/jgr/conformance/budgets/*.json` | From ADR-0014 only | Done |

## Review focus

- Two ingest batches crossing 100 % at the same time → exactly one email (B1/B2).
- A member (not owner/admin) posts the budget server action → refused (B3).
- Email provider fails → status `failed`, retried on the next usage report, never more than 5 attempts (B1/B2).
- Day 31 of a 31-day month → spend still includes day 1 (retention cutoff, B1).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | ADR-0014, tables + migration 0005, scaffold, docs, merge, push, migration on `dev-agent` |
| Developer A | general-purpose, worktree | B1: `packages/resilience/src/{budget,repository}.ts` (+ private modules), `packages/resilience/test/**`, `packages/event-store/test/budgets.test.ts`, `packages/event-store/src/events.ts` (`retentionCutoff` only) + its test |
| Developer B | general-purpose, worktree | B2: `packages/notify/**`, `packages/ingest/src/handler.ts` + `packages/ingest/test/**`, `apps/web/src/app/api/v1/events/route.ts`, `apps/web/src/lib/{ingest,budget-alerts}.ts`, `apps/web/test/budget-alerts*.test.ts` |
| Developer C | general-purpose, worktree | B3: `apps/web/src/app/projects/**`, `apps/web/src/components/budget/**`, `apps/web/src/lib/budgets.ts`, `apps/web/test/budget-ui*.test.ts(x)` |
| QA | general-purpose, worktree | Q3: `docs/jgr/conformance/budgets/**` |
| Reviewer | general-purpose, read-only | combined diff |

Team log, newest first:

- 2026-10-28 — Orchestrator — Merged review fixes (`3302798`). Resend idempotency semantics could not be verified (resend.com outside the session's allowed domains) → key made unique per attempt (`BudgetAlertJob.attempt`), DB test asserts attempt 1 → 2…5. Budget runner tolerance made strict (removed float slack that had hidden the rounding defect): 25/25 still pass.
- 2026-10-28 — Developer — Review fixes 1–8, tests first: red resilience 16 / event-store 6 / notify 12 / web 9 FAIL, then green (resilience 42, event-store 81, notify 26, ingest 78, web 302; ×2).
- 2026-10-28 — Developer D — Budget conformance runner: 25/25; mutations: no ON CONFLICT → 9 vectors FAIL; stale window 0 → only 18 FAIL; restored. Flagged that 09/11 passed only through float slack.
- 2026-10-28 — Reviewer — no blockers; 4 major (UI claimed "emailed" for covered/failed alerts; percent rounded up into false thresholds; month aggregate on every usage batch even without a budget; Resend without timeout/idempotency), 3 minor, 3 nits; verified server-action authorization, recipient scoping, claim races, `after()` semantics in Next 16, HTML escaping, retention.
- 2026-10-28 — Orchestrator — Merged B2 (`bfddbfa`), B3 (`972965c`; one file outside its declared paths, `components/dashboard/projects-table.tsx` +7 lines, the only place the Budget column could go — accepted, logged), Q3 (`419139f`). Gate: docs:check caught a stale module registry (notify provides) — regenerated. Runner for the budget vectors delegated to a fresh lane (independent of B1).
- 2026-10-28 — Orchestrator — Real-Postgres concurrency check on `dev-agent` (throwaway script, ephemeral workspace, cascade cleanup, no email): 5 parallel claims → 1 job at 100 %, 80 % covered. Closes B1's caveat that PGlite serializes queries.
- 2026-10-28 — QA — 25 vectors, A1–A16.
- 2026-10-28 — Developer C — B3: budget card, form (owners/admins), Budget column; 65 tests; percent rounds down (79.99 % → "79 %").
- 2026-10-28 — Developer B — B2: `sendEmail`, budget template, one email per recipient, `onStored` hook, `after()` wiring; notify 14, ingest 78 (conformance 43/43), web 223.
- 2026-10-28 — Developer A — B1: budget arithmetic (exact micro-dollars), repository, retention cutoff; resilience 26, event-store 76; mutation (no ON CONFLICT) → 6 FAIL.
- 2026-10-28 — Orchestrator — Migration 0005 applied to `dev-agent` after deploy `025e35d` READY (smoke 10/10, 6 migrations). Production `/api/health` checks from this sandbox failed intermittently with TLS `SSL_ERROR_SYSCALL` (sandbox egress); successful checks showed health ok, Vercel runtime errors (6 h): none.
- 2026-10-28 — Orchestrator — Owner decisions (monthly USD per project; on ingest; owners at 80 %/100 %). ADR-0014. Found: 30-day retention would undercount month-to-date spend on day 31 → cutoff keeps the current UTC month (ADR-0008 change, flagged to owner). Tables with a composite FK (project, workspace) after catching that a plain FK allowed a cross-workspace budget row; migration 0005 + rollback + tests (event-store 48). Screenshot budget 0.

## Log

- 2026-10-28 — Sprint start (plan, scaffold, migration 0005 code); pushed `025e35d` (CI 40680524099 PASS), `fd61ca5` (CI 40681669775 PASS).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `vitest run` (event-store, after 0005) | 0 | — | 48 | 0 | 0 | 0 | 0 | incl. cross-workspace refusal |
| `db:generate` drift after 0005 | 0 | — | no changes | — | — | — | — | — |
| `db:migrate` 0005 + `db:smoke` (dev-agent) | 0 | — | 10 | 0 | 0 | 0 | 0 | 6 migrations |
| Real-Postgres parallel claims (dev-agent, throwaway) | 0 | — | 1 job of 5 | 0 | 0 | 0 | 0 | cleaned up |
| Lanes (resilience 26, event-store 76, notify 14, ingest 78, web 284) | 0 | — | all | 0 | 0 | 0 | 0 | 2 runs each |
| Full gate after merges (`format`/`lint`/`typecheck`/`test`/`build`) | 0 | — | 1037 | 0 | 0 | 0 | 0 | docs:check failed first (stale registry) → fixed |
| Budget runner (strict tolerance) | 0 | — | 26 | 0 | 0 | 0 | 0 | 25 vectors + count |
| Mutation: no ON CONFLICT in the claim | 1 | — | 17 | 9 | 0 | 0 | 0 | 10, 11, 13–19 |
| Mutation: stale window 0 | 1 | — | 25 | 1 | 0 | 0 | 0 | 18 only |
| Review fixes: new tests against the old code (red first) | 1 | — | — | 43 | 0 | 0 | 0 | resilience 16, event-store 6, notify 12, web 9 |
| Full gate after review fixes | 0 | — | 1105 | 0 | 0 | 0 | 0 | drift clean |
| CI on `e968421` / `e564df8` | 0 | — | runs 40684915546 / 40685564553 | 0 | 0 | 0 | 0 | production health ok, no runtime errors |
| Rendered layout of the budget card / Budget column | — | — | — | — | — | — | 1 | screenshot budget 0 |
| Real alert email to the owner | — | — | — | — | — | — | 1 | owner's first real run with a budget |

## Decisions and deviations

- Retention keeps the current UTC month (≤ 31 days instead of 30) — owner informed.

## Retro

- Went well: real-Postgres concurrency check closed PGlite's blind spot; QA vectors + a strict runner exposed the rounding defect; the Reviewer caught "emailed" claims that were not true.
- Hurt: a runner added float slack that hid a defect (caught at review); an outbound-email feature shipped to review without a timeout; Resend docs unreachable from the session.
- Change next sprint: conformance tolerances are never widened in runners; every outbound HTTP call gets a timeout by default; allow-list vendor docs needed for verification before the sprint starts.

## Guru checkpoint

G3 at S4c close.
