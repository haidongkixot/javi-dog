---
name: exactly-once-threshold-alerts
description: Send threshold alerts (budget, quota, usage, error-rate, SLA) exactly once per subject, period and threshold, triggered from an ingest or write path — a claim row with a unique key taken with INSERT … ON CONFLICT DO NOTHING RETURNING, a higher threshold covering a lower one in the same statement, retries of failed or stale-pending claims with an attempt cap, side-effect work scheduled after the response so it never fails or slows ingest, a cheap early exit before any aggregate, exact integer arithmetic for thresholds, recipients scoped to the tenant's verified owners with one message per recipient, default timeouts on every outbound call, idempotency keys chosen for what the vendor is verified to do, and a concurrency check on a real multi-connection database because an embedded single-connection engine cannot prove it. Also covers keeping raw-data retention at least as long as the reporting period the alert reads. Use when building budget or quota alerts, "you reached 80 %" emails, webhook or notification fan-out from ingest, any once-per-period side effect, claim/lease tables, outbound email or HTTP from serverless handlers, or when tests for concurrency run on SQLite, PGlite or another single-connection engine.
metadata:
  version: "0.1.0"
  origin: "javis-dog G3"
  confidence: "medium (claim logic: unit + embedded-engine tests, 25 independent vectors with exact mutation results, one real-Postgres parallel check); low (delivery: real email NOT RUN, vendor idempotency semantics UNVERIFIED, rate limits UNVERIFIED)"
---

# Exactly-once threshold alerts

"Email the owners when spend crosses 80 % and 100 %" sounds like an `if`. On an ingest path it is a distributed-systems problem: batches arrive concurrently, the email provider fails or hangs, a retry carries new figures, the alert must never fail ingest, and the test database may not be able to run two statements at once.

The rule: **claim before you send, in one statement the database arbitrates; send after the response with a timeout; record the outcome; be explicit about which duplicates are still possible.**

## Forces

- **Exactly once vs. at least once.** A claim row makes the *decision* exactly once; delivery over a third-party API is at-least-once unless the vendor's de-duplication is verified.
- **Freshness vs. ingest latency.** Alerting on ingest is timely; computing a month aggregate on every batch is not free.
- **Test speed vs. realism.** Embedded engines are fast and single-connection; concurrency claims need a real server.

## 1. Model the claim

One row per `(subject, period, threshold)` with a unique constraint, a status in a closed set (`pending`, `sent`, `failed`, `covered`), `claimed_at`, `sent_at`, `attempts`.

- **Claim** with `INSERT … ON CONFLICT (subject, period, threshold) DO NOTHING RETURNING id, attempts`. Whoever gets a row back sends; everyone else does nothing.
- **Higher covers lower**, in the same statement: crossing 100 % marks a `pending`/`failed` 80 % row `covered`, never a `sent` one (no downgrade). One email, not two.
- **Re-claim** with one guarded `UPDATE … SET status = 'pending', claimed_at = now, attempts = attempts + 1 WHERE status = 'failed' OR (status = 'pending' AND claimed_at < now − stale) AND attempts < cap RETURNING …`. The stale window recovers a worker that died after claiming.
- **Mark** `sent` or `failed` only from `pending` (a late failure cannot overwrite a success).
- A raised limit in the same period does not re-alert (the key has no limit in it); decide and document that.
- No recipients (no verified owner) → claim nothing, so a later event can claim once someone qualifies.

## 2. Decide with exact arithmetic

Compare in integer minor units (micro-dollars, basis points): `spend ≥ limit` for 100 %, `spend × 100 ≥ limit × 80` for 80 %. Display values derive from the same arithmetic and are floored (see `truthful-live-status`).

## 3. Keep it off the ingest path

- Schedule the work **after the response** (your framework's post-response hook, a queue, or a background task the platform keeps alive). Its errors are caught and logged by name; the ingest status code never changes.
- Trigger only when the batch stored something relevant to that subject (duplicates may trigger too — claims are idempotent).
- **Cheap early exit first:** look up whether the subject has a threshold at all (one primary-key read) before aggregating anything.
- Without full sender configuration (API key, sender, base URL), wire no hook and claim nothing — otherwise claims are consumed by a sender that cannot send.

## 4. Send carefully

- **Every outbound call has a timeout by default**, in the one shared sender every feature uses. A timeout is a failed attempt — and an *unknown* outcome: the provider may have delivered.
- One message per recipient, so recipients never see each other's addresses; try every recipient, report failures, never log addresses.
- Recipients come from the tenant's verified owners at send time, never from input.
- **Idempotency keys:** use a vendor's key only for semantics you have verified. If you cannot verify what the vendor does with a reused key and a *different* body (a retry carries new figures), make the key unique per attempt and do not rely on cross-attempt de-duplication. Write the remaining duplicate case down as a known limitation (for example: one recipient's failure marks the alert failed, and the retry re-sends to recipients who already got it, at most *cap* times), with the follow-up (per-recipient delivery state).
- Copy matches the guarantee: "usually one email", amounts "estimated" when they are.

## 5. Prove concurrency on a real server

Embedded engines with one connection (PGlite, SQLite in-process) interleave concurrent calls at statement level at best; they prove the *logic* of the claim, not the database's arbitration between connections. Add one check against a real server:

1. Ephemeral tenant and subject in a non-production database, no outbound side effects (stub the sender).
2. *N* parallel claims over separate connections → exactly one job; the lower threshold `covered`.
3. Cascade-delete the ephemeral tenant; record command, result and cleanup in the iteration record.

A test runner that serialises "parallel" steps must report them NOT RUN, not PASS.

## 6. Retention must cover the period you report on

If raw events are purged after *N* days and the alert reads "this calendar month", a 31-day month loses its first day on day 31. Make the purge cutoff `min(now − N days, start of the current period)` and record the change in the retention decision.

## 7. Tests (lowest layer first)

| Case | Layer |
|---|---|
| Threshold boundaries (79.99 / 80 / 99.99 / 100 %), February, leap year, 31-day months | Unit |
| Claim once; jump to 100 % covers 80 %; retry failed; stale pending reclaimed, fresh not; cap reached; raised limit no re-alert; previous period ignored | Embedded engine |
| Parallel claims → one job | Embedded engine (logic) + real server (arbitration) |
| Hook only when relevant data stored; ingest status unchanged when the hook throws; scheduled after the response | Handler unit with fakes |
| Sender: timeout, one message per recipient, no address in logs, key format | Unit with a fake fetch |
| Mutation: remove `ON CONFLICT`; stale window 0 | Conformance runner — expect exactly the related vectors to fail |
| Real delivery to a real inbox | Runtime — NOT RUN until done, never assumed |

## Pitfalls

- **Check-then-insert in two statements.** Two batches both see "not alerted".
- **Aggregating on every write without a threshold.** Pay for the lookup only.
- **No timeout on the provider call.** A hung request holds the post-response task.
- **A stable idempotency key across retries with changed content** when the vendor's behaviour is unknown.
- **"Emailed" from the claim, not the outcome.**
- **Concurrency "proven" on one connection.**

## Evidence from origin project

Javi's Dog, Sprint 4c (2026-10-28), Postgres (Neon) in deployment, PGlite in tests, Resend REST for email, Next.js post-response hook. Decision record ADR-0014 and its *Changes*.

- Claim logic `fa20a50` (merged `fd61ca5`): `INSERT … ON CONFLICT DO NOTHING` claim, 100 % covers 80 % in the same statement, re-claim failed or > 10 min pending up to 5 attempts, verified owners only. Embedded-engine test "gives exactly one job to 5 concurrent claims" (`packages/event-store/test/budgets.test.ts` l. 302). Mutation: no `ON CONFLICT` → 6 FAIL in the lane's tests.
- Independent vectors: 25 (`docs/jgr/conformance/budgets/`, 16 ambiguities); runner by a lane independent of the implementation: 25/25; mutations — no `ON CONFLICT` → 9 vectors FAIL (10, 11, 13–19), stale window 0 → only vector 18 FAIL (`docs/sprints/SPRINT-04c.md` Test evidence). The suite README states that a runner serialising parallel steps must report NOT RUN.
- Real server: orchestrator's throwaway script on the development database, ephemeral workspace, cascade cleanup, no email: 5 parallel claims over separate connections → 1 job at 100 %, 80 % recorded `covered` (ADR-0014 *Changes*; `SPRINT-04c.md`). The script is not committed.
- Reviewer majors fixed red-first (`12fdd97`, merged `3302798`): month aggregate computed on every usage batch even without a budget → budget-first primary-key lookup; provider calls without timeout or idempotency → 10 s timeout in the shared sender (the earlier welcome-email call had no timeout either and now uses the same sender, `5686c6d`). Per-attempt key `budget-alert/<alertId>/<attempt>/<recipient index>` in `e968421`, because the provider's behaviour for a reused key with a different body could not be read from the session (vendor docs outside the allowed domains).
- Retention: 30-day retention would undercount month-to-date spend on day 31 → cutoff `min(now − 30 d, UTC month start)` (`packages/event-store/src/events.ts` l. 88–94; ADR-0008 *Changes*, owner informed).
- Ingest isolation: hook test `packages/ingest/test/handler.test.ts` l. 391 ff.; post-response scheduling `apps/web/test/budget-alerts-route.test.ts` l. 39.
- Known limitation recorded: partial recipient failure → duplicates on retry (≤ 5 attempts); provider rate limits for many owners UNVERIFIED (ADR-0014 *Changes*).
- Guru reading at G3 (not a defect report): the sender makes no in-attempt retry (`packages/notify/src/send.ts` l. 95–110), so the per-attempt key de-duplicates only a repeated processing of the same claimed attempt; and a timeout is marked `failed` although the provider may have delivered — a second documented duplicate path, not yet written in the decision record.
- NOT RUN: a real alert email to a real inbox (owner's first real run with a budget).
