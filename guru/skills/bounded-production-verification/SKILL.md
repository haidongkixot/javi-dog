---
name: bounded-production-verification
description: Verify a release on the real production environment with bounded, owner-approved checks — a load test whose budget (requests, events, wall time, concurrency, one ephemeral tenant) is fixed in a decision record before the run and frozen in code so no flag can raise it; an end-to-end smoke that installs the packed artifact in a temporary home and sends real events with planted privacy sentinels; credentials generated locally, stored on the server only as a hash, kept in a scratch file, passed on stdin and never printed; results read as counts and through the product's real reader; first-run failures treated as product findings, not tuning targets; destructive cleanup only after the owner says yes, with before/after counts. Also covers an evidence-per-item release checklist with a fixed status vocabulary and written exceptions. Use before a first release or a release gate, when someone wants to "load test production", "smoke test prod", "run an end-to-end check against the live site", measure p95 latency or payload limits on the real stack, seed test data on production, or decide whether a release checklist item is PASS.
metadata:
  version: "0.1.0"
  origin: "javis-dog G4"
  confidence: "medium (budgeted load test, packed end-to-end smoke, never-printed credentials and counted cleanup: each run once on production with recorded results; the first smoke run found a product defect)"
---

# Bounded production verification

Tests on a laptop or in CI cannot show how the deployed stack behaves: the real proxy, the real cold starts, the real database plan, the real environment variables users have. A production check can — and it can also fill a free-tier database, trip rate limits, leave test data among real users, or leak the credential it used. The checks below get production evidence with a written budget, no exposed secrets and a clean exit.

The rule: **fix the budget before the run and freeze it in code; never print the credential; read results as counts; clean up only with the owner's yes and record before/after.**

## Forces

- **Evidence vs. side effects.** Real numbers need real writes; real writes land among real data.
- **Load vs. limits.** Enough load to see the tail latency, little enough to stay under rate limits, plan quotas and the owner's patience.
- **Automation vs. exposure.** Scripts need a token; tokens in argv, logs or chat outlive the run.

## 1. Write the budget first

In the decision record (before any code): number of requests, events, maximum wall time, concurrency, the request mix (typical batches plus a few near the payload limit), the tenant (one ephemeral workspace/project), the target metric ("p95 < 2 s; a miss is a finding, not tuned away") and the cleanup rule. Measure limits where the server applies them: if the size limit applies **after decompression**, size near-limit payloads decompressed.

## 2. Freeze the caps in code

- Caps are constants in the script (`Object.freeze`), not flags. A requested plan is **clamped down, never up**, and the runner re-checks every request against the same constants before sending.
- Stop conditions: the first 401 (wrong or revoked credential), N consecutive 5xx or transport failures, the wall-time deadline.
- Unit-test the script against a local server with an injected clock: caps hold, stop conditions fire, near-limit payloads land within a stated tolerance under the limit.

## 3. Credentials that never appear

1. Generate the token locally; store only its hash on the server (seeded through an audited admin path, for example a database tool that never exposes the connection string to the session).
2. Keep the plaintext in a scratch file with mode 0600 outside the repository.
3. Pass it to programs on **stdin** or via a file path, never argv or environment dumps; scripts never print it.
4. Delete the scratch files after cleanup and say so in the record.

## 4. End-to-end with the shipped artifact

- Build and pack the real artifact, install it offline into a temporary prefix and home, run its real setup (token on stdin), fire the real hook or client events, flush, and assert the local queue is empty.
- **Plant privacy sentinels** (fake prompt text, secret-looking paths, tool content) in the inputs and scan everything that left the machine and everything stored for them: the expected number of hits is 0.
- Verify on the server by **counts** (events for the ephemeral project) and through the **product's own reader** (the dashboard's read model shows the thread with the expected state), not by reading rows.
- Run it with the environment real users have. In the origin, the sandbox needed a proxy variable that makes the runtime print a warning at startup; that warning broke the hooks' silence contract — a defect no CI run had shown.

## 5. Report what was measured

- Latency is **client-side, including every proxy in between**: an upper bound for the server path, not a server SLO. Say so.
- Record p50/p95/max, status counts, duplicates, rejects, caps hit (none, ideally) and where the tail came from if known ("first concurrent burst, plausibly cold starts" is a hypothesis; label it).
- A failed first run is a finding: diagnose, fix red-first, re-run once, record both runs.

## 6. Clean up with the owner, by counts

Destructive statements on production need the owner's explicit yes (some tool policies require it). Record: the statement's shape (delete the ephemeral tenant, cascading), counts **before** (tenants, projects, tokens, events) and **after** (all 0), and that scratch credentials were removed. If a scheduled job's first run cannot be observed conclusively, say "inconclusive" and schedule the conclusive check with a date.

## 7. Release checklist: evidence per item

Template: [`templates/release-checklist.md`](templates/release-checklist.md).

- Each item names the evidence it needs (command + exit code, CI run id, count) and where it is recorded. "Done" with no evidence counts as NOT RUN.
- Use one fixed status vocabulary (PASS / FAIL / BLOCKED / NOT RUN / ACCEPTED RISK). A deferral by the owner is not a new status: it is an **exception written in the checklist with date and owner**, or the item is not PASS.
- If evidence was gathered on a different environment than the item names (the owner kept production on the old database), the item says so and needs the same written exception.

## Pitfalls

- **Caps as defaults.** A flag that raises them will be used once by mistake.
- **"Just print the token to check it."** Compare by hash or length.
- **Reading production rows to verify.** Counts and the product's reader answer the question.
- **Tuning until the target passes.** Record the miss.
- **Testing without the users' environment variables.** Proxies, locales and shells change runtime output.
- **Cleanup without counts.** Nobody can tell later what was removed.

## Evidence from origin project

Javi's Dog, Sprint 5a (2026-10-28/29), release gate of a Next.js + Postgres SaaS and its CLI collector. Confidence **medium**: each check ran once on production with recorded results.

- Budget fixed in `docs/adr/0015-production-database-cutover-and-release-readiness.md` §6/§8 before the run: ≤ 70 requests in ≤ 2 min, ≤ 6 000 events, concurrency ≤ 5, one ephemeral workspace, hash-only token, cleanup after the owner's OK; corrected the same day to "256 KB after decompression" (`docs/sprints/SPRINT-05a.md` Team log).
- Caps in code: `packages/ingest/scripts/load-test-lib.ts` `CAPS` (frozen; clamped down only; stop after 3 consecutive failures); 20 unit tests against a local server (`SPRINT-05a.md`).
- Load test PASS on the database production reads: 55/55 × 202, 5 500 events, 0 duplicates, 0 rejected, 60.8 s, no cap hit; p50 130 ms, p95 1 529 ms, max 1 533 ms including the sandbox proxy; 5 near-limit batches (261 120 B raw / 177 200 B gzip) accepted (`SPRINT-05a.md` Log, 2026-10-29).
- End-to-end smoke: token on stdin (`collectors/claude-code/scripts/e2e-smoke.mjs` l. 9, 270–273), 5 sentinels, 0 hits. First run **FAIL** (delivery fine, 0 leaks): every hook wrote to stderr (reproduced directly: 177 B with the variable set, 0 B without) because `NODE_USE_ENV_PROXY=1` makes Node print an experimental warning at startup; fixed red-first with `--no-warnings` in the registered commands (`183c83d`); re-run PASS: 7/7 events, spool 0, the product's dashboard reader showed the thread `ended`/`completed` and the project `fresh`.
- Cleanup (owner-approved): one cascading delete of the ephemeral workspace; before 1 workspace / 2 projects / 2 tokens / 5 514 events, after 0/0/0/0; scratch token files removed. Purge job's first run: "inconclusive", conclusive check scheduled for a date (`SPRINT-05a.md` Log).
- Release checklist with evidence per item: `docs/how-to/release-checklist.md`. Guru G4 finding: it uses statuses outside its own vocabulary (DEFERRED, IN PROGRESS, OPEN), and two PASS items were measured on the development database that production still reads, without a written exception — the reason for §7's last two rules.
- Deviation: the ADR named the new production database; the owner kept production on the old one, so the runs used the database production actually reads. The ADR has no *Changes* entry for this (G4 finding).
