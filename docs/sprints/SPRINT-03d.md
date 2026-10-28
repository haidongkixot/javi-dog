# Sprint 03d — Ingest hardening + reconciliation ports

- Dates: 2026-10-28 (timebox 30 min) · Status: **ACTIVE**
- Goal: fix the five major audit findings on the S3a–S3c ingest path before OTLP work, and port the useful pieces of the superseded parallel S3a line.
- Modules touched: JD-M01, JD-M05, JD-M06, JD-M02, JD-APP, docs
- Readiness gate: owner line `5cc8ac0` green here (313 tests); dev-agent at 3 migrations
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S3d
- Context: on 2026-10-27 a second session built a conflicting S3a in parallel; owner chose reconciliation **A** (owner line is the baseline; superseded work on local branch `backup/s3a-parallel`). Owner decisions 2026-10-28: this cloud session is the only pusher; fix H1–H6 first; OTLP is received locally in the collector (S3e).

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| H1 | Canonical event ids | JD-M01, JD-M06 | → `canonicalEventId()`; migration 0003 check | `01jbz…` and `01JBZ…` are one event; DB rejects non-canonical ids; strict UUID shape | Done |
| H2 | Signal survives a failed bookkeeping write | JD-M05, JD-M06, JD-M04 | handler → `touchSignal`, `markTokenUsed` | Signal/last-used written when ≥ 1 valid event (accepted **or** duplicate); `last_signal_at` forward-only; `last_used_at` ≤ 1×/min | Done |
| H3 | Bounded retention purge | JD-M06, JD-APP | `purgeEventsBefore(cutoff, now, opts) → { deleted, batches, complete }` | Batches of 5 000, ~20 s budget; route answers 401 before revealing `not_configured` | Done |
| H4 | 415 for media type / encoding; SDK keeps the spool | JD-M05, JD-M02, JD-M01 | handler/body → 415; SDK `kind: 'unsupported'` | 415 responses; SDK pauses (spool kept) on 415; > 100 events → 413 `too_large` | Done |
| H5 | Deadlock-free concurrent inserts | JD-M06 | — | Rows sorted by (`producer_id`, `event_id`) before insert | Done |
| H6 | Rate window from the DB clock | JD-M06 | `hitRateWindow(tokenId)` | Window = `date_trunc('minute', now())`; skewed instances share one window | Done |
| P1 | Ports: TEAM.md, template Team section, worktree ignores, migration-recovery how-to | docs | — | `docs:check` green | Done |
| P2 | HTTP conformance vectors re-derived from the owner's ADR-0008 + runner | docs, JD-M05 | vectors → `packages/ingest/test/conformance.test.ts` | All vectors PASS against the real handler on PGlite | Done |

## Review focus

- Producer retries `01jbz…` after `01JBZ…` → `duplicates: 1`, one row (H1).
- Insert succeeds, signal update times out, client retries → retry is all duplicates but `last_signal_at` is set (H2).
- 2 M expired rows → purge returns `complete: false` within budget; next run continues (H3).
- A proxy rewrites `Content-Type` → 415, SDK keeps events (H4).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | H1, H3 (store), H5, H6, H2 (store/repo side), migration 0003, docs |
| Developer | general-purpose, worktree | H2 (handler), H3 (route), H4: `packages/ingest/**`, `packages/jgr-sdk/**`, `apps/web/src/lib/purge.ts`, `apps/web/test/purge.test.ts` |
| QA | general-purpose, worktree | P2 vectors: `docs/jgr/conformance/http/**` |
| Reviewer | general-purpose, read-only | combined diff + evidence |

Team log, newest first:

- 2026-10-28 — Orchestrator — Conformance runner `packages/ingest/test/conformance.test.ts` written from the QA README runner rules; all 43 vectors PASS. Mutation check: handler answering 400 instead of 415 → exactly vectors 32–34 FAIL (runner detects regressions); handler restored.
- 2026-10-28 — QA — 43 vectors from ADR-0008 (incl. Changes), independent of the implementation; 20 ambiguities listed in the README (A1–A20).
- 2026-10-28 — Orchestrator — Merged Developer lane (`048dad1`, declared paths only); combined tree green: 334 tests, build, drift clean. Pre-check dev-agent: 0 events, 0 non-canonical ids → migration 0003 safe.
- 2026-10-28 — Developer — H2/H3/H4 done; typecheck/e2e failures depended only on the orchestrator's new store signatures (resolved at merge).
- 2026-10-28 — Orchestrator — Shorthand fixture ids (`'e1'`, `'old'`, `'same'`) replaced with valid ULIDs: the new check constraint refuses them (fixture change, assertions unchanged).
- 2026-10-28 — Orchestrator — `git fetch` before planning: origin at `5cc8ac0`, no new commits. Screenshot budget 0. Sprint start.

## Log

- 2026-10-28 — H1–H6 + P2 done locally; Reviewer running.
- 2026-10-28 — Ports P1 done.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm test` (baseline `5cc8ac0`, after clearing a stale shared Vitest cache) | 0 | — | 313 | 0 | 0 | 0 | 0 | first run failed with `ENOTEMPTY node_modules/.vitest-cache` (stale cache from the superseded run) |
| `pnpm format:check` / `lint` / `typecheck` / `build` / `docs:check` (merged tree) | 0 | 3 / 8 / 16 / 33 / 2 s | all | 0 | 0 | 0 | 0 | — |
| `pnpm test` (merged tree) | 0 | 19 s | 334 | 0 | 0 | 0 | 0 | event-store 44, ingest 27, jgr-sdk 31, web 92, jgr-spec 32, projects 27, collector 31, ui 33, identity 13, notify 4 |
| `db:generate` drift | 0 | — | no changes | — | — | — | — | — |
| `vitest run test/conformance.test.ts` (ingest) | 0 | — | 45 | 0 | 0 | 0 | 0 | 43 vectors + count + equivalence group |
| Mutation: 415 → 400 in handler | 1 | — | 42 | 3 | 0 | 0 | 0 | vectors 32–34 FAIL as expected; restored |
| dev-agent pre-check for 0003 | 0 | — | 0 non-canonical / 0 events | — | — | — | — | read-only |

## Decisions and deviations

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

G2 at S3e close.
