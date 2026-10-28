# Sprint 03d — Ingest hardening + reconciliation ports

- Dates: 2026-10-28 (timebox 30 min) · Status: **CLOSED** 2026-10-28 (CI green on `1bb95e9`)
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

- 2026-10-28 — Reviewer — no blockers; 2 major (TEST_PLAN §S3d missing, spec silent on canonical ids), 11 minor, 4 nits; re-ran 379 tests at `3273725`. Majors and most minors fixed (see Decisions).
- 2026-10-28 — Orchestrator — Conformance runner `packages/ingest/test/conformance.test.ts` written from the QA README runner rules; all 43 vectors PASS. Mutation check: handler answering 400 instead of 415 → exactly vectors 32–34 FAIL (runner detects regressions); handler restored.
- 2026-10-28 — QA — 43 vectors from ADR-0008 (incl. Changes), independent of the implementation; 20 ambiguities listed in the README (A1–A20).
- 2026-10-28 — Orchestrator — Merged Developer lane (`048dad1`, declared paths only); combined tree green: 334 tests, build, drift clean. Pre-check dev-agent: 0 events, 0 non-canonical ids → migration 0003 safe.
- 2026-10-28 — Developer — H2/H3/H4 done; typecheck/e2e failures depended only on the orchestrator's new store signatures (resolved at merge).
- 2026-10-28 — Orchestrator — Shorthand fixture ids (`'e1'`, `'old'`, `'same'`) replaced with valid ULIDs: the new check constraint refuses them (fixture change, assertions unchanged).
- 2026-10-28 — Orchestrator — `git fetch` before planning: origin at `5cc8ac0`, no new commits. Screenshot budget 0. Sprint start.

## Log

- 2026-10-28 — CI **PASS** on `1bb95e9` (run 40612946751); production `/api/health` ok on `1bb95e9`. Sprint closed.
- 2026-10-28 — CI **FAIL** on `98c7974` (run 40612408695): `collectors/claude-code` `test/process.test.ts` › "detached flusher delivers" — `lastFlush` was `null`. Diagnosed, not re-run: the same assertion also failed on the owner's `fe604d1` (run 39875014031) and passed on `5cc8ac0` with no collector change in between, so it predates S3d. Root cause: an ordering race in the test — the fake receiver records the batch before it answers 202, and the flusher writes `last-flush/<project>.json` only after reading that answer; the test read the file as soon as the batch was recorded. Reproduced deterministically (receiver answers 500 ms late → same `expected null` failure); fix: wait for the flusher's result, then the unchanged `status: 'ok'` assertion; the receiver keeps a 200 ms late answer so the race stays covered. Product code unchanged.
- 2026-10-28 — Pushed `98c7974`; production READY; migration 0003 on dev-agent; production smoke 7/7.
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
| Final gate after review fixes: `format:check` / `lint` / `typecheck` / `test` / `build` / `docs:check` / drift | 0 | 3 / 4 / 12 / 19 / 10 / 2 s | 383 tests | 0 | 0 | 0 | 0 | event-store 47, ingest 73, jgr-sdk 31, web 92, jgr-spec 32, projects 27, collector 31, ui 33, identity 13, notify 4 |
| Push `98c7974` → Vercel production READY (`/api/health`) | 0 | 30 s | ok, 3 migrations | — | — | — | — | before 0003 |
| Pre-check re-run 2026-10-28T01:01Z, `db:migrate` (0003) on dev-agent | 0 | — | 0 non-canonical / 0; applied | — | — | — | — | — |
| `db:smoke` (dev-agent) | 0 | — | 10 | 0 | 0 | 0 | 0 | 4 migrations, 11 tables |
| `pnpm --filter @javis-dog/ingest smoke:live` (production) | 0 | — | 7 | 0 | 0 | 0 | 0 | ephemeral workspace, cleaned up |
| Production `/api/health` after 0003 | 0 | — | ok, 4 migrations | — | — | — | — | — |
| GitHub Actions CI on `98c7974` | 1 | 82 s | 9 packages | 1 (collector `process.test.ts`) | 0 | 0 | 0 | run 40612408695; pre-existing race, see Log |
| Repro: receiver answers 500 ms late, old test | 1 | 1 s | 1 | 1 | 0 | 0 | 0 | same `expected null` failure as CI |
| GitHub Actions CI on `1bb95e9` | 0 | — | all jobs | 0 | 0 | 0 | 0 | run 40612946751 |
| Fixed test, 3 runs; then full gate `format:check` / `lint` / `typecheck` / `test` / `build` / `docs:check` | 0 | — | 383 tests | 0 | 0 | 0 | 0 | collector 31 |

## Decisions and deviations

- TEST_PLAN §S3d written after implementation (Reviewer major 1) — logged as a deviation there.
- Reviewer minors fixed: `last_signal_at` capped by the DB clock (m3); Retry-After from the DB clock (m4); purge `maxDuration = 60` (m6); event-store `consumes` JD-M01 + registry (m8); tenant-rule rejections echo the producer's id spelling (m9); 0003 rollback/refusal tests (m10); ordinal sort; ADR-0009 Changes (m2); spec §3/§9 canonical ids (major 2).
- Not changed, documented: strict `Content-Encoding` parsing (m5 — lists/`x-gzip` → 415, matches the vectors); overlapping purges may report `complete` early (m7); 415 body is `{ error, message }` without `issues` (m11).

## Retro

- Went well: three lanes in parallel with declared paths merged without conflicts; the QA oracle plus a mutation check proved the runner catches regressions; the Reviewer found two real clock bugs (m3, m4) the audit missed.
- Hurt: the 2026-10-27 parallel-session incident cost a full sprint of duplicate work; TEST_PLAN §S3d was written late; a red CI on the owner's `fe604d1` was not noticed at reconciliation, so S3d inherited it.
- Change next sprint: `git fetch` before planning (now a TEAM rule); write the TEST_PLAN section before launching lanes; check CI history of the baseline, not only the latest run.

## Guru checkpoint

G2 at S3e close.
