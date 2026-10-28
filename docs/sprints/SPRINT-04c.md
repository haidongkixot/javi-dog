# Sprint 04c — Budgets, forecast and alerts (JD-M12, Resilience v1)

- Dates: 2026-10-28 (timebox 30 min) · Status: **ACTIVE**
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
| M2 | Tables + migration 0005 | JD-M12, JD-M06 | `project_budgets`, `budget_alerts` | Composite FK (project, workspace); limit check; unique alert key; up/down tested | Done (code) |
| B1 | Budget logic + repository; retention keeps the current month | JD-M12, JD-M06 | `forecastSpend`, `crossedThreshold`, `utcMonth`, `createBudgetRepository`; `retentionCutoff` | ADR-0014 rules; claim exactly once (concurrency test); retry failed/stale pending ≤ 5; covered lower threshold | Planned |
| B2 | Alert email + ingest hook + route wiring | JD-M09, JD-M05, JD-APP | `budgetAlertEmail`, `sendBudgetAlertEmail`; handler `onStored`; route `after()` | Email L0 + "estimated"; hook only when usage stored for the project; send → markAlert; errors logged by name | Planned |
| B3 | Budget UI | JD-APP | repository → Project detail budget card + server actions; Projects list column | Owners/admins edit (validated), members read-only; percent with text; forecast or "too early"; alerts this month | Planned |
| Q3 | Budget vectors (QA, independent) | docs | `docs/jgr/conformance/budgets/*.json` | From ADR-0014 only | Planned |

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

- 2026-10-28 — Orchestrator — Owner decisions (monthly USD per project; on ingest; owners at 80 %/100 %). ADR-0014. Found: 30-day retention would undercount month-to-date spend on day 31 → cutoff keeps the current UTC month (ADR-0008 change, flagged to owner). Tables with a composite FK (project, workspace) after catching that a plain FK allowed a cross-workspace budget row; migration 0005 + rollback + tests (event-store 48). Screenshot budget 0.

## Log

- 2026-10-28 — Sprint start (plan, scaffold, migration 0005 code).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `vitest run` (event-store, after 0005) | 0 | — | 48 | 0 | 0 | 0 | 0 | incl. cross-workspace refusal |
| `db:generate` drift after 0005 | 0 | — | no changes | — | — | — | — | — |

## Decisions and deviations

- Retention keeps the current UTC month (≤ 31 days instead of 30) — owner informed.

## Retro

- Pending.

## Guru checkpoint

G3 at S4c close.
