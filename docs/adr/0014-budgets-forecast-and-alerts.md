# ADR-0014: Monthly project budgets, forecast and alerts on ingest

- Status: **Accepted** 2026-10-28 (owner: "Monthly $ per project", "On ingest, no cron", "Workspace owners, 80% + 100%")
- Date: 2026-10-28
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules: JD-M12 (new, `@javis-dog/resilience`), JD-M09, JD-M05, JD-M06 (migration 0005), JD-APP; consumes JD-M04, JD-M03

## Context and problem statement

Roadmap S4 "Resilience v1": budgets, a forecast and exhaustion alerts. Usage arrives as `usage.reported` with `cost_usd`, which Claude Code calls an approximation (ADR-0011), so every money figure is **estimated**. `CRON_SECRET` is still missing and the Vercel plan (cron frequency) is unknown. Raw events are kept 30 days (ADR-0008).

## Decision outcome

- **Budget.** One optional monthly limit per project in USD (`project_budgets`: `project_id` PK → projects, `workspace_id`, `monthly_limit_usd numeric(12,2)` with `0 < x ≤ 1 000 000`, `updated_at`, `updated_by`). Set or cleared by workspace **owners and admins** only; members see it read-only.
- **Month-to-date spend** = sum of `usage_delta.cost_usd` of the project's `usage.reported` events received in the current **UTC calendar month** up to the database `now()`. `estimatedReports` (ADR-0013 Changes) is shown alongside.
- **Forecast** = linear: `spend × month length ÷ elapsed`, only once ≥ 24 h of the month have elapsed (else "too early to forecast"); labelled estimated.
- **Thresholds** 80 % and 100 % of the limit. **Alerts on ingest** (no cron): after a batch that stored ≥ 1 `usage.reported` for a project with a budget, the app (Next.js `after()`, so the ingest response is not delayed) evaluates the budget and, for the highest newly crossed threshold, emails the workspace **owners** (verified `users.email` via `workspace_members.role = 'owner'`). When 100 % is crossed directly, the 80 % alert is recorded as covered, not sent separately.
- **Exactly-once per (project, month, threshold).** `budget_alerts (project_id, month, threshold, status, claimed_at, sent_at, attempts)` with a unique key: a row is **claimed** with `INSERT … ON CONFLICT DO NOTHING RETURNING` before sending; on success `status = sent`; on failure `status = failed` and a later ingest may reclaim it (`failed`, or `pending` older than 10 min) up to 5 attempts. Raising a limit mid-month does not re-send a threshold already alerted this month.
- **Email content** (JD-M09): project name, month, month-to-date estimated spend, limit, percent, forecast, link to the project page. L0 only; addresses are never logged.
- **Retention change (ADR-0008 Changes).** The daily purge keeps the whole current UTC month: cutoff = `min(now − 30 days, start of the current UTC month)` — at most 31 days — so month-to-date spend is never undercounted on day 31.
- **UI.** Project detail: budget card (form for owners/admins, read-only otherwise) with month-to-date estimated spend, percent bar with text, forecast, alerts sent this month. Projects list: "Budget" column (percent used or "No budget").

## Consequences

- Positive: alerts within seconds of crossing, no scheduler or secret; idempotent across concurrent ingests and retries.
- Negative: no alert when no usage arrives (by design — spend cannot grow without reports); spend lags the export interval (~60 s); an email failure is retried only on the next usage report; one extra query on ingest batches with usage for budgeted projects.

## Changes

- 2026-10-28 (S4c implementation): thresholds compare exact integer micro-dollars; no verified owner → nothing is claimed (the next usage report claims once an owner is verified); `markAlert('failed')` only changes a `pending` row; 100 % covers a `pending`/`failed` 80 % row but never a `sent` one; `setBudget` on another workspace's project throws `not_found`, `clearBudget` there is a no-op; `onStored` fires for any batch with ≥ 1 valid `usage.reported` (also duplicates — claims are idempotent); without `RESEND_API_KEY`/`EMAIL_FROM`/`BETTER_AUTH_URL` no hook is wired and nothing is claimed; one email per recipient (owners never see each other's address).
- Known limitation: when one owner's email fails, the alert is `failed` and its retry re-sends to owners who already received it (duplicate emails possible, at most 5 attempts). Per-recipient delivery state is a follow-up. Resend rate limits are UNVERIFIED for workspaces with many owners.
- Verified on real Postgres (`dev-agent`, ephemeral workspace, cleaned up): 5 parallel `claimAlert` over separate connections → exactly 1 job (100 %), 80 % recorded `covered`.
- 2026-10-28 (S4c review, merged `3302798` + orchestrator follow-up): `alerted` lists only thresholds whose email was **sent** (80 % also when covered by a sent 100 %); new `pendingAlerts`, `failedAlerts`, `exhaustedAlerts`, `thresholdReached`; the card never says "emailed" otherwise and shows failed/gave-up states. `percentUsed` is exact spend ÷ limit × 100 floored to 0.01 (no rounding up), badges use the exact threshold. `claimAlert` checks the budget first (one primary-key lookup for unbudgeted projects, no events aggregate). Resend calls time out after 10 s. Idempotency key `budget-alert/<alertId>/<attempt>/<recipient>` — unique **per attempt** because a retry carries new figures and Resend's behaviour for a reused key with a different body is UNVERIFIED (resend.com not reachable from this session); cross-attempt de-duplication is therefore not relied on and the duplicate limitation above stands. Email footer and card say "usually one email"; every percent says "estimated".
