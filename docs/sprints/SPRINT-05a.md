# Sprint 05a — Production readiness (separate production database, rollback, runbooks, load and access checks)

- Dates: 2026-10-28 (timebox 30 min, parallel lanes) · Status: **CLOSED** 2026-10-30 (R2 cutover deferred by owner; R6/R7 run on `dev-agent`)
- Goal: production runs on its own database with a written rollback plan and runbooks. Ingest latency and payload limits are measured on production, and every route and action is checked for access boundaries, so the S5 release gate can be judged on evidence.
- Modules touched: JD-M06 (migration tooling), JD-M05 (load script), JD-C01 (end-to-end script), JD-APP (access tests), docs
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` rows "Production database (`main`)", "Vercel env write", "Accepted risk: no secret rotation", "Ops: retention purge"
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5a
- ADR: `docs/adr/0015-production-database-cutover-and-release-readiness.md`

## Global constraints

- Owner decisions 2026-10-28: "Release-first", "New production branch", "Accept risk, no rotation"; paid plans not decided (free tiers).
- No connection string, token or password is printed, logged or committed; the agent reads row **counts** on production, never rows with personal data.
- Neon MCP rule: no destructive SQL without asking the owner first (applies to load-test cleanup).
- Load-test budget (ADR-0015): ≤ 70 requests in ≤ 2 min, ≤ 6 000 events, one ephemeral workspace; screenshot budget 0.
- No new external package; no product behaviour change in this sprint (scripts, tests and docs only).

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| R1 | Migrate `main` | JD-M06 | committed migrations → `db:statements` (drizzle `readMigrationFiles`) → Neon MCP, one transaction per migration | 6 rows in `drizzle.__drizzle_migrations` with the same hashes and `created_at` as `dev-agent`; schema diff vs `dev-agent` empty; 13 public tables | Done |
| R2 | Cutover (owner) | JD-APP | Vercel Production `DATABASE_URL` → `main` pooled URL; redeploy | `/api/health` ok, 6 migrations; `users` count on `main` > 0 after the owner signs in | Waiting on owner |
| R3 | Rollback plan | docs | — → `docs/how-to/roll-back-a-release.md` | App, schema, data (6 h PITR), env paths with limits and commands | Done |
| R4 | Runbooks | docs | — → `docs/how-to/operate-production.md` | Symptom → check → action → escalation for ingest, sign-in, email, purge/`CRON_SECRET`, migrations, secrets, Neon limits | Done |
| R5 | Access-boundary suite | JD-APP | ADR-0005/0006/0008/0012/0014 text → `apps/web/test/access-boundaries.test.ts(x)` | Every route handler and server action: signed out, foreign workspace, foreign project id, wrong role, bad bearer / cron secret → refused without leaking existence or data | Done (52 tests) |
| R6 | Bounded load test | JD-M05 | token file + endpoint → `packages/ingest/scripts/load-test.ts` → JSON summary | Hard caps enforced in code; p50/p95/max, status counts; payload builder near 256 KB decompressed; unit-tested against a local server | Built (production run waits on R2) |
| R7 | End-to-end telemetry smoke | JD-C01 | packed tarball + token file + endpoint → `collectors/claude-code/scripts/e2e-smoke.mjs` | Temp home; `init` → hook events → `flush` → spool empty, exit 0; tested against a local recording server | Built (production run waits on R2) |
| R8 | Security review | all | read-only | Findings fixed or logged before the release gate | Review done; M1/M2/L1/L3/L4/I2 fixed red-first; L2/L5 logged |
| R9 | Release checklist + readiness | docs | — → `docs/how-to/release-checklist.md`, readiness rows | Gate items with evidence links; accepted risk recorded | Done |

## Owner steps (R2 cutover)

1. Optional, recommended in the readiness row "Accepted risk": in the Neon console, open project `neon-javisdog` → Branches → `main` → Roles → `neondb_owner` → **Reset password**. This changes only `main`, and `dev-agent` keeps working.
2. In the Neon console, open `main` → **Connect**, choose the pooled connection, and copy the URL. Do not paste it into chat.
3. In Vercel, open Project `javisdog` → Settings → Environment Variables → `DATABASE_URL`, then **Edit** the **Production** value only and paste the URL.
4. Go to Deployments → the latest production deployment → **Redeploy**.
5. Sign in at `https://javisdog.vercel.app/sign-in`. You get a new personal workspace, because nothing carries over from `dev-agent`.
6. Tell the orchestrator "cutover done". It checks `/api/health` and the `users` count on `main`, then runs the bounded load test and the end-to-end smoke (R6/R7). Cleaning up the ephemeral workspace afterwards needs your OK.

## Review focus

- A signed-in user of workspace A passes workspace B's project id to a page, route or action → not found, nothing of B in the response (R5).
- The load test runs twice by mistake, or the caps are bypassed by flags → the script refuses to exceed the caps in one run (R6).
- Cutover half-done (env changed, deployment not rebuilt) → health still reports `dev-agent`'s counts; the verification uses the `users` count on `main`, not health alone (R2).
- The ephemeral load-test workspace is left on production → cleanup is listed in the sprint log with its counts (R6, owner OK).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | R1, R2 verification, R3, R4, R9, merges, Neon MCP, pushes |
| QA | general-purpose, worktree | R5: `apps/web/test/access-boundaries.test.ts(x)` only |
| Developer | general-purpose, worktree | R6, R7: `packages/ingest/scripts/load-test.ts`, `packages/ingest/test/load-test.test.ts`, `collectors/claude-code/scripts/e2e-smoke.mjs`, `collectors/claude-code/test/e2e-smoke.test.ts` |
| Reviewer | general-purpose, read-only | R8 |

Team log, newest first:

- 2026-10-28 — Orchestrator — Merged Developer B (`7a7673a`). Wrote the ADR-0005/0006/0008 Changes and the README updates. Fixed two more stale statuses on the integrations page: Claude Code now "Available · javi CLI (beta)", GitHub now "Planned · Sprint 6".
  - **Test oversubscription (diagnosed, not retried).** `jgr-sdk` `e2e.test.ts` timed out at 30 s in two forced full runs after the merges.
  - It takes 4.1 s alone, and already took 25.6 s at base `4daa69c` under turbo's default concurrency of 10 on 4 CPUs.
  - Cause: about 13 vitest processes, each with PGlite WASM workers, on 4 cores. The new suites added enough load to cross 30 s.
  - Fix: the root `test` script runs `turbo run test --concurrency=2`. Wall time went from 126 s to 139 s, and the SDK e2e test from 24.7 s to 3.3 s. No timeout was raised and no test was skipped.
- 2026-10-28 — Developer B — Six fixes, each red first.
  - M2: organization plugin options plus `disabledPaths` for every plugin path (404), including path variants. First sign-in still creates one owner workspace.
  - L1: `canManageProject` gates project creation and token issue/revoke to owners and admins, with matching UI and a 17-test role matrix.
  - L3: `MAX_JSON_DEPTH` 32 means the real 240 KB nested payload now gets 400 instead of 503.
  - L4: security headers, checked on a running `next start`.
  - I2: truthful copy on the integrations page.
  - M1: 20 projects per workspace and 10 tokens issued per 24 h, enforced in the repository.
  - 1156 tests in the lane.

- 2026-10-28 — Orchestrator — Merged R5 (QA, `f414cba`) and R6/R7 (Developer, `9644308`).
  - The QA tests had imported PGlite and drizzle through `packages/event-store/node_modules/...`. They now use package names: `@electric-sql/pglite` 0.5.8 and `drizzle-orm` 0.45.4 are `apps/web` devDependencies. The lockfile resolves the same variant, so no new package was downloaded. 52/52 pass.
  - ADR-0015 corrected: the 256 KB limit applies **after decompression** (ADR-0008, `body.ts`), so a ~240 KB gzip batch would be refused. Near-limit batches are about 255 KiB decompressed, about 177 KB gzip.
- 2026-10-28 — Owner — M1 quotas: "Caps, no migration". At most 20 projects per workspace and at most 10 tokens issued per project per 24 h (revoked tokens count); 60 batches/min per token unchanged. Added to Developer B's scope.
- 2026-10-28 — Developer — R6/R7 built.
  - Caps are frozen in code: 70 requests, 6 000 events, 120 s, concurrency 5, 50 starts per rolling minute. The run stops on a 401 or on 3 consecutive failures.
  - Payload limit: about 177 KB gzip is the most a valid 255 KiB batch can reach.
  - The e2e test passes the token on stdin and plants prompt, tool and path sentinels; a privacy scan checks them.
  - Test counts: ingest 98/98, collector 300/300. Local runs PASS: 55 × 202 in 60.2 s; e2e 7/7 events delivered, spool 0.
- 2026-10-28 — QA — R5: 52 tests, all PASS, no findings. They cover two seeded workspaces with positive controls; every route, action, loader and page; foreign id ≡ unknown id; the ingest 401 variants are byte-identical; cron auth comes before `not_configured`. Six spec-silent decisions are listed in the test comments.

- 2026-10-28 — Orchestrator — Review triage. M2, L1, L3, L4 and I2 go to Developer B (red-first). M1 (quotas) goes to the owner, because it sets limits on product use. L2 (Vercel Firewall rate rules) and L5 (Better Auth rate limit is in memory per instance, so the ADR-0006 wording is best-effort) are logged and need owner or dashboard action or an ADR note. I1 is `CRON_SECRET`.
- 2026-10-28 — Reviewer — Security review of the whole surface (read-only plus one PGlite probe): **0 critical, 0 high**, 2 medium, 5 low, 4 info.
  - M1: one free sign-up can fill the 512 MiB branch. Rate limits are per token only, the token cap ignores revoked tokens, and there is no project or workspace cap.
  - M2: the Better Auth organization plugin runs with defaults, so the organization create, invite, role, update and delete endpoints are live over HTTP (create verified 200). ADR-0006 says one personal workspace only.
  - L1: the token and project actions have no role check. Budgets do.
  - L2: unauthenticated database hits have no IP rate limit.
  - L3: deeply nested JSON returns 503 instead of 400.
  - L4: no security headers.
  - L5: the auth rate limit is held in memory per instance.
  - I1: the purge is inactive.
  - I2: the integrations page still says "not live".
  - I3–I4: minor.
  - Verified safe: ingest order, token storage, cron auth, parameterised SQL, workspace scoping in every reader and action, open-redirect checks, cookies, log redaction, email, SSRF, caching, the collector receiver.

- 2026-10-28 — Orchestrator — R1 done: `main` was empty (no `public` tables, an unused `neon_auth` schema with 0 users); 6 migrations applied through the Neon MCP, one transaction each, statements from drizzle's `readMigrationFiles` (`db:statements`); ledger identical to `dev-agent` (6 hashes, same `created_at`), schema diff empty, 13 public tables, 0 users, 0 events. No connection string entered the session.
- 2026-10-28 — Orchestrator — Discovery: Neon `free_v3`, 6 h history retention, 512 MiB/branch, 0.25 CU, no snapshot schedule; `main` is the Vercel production branch (integration); Vercel env list/write still 403 → cutover is an owner step.

## Log

- 2026-10-29 — **R7 e2e re-run PASS** (after `183c83d`, `--no-warnings`).
  - Pack, install and init were verified. All 6 hooks exited 0 and were silent (163–210 ms).
  - 7/7 events delivered in 4 flushes; spool 0; privacy scan 0 hits (5 sentinels).
  - On `dev-agent`, which production reads: e2e project 14 events (two runs), load project 5 500.
  - The dashboard reader (`createDashboardReader.snapshot`) shows the smoke thread `cc_37c…` as `ended` / `completed`, and project `e2e-smoke` as `fresh`.
  - **Cleanup** (owner-approved): `delete from workspaces where id = 174d497f…` (cascade). Before: 1 workspace, 2 projects, 2 tokens, 5 514 events. After: 0 / 0 / 0 / 0. The scratch token files were removed.
  - **Purge first run:** Vercel runtime logs show only requests that wrote output, so a silent successful purge is not visible there. The database check is still inconclusive: no rate windows older than 19:00 remain, which is consistent with a run but not proof. A conclusive check is scheduled for 2026-10-30 20:20 UTC: the 2026-10-29 windows must be gone.
- 2026-10-29 — The owner keeps production on `dev-agent` for now, which defers R2/G2. The owner approved running R6/R7 against production with cleanup afterwards. Seeded one temporary workspace (`174d497f…`) with projects `load-test` and `e2e-smoke`; the tokens were in scratch files only, never printed.
  - **R6 load test PASS** (2026-10-29 19:52 UTC).
    - 55/55 requests returned 202; 5 500 events were sent and accepted, with 0 duplicates and 0 rejected; 60.8 s; no cap hit.
    - Client-side latency, including the sandbox proxy: p50 130 ms, **p95 1 529 ms** (target < 2 s), max 1 533 ms.
    - The slow tail is the first concurrent burst, plausibly cold starts.
    - Near-limit batches: 261 120 B raw / 177 200 B gzip, all 5 accepted, p95 756 ms.
  - **R7 e2e first run FAIL → product defect found.**
    - Delivery worked: 7/7 events recorded and delivered, spool 0, 0 content leaks.
    - But every hook wrote to stderr. Diagnosis: with `NODE_USE_ENV_PROXY=1`, which the sandbox needs and proxy users set, Node prints the `UNDICI-EHPA` experimental warning at startup, before javi runs. Reproduced directly: 177 B on stderr with the variable set, 0 B without it.
    - Gemini shows hook stderr, so this breaks hook silence for every proxy user.
    - Fix, red first (3 tests in `hook-silence.test.ts`): the registered hook commands (Claude Code exec args and the Gemini shell command) start Node with `--no-warnings`.
    - `e2e-smoke.mjs` now finds the javi path by its `.mjs` argument instead of `args[0]`.
    - Collector suite: 444/444.
- 2026-10-28 — `bbb3b6a` deployed.
  - `/api/health` is ok, but the DB is still `dev-agent` until cutover; it reports 6 migrations.
  - All 5 security headers are present on `/`, `/integrations`, `/sign-in` and `/api/health`.
  - Vercel adds HSTS (`max-age=63072000; includeSubDomains; preload`), which settles the reviewer's UNVERIFIED item.
  - `POST /api/auth/organization/create` returns 404.
  - CI run 40718637866: **PASS** (recorded by G4).
- 2026-10-28 — `4daa69c` (docs, ops): CI **PASS**, run 40713050537.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Neon MCP `run_sql_transaction` × 6 on `main` (0000–0005) | 0 | — | 6 | 0 | 0 | 0 | 0 | — |
| Neon MCP `compare_database_schema` `main` vs `dev-agent` | 0 | — | diff empty | 0 | 0 | 0 | 0 | — |
| Ledger + table count on `main` | 0 | — | 6 rows match, 13 tables | 0 | 0 | 0 | 0 | — |
| `vitest run test/access-boundaries*.test.ts(x)` (`apps/web`, after the import fix) | 0 | 7.9 s | 52 | 0 | 0 | 0 | 0 | — |
| `packages/ingest` vitest (Developer) | 0 | — | 98 | 0 | 0 | 0 | 0 | 20 in `load-test.test.ts` |
| `collectors/claude-code` vitest (Developer) | 0 | — | 300 | 0 | 0 | 0 | 0 | 5 in `e2e-smoke.test.ts` |
| Forced full gate after all merges (`format:check`, `lint`, `typecheck`, `test --force` at concurrency 2, `build`, `docs:check`, drift) | 0 | ~140 s tests | 1233 | 0 | 0 | 0 | 0 | — |
| Diagnosis: `test --force`, default concurrency 10, before the fix (2 runs) | 1 | 126 s+ | — | 1 each | — | — | — | `jgr-sdk` e2e timed out after 30 s; it takes 4.1 s alone |
| `db:smoke` on `main` | — | — | — | — | — | — | NOT RUN | writes rows on production; replaced by the schema diff + post-cutover end-to-end smoke |

## Decisions and deviations

- ADR-0015 (accepted): production database = Neon `main`; migrations via the Neon MCP; owner cutover; rollback, runbooks, bounded load test, access-boundary suite, accepted risk.
- Deviation from the "≤ 30 min" timebox is possible: three lanes run in parallel and the cutover waits on the owner.

## Retro

- Went well: the production e2e smoke found a real defect (hook stderr under `NODE_USE_ENV_PROXY`) that no local test could; a bounded, owner-approved load test with counted cleanup; the access-boundary suite (52) and pre-release security review closed with 0 critical/high.
- Hurt: the cutover depends on an owner action the agent cannot do (Vercel env 403) and is deferred; one push ran after `;` instead of `&&` (`8baec90`, re-verified harmless); a one-off seed script was staged by `git add -A` and caught by `format:check` before the push (`7bb5fdd` amended locally).
- Change next sprint: stage by explicit path for orchestrator commits; record each CI result in the sprint log within the same turn as the push.

## Guru checkpoint

G4 at the S5 release gate.
