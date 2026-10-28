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
| H1 | Canonical event ids | JD-M01, JD-M06 | → `canonicalEventId()`; migration 0003 check | `01jbz…` and `01JBZ…` are one event; DB rejects non-canonical ids; strict UUID shape | Planned |
| H2 | Signal survives a failed bookkeeping write | JD-M05, JD-M06, JD-M04 | handler → `touchSignal`, `markTokenUsed` | Signal/last-used written when ≥ 1 valid event (accepted **or** duplicate); `last_signal_at` forward-only; `last_used_at` ≤ 1×/min | Planned |
| H3 | Bounded retention purge | JD-M06, JD-APP | `purgeEventsBefore(cutoff, now, opts) → { deleted, batches, complete }` | Batches of 5 000, ~20 s budget; route answers 401 before revealing `not_configured` | Planned |
| H4 | 415 for media type / encoding; SDK keeps the spool | JD-M05, JD-M02, JD-M01 | handler/body → 415; SDK `kind: 'unsupported'` | 415 responses; SDK pauses (spool kept) on 415; > 100 events → 413 `too_large` | Planned |
| H5 | Deadlock-free concurrent inserts | JD-M06 | — | Rows sorted by (`producer_id`, `event_id`) before insert | Planned |
| H6 | Rate window from the DB clock | JD-M06 | `hitRateWindow(tokenId)` | Window = `date_trunc('minute', now())`; skewed instances share one window | Planned |
| P1 | Ports: TEAM.md, template Team section, worktree ignores, migration-recovery how-to | docs | — | `docs:check` green | Done |
| P2 | HTTP conformance vectors re-derived from the owner's ADR-0008 + runner | docs, JD-M05 | vectors → `packages/ingest/test/conformance.test.ts` | All vectors PASS against the real handler on PGlite | Planned |

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

- 2026-10-28 — Orchestrator — `git fetch` before planning: origin at `5cc8ac0`, no new commits. Screenshot budget 0. Sprint start.

## Log

- 2026-10-28 — Ports P1 done.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm test` (baseline `5cc8ac0`, after clearing a stale shared Vitest cache) | 0 | — | 313 | 0 | 0 | 0 | 0 | first run failed with `ENOTEMPTY node_modules/.vitest-cache` (stale cache from the superseded run) |

## Decisions and deviations

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

G2 at S3e close.
