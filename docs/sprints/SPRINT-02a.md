# Sprint 02a — Data layer & health

- Dates: planned 2026-10-20; run 2026-10-22 (timebox 30 min) · Status: **CLOSED** 2026-10-22 (all 8 tasks done; follow-up Q5 for the owner)
- Goal: persist workspaces, projects and hashed ingest tokens in Neon through Drizzle, and expose an honest `/api/health` that shows which env vars are present (booleans only) and whether the database answers.
- Modules touched: JD-M06 (new package), JD-M04, JD-APP
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` rows **Database** (AVAILABLE) and **Data** (planned here). Sign-in (Better Auth, JD-M03) is **Sprint 2b** and is not a gate for 2a.
- Test plan: `docs/agent-ops/TEST_PLAN.md` (refreshed for S2a)
- Decisions: ADR-0005 (Accepted 2026-10-22) — `docs/adr/0005-data-layer-and-ingest-tokens.md`

## Global constraints

- Stack pins per ADR-0002: `drizzle-orm` 0.45.x, `drizzle-kit` 0.31.x, `@neondatabase/serverless` 1.2.x (latest on npm 2026-10-20: 0.45.4 / 0.31.11 / 1.2.0).
- Migrations run **only** against the Neon `dev-agent` branch in this sprint, by an explicit command — never at build or deploy time.
- No plaintext ingest token is ever stored, logged or returned after creation.
- Every repository read/write is scoped by `workspaceId`; no unscoped list or get exists.
- `/api/health` returns booleans and status words only — never values, hosts, error messages or stack traces.
- Product rule 2: health shows its own `checkedAt`; nothing it reports is labelled "live".
- Sandbox only: Node network calls need `NODE_USE_ENV_PROXY=1`; raw TCP to Postgres (psql, port 5432) times out, so use the Neon HTTP driver.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 1 | Scaffold `packages/event-store` | JD-M06 | — → `createDb(url)`, `pingDb(db)`, `schema`, `migrate` script | `module.json` (status in-progress, consumes JD-M04); public `src/index.ts`; `drizzle.config.ts`; registry regenerated | Done |
| 2 | JD-M04 tables | JD-M04 | `drizzle-orm/pg-core` → `workspaces`, `projects`, `ingestTokens` tables exported from the public index | Columns per ADR-0005 §Data model; FKs `ON DELETE CASCADE`; unique `(workspace_id, slug)`; unique `token_hash`; `privacy_class` default `L0`; `last_signal_at` nullable and never written by the repository | Done |
| 3 | Ingest token primitives | JD-M04 | WebCrypto → `generateIngestToken()`, `hashIngestToken()`, `parseIngestToken()` | Format `jd_it_` + 43 base64url chars (32 random bytes); SHA-256 hex stored; display prefix = first 8 chars of the secret part; malformed input rejected before any DB call | Done |
| 4 | Project repository | JD-M04 | `db` handle (injected) → `createProjectRepository(db)` with `createWorkspace`, `createProject`, `listProjects(workspaceId)`, `getProject(workspaceId, id)`, `issueToken`, `revokeToken`, `verifyToken` | Input validated with existing `normalizeProjectInput`; slug collision → typed `slug_taken` error; `issueToken` returns plaintext once; `verifyToken` returns `{ workspaceId, projectId, tokenId }` or `null` for unknown/revoked/malformed; max 5 active tokens per project | Done |
| 5 | Generate and apply migration `0000` | JD-M06 | Task 2 tables → `packages/event-store/migrations/0000_*.sql` | `drizzle-kit generate` output committed; applied to `dev-agent` with `pnpm --filter @javis-dog/event-store db:migrate` (neon-http migrator); verified by listing tables + `__drizzle_migrations` row; down SQL committed for manual rollback | Done |
| 6 | `/api/health` route | JD-APP | JD-M06 `pingDb` → `GET /api/health` | `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `Cache-Control: no-store`; body `{ status, checkedAt, deployment: { env, commit }, env: { NAME: boolean… }, db: { status: 'ok' \| 'error' \| 'not_configured', latencyMs, migration } }`; DB ping times out after 3 s; HTTP 200 when DB ok, 503 otherwise | Done |
| 7 | Docs + contract | all | — | ADR-0005 accepted or amended; JD-M04 README + `module.json` updated; changeset for JD-M04 public contract; `docs/how-to/run-database-migrations.md`; `pnpm docs:check` green | Done |
| 8 | Verify on Vercel | JD-APP | deployed preview/production | After push, `GET https://javisdog.vercel.app/api/health` reports which env vars exist on Vercel — closes the "Vercel env unverifiable" gap | Done |

### Order and dependencies

1 → 2 → 3 → 4 (tests on PGlite) → 5 (dev-agent) → 6 → 7 → push → 8. Tasks 3 and 6 can start in parallel with 2.

### Out of scope (moved on purpose)

- Users, sessions, memberships, sign-in → **S2b** (Better Auth GitHub/Google, JD-M03). `workspaces` is shaped so Better Auth's organization plugin can map onto it (ADR-0005; to be verified in S2b).
- JGR `events` table, rollups, retention → **S3** with JD-M05 (needs a partition/retention decision).
- Project CRUD UI → S2b (needs an authenticated user). The Projects space keeps its honest "not connected" state.
- JD-M09 welcome email → S2b.

## Owner decisions (answered 2026-10-20: "go with the recommendations" → Q1 A, Q2 A, Q3 A, Q4 A)

| ID | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | How do repository tests get a real Postgres? | **A)** `@electric-sql/pglite` dev dependency: in-process Postgres 17, runs the real migration SQL, offline, CI-friendly · **B)** throwaway Neon branch per run (needs a `NEON_API_KEY` — MISSING) · **C)** run against `dev-agent` with per-run cleanup (slow, needs network in CI, risks shared state) | **A**, plus one manual smoke script against `dev-agent` (not part of `pnpm test`) |
| Q2 | Should `/api/health` be public? | **A)** public, booleans only · **B)** require a `HEALTH_TOKEN` header (new secret) · **C)** public minimal `{status}` + detailed view after sign-in in S2b | **A** — env-name booleans reveal little, and the agent needs it to see Vercel config (env listing is 403) |
| Q3 | Which Neon branch does Vercel use? | **A)** Preview → `dev-agent`, Production → not set until S5 (health shows `not_configured`) · **B)** both on `dev-agent` for now · **C)** create a `main`/production branch now and migrate it too (production change) | **A** — no production data before the release gate |
| Q4 | JGR `events` table now or in S3? | **A)** S3 with JD-M05 · **B)** now, from the v0.1 envelope | **A** — retention/partitioning is a separate decision |

## Review focus

- A token string from another product (or a JGR token pasted with whitespace) reaches `verifyToken` → rejected by `parseIngestToken` without a DB query; test in task 3.
- Two projects with the same slug in different workspaces → both allowed; same workspace → `slug_taken`; test in task 4.
- Workspace B asks for workspace A's project id → `null`, not the project; test in task 4.
- A revoked token is presented → `null`; revoking twice is idempotent; test in task 4.
- `DATABASE_URL` absent on Vercel → health returns 503 with `db.status = "not_configured"`, never a crash or a leaked message; test in task 6.
- DB hangs → health answers within ~3 s with `db.status = "error"`; test in task 6 (fake ping).

## Log

- 2026-10-22 — Production `/api/health` (Vercel deploy of `dc6ef61`): HTTP 503, `db.status = not_configured`; on Vercel Production `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` are **not set**; the other 6 are set. CI run 18 green. Finding: Vercel deploys this branch as **Production** (no Preview deployments exist), so Q3's "Preview → dev-agent" has no environment to apply to → Q5.
- 2026-10-22 — Workspace gate green; local `next start` + `GET /api/health` against `dev-agent` → 200, all 9 env booleans true, `db.status = ok`, 1 migration.
- 2026-10-22 — Migration `0000` applied to `dev-agent` via the neon-http migrator; `db:smoke` 7/7 PASS (round trip cleaned up).
- 2026-10-22 — Smoke run 1 failed: Node type stripping rejects constructor parameter properties → rewrote `ProjectRepositoryError`, enabled `erasableSyntaxOnly` workspace-wide.
- 2026-10-22 — PGlite tests found `pingDb` failing on an unmigrated DB (relation resolved at plan time inside `CASE`) → split into two statements. First PGlite cold start > 5 s → package timeout 30 s (not a retry).
- 2026-10-22 — Review of generated SQL: tokens could reference a project in another workspace → composite FK `ingest_tokens(project_id, workspace_id) → projects(id, workspace_id)`.
- 2026-10-20 — Owner: Q1–Q4 as recommended. Sprint planned after env/Neon/OAuth re-check (see `READINESS_MATRIX.md`).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm --filter @javis-dog/projects test` | 0 | < 1 s | 27 | 0 | 0 | 0 | 0 | — |
| `pnpm --filter @javis-dog/event-store test` (PGlite) | 0 | 8 s | 14 | 0 | 0 | 0 | 0 | — |
| `pnpm --filter @javis-dog/web test` | 0 | — | 42 | 0 | 0 | 0 | 0 | — |
| `pnpm format:check` / `lint` / `typecheck` | 0 | 1 / 6 / 6 s | all | 0 | 0 | 0 | 0 | — |
| `pnpm test` (workspace) | 0 | 11 s | 145 | 0 | 0 | 0 | 0 | — |
| `pnpm build` | 0 | 22 s | — | — | — | — | — | `/api/health` dynamic (ƒ) |
| `db:generate` drift check | 0 | — | no changes | — | — | — | — | — |
| `db:migrate` on `dev-agent` | 0 | — | applied | — | — | — | — | — |
| `db:smoke` on `dev-agent` | 0 | — | 7 | 0 | 0 | 0 | 0 | first run exit 1 (syntax, fixed) |
| local `next start` + `curl /api/health` (dev-agent) | 0 | — | 200, `no-store` | — | — | — | — | — |
| `GET https://javisdog.vercel.app/api/health` (production, `dc6ef61`) | 0 | — | 503 `degraded`, `no-store` — as designed | — | — | — | — | `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` = false; other 6 = true |
| GitHub Actions CI run 18 (`dc6ef61`, incl. migration drift step) | 0 | — | success | 0 | — | — | — | — |

Screenshots: 0.

## Decisions and deviations

- ADR-0005 accepted with implementation changes (composite tenancy FK, integration tests in JD-M06, `erasableSyntaxOnly`); see its *Changes* section.
- New dev dependency `@electric-sql/pglite` 0.5.8 (Q1; newest release older than two weeks).
- `workspaces` is owned by JD-M04 in 2a (owner brief for S2a); the registry lists workspaces under JD-M03. JD-M03 will consume the JD-M04 table in S2b instead of defining its own. Recorded in ADR-0005.

## Owner follow-up (Q5) — answered 2026-10-22: **A** (Production → `dev-agent` until S5)

Vercel builds `claude/clever-goldberg-wlurty` as **Production**, so there is no Preview environment for `dev-agent`. Options: **A)** set Production `DATABASE_URL` → `dev-agent` until S5 (fastest; the public site then reads dev data — still only test rows); **B)** keep Production without a DB (503) until S5 and test the DB only locally; **C)** make `main` the Vercel production branch so this branch builds as Preview → `dev-agent` per Q3 (cleanest; needs a `main` branch and a dashboard change). Recommendation: **C**, or A as a stop-gap. S2b sign-in also needs `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` on whichever Vercel environment is used, and OAuth callback URLs for its domain.

## Retro

- Went well: tests caught three real defects before push (cross-workspace token FK, `pingDb` on an unmigrated DB, non-erasable TS syntax); the health route immediately answered the long-standing "what is set on Vercel" question.
- Hurt: the session worker restarted mid-sprint (work on disk survived); PGlite's cold start needed a longer timeout.
- Change next sprint: settle Q5 before S2b so sign-in can be tested on a real deployment.

## Guru checkpoint

Not due at planning; G-checkpoint after S2b (feature completion).
