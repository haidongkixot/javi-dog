# Sprint 05a — Production readiness (separate production database, rollback, runbooks, load and access checks)

- Dates: 2026-10-28 (timebox 30 min, parallel lanes) · Status: **ACTIVE**
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
| R3 | Rollback plan | docs | — → `docs/how-to/roll-back-a-release.md` | App, schema, data (6 h PITR), env paths with limits and commands | Planned |
| R4 | Runbooks | docs | — → `docs/how-to/operate-production.md` | Symptom → check → action → escalation for ingest, sign-in, email, purge/`CRON_SECRET`, migrations, secrets, Neon limits | Planned |
| R5 | Access-boundary suite | JD-APP | ADR-0005/0006/0008/0012/0014 text → `apps/web/test/access-boundaries.test.ts(x)` | Every route handler and server action: signed out, foreign workspace, foreign project id, wrong role, bad bearer / cron secret → refused without leaking existence or data | Planned (QA lane) |
| R6 | Bounded load test | JD-M05 | token file + endpoint → `packages/ingest/scripts/load-test.ts` → JSON summary | Hard caps enforced in code; p50/p95/max, status counts; payload builder near 256 KB gzip; unit-tested against a local server | Planned (Developer lane) |
| R7 | End-to-end telemetry smoke | JD-C01 | packed tarball + token file + endpoint → `collectors/claude-code/scripts/e2e-smoke.mjs` | Temp home; `init` → hook events → `flush` → spool empty, exit 0; tested against a local recording server | Planned (Developer lane) |
| R8 | Security review | all | read-only | Findings fixed or logged before the release gate | Planned (Reviewer) |
| R9 | Release checklist + readiness | docs | — → `docs/how-to/release-checklist.md`, readiness rows | Gate items with evidence links; accepted risk recorded | Planned |

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

- 2026-10-28 — Orchestrator — R1 done: `main` was empty (no `public` tables, an unused `neon_auth` schema with 0 users); 6 migrations applied through the Neon MCP, one transaction each, statements from drizzle's `readMigrationFiles` (`db:statements`); ledger identical to `dev-agent` (6 hashes, same `created_at`), schema diff empty, 13 public tables, 0 users, 0 events. No connection string entered the session.
- 2026-10-28 — Orchestrator — Discovery: Neon `free_v3`, 6 h history retention, 512 MiB/branch, 0.25 CU, no snapshot schedule; `main` is the Vercel production branch (integration); Vercel env list/write still 403 → cutover is an owner step.

## Log

- Placeholder — entries newest first.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Neon MCP `run_sql_transaction` × 6 on `main` (0000–0005) | 0 | — | 6 | 0 | 0 | 0 | 0 | — |
| Neon MCP `compare_database_schema` `main` vs `dev-agent` | 0 | — | diff empty | 0 | 0 | 0 | 0 | — |
| Ledger + table count on `main` | 0 | — | 6 rows match, 13 tables | 0 | 0 | 0 | 0 | — |
| `db:smoke` on `main` | — | — | — | — | — | — | NOT RUN | writes rows on production; replaced by the schema diff + post-cutover end-to-end smoke |

## Decisions and deviations

- ADR-0015 (accepted): production database = Neon `main`; migrations via the Neon MCP; owner cutover; rollback, runbooks, bounded load test, access-boundary suite, accepted risk.
- Deviation from the "≤ 30 min" timebox is possible: three lanes run in parallel and the cutover waits on the owner.

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

G4 at the S5 release gate.
