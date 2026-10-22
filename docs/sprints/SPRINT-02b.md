# Sprint 02b — Sign-in

- Dates: 2026-10-22 (timebox 30 min) · Status: **CLOSED** 2026-10-22 (all 7 tasks done)
- Goal: people can sign in with GitHub or Google on `javisdog.vercel.app`, get a personal workspace on first sign-in, and see their signed-in state in the shell.
- Modules touched: JD-M03 (new package), JD-M04, JD-M06, JD-APP
- Readiness gate: `READINESS_MATRIX.md` rows **Secrets** and **Environments** (AVAILABLE 2026-10-22, production `/api/health` 200)
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S2b
- Decisions: ADR-0006 (identity, workspaces and roles)
- Split: project/token UI and the JD-M09 welcome email move to **S2c** (timebox rule).

## Global constraints

- Better Auth **1.7.7** (newest 1.7.x older than two weeks; npm advisory DB: no advisories for 1.7.7 or 1.7.12 on 2026-10-22).
- Better Auth tables map onto JD-M04 `workspaces` (organization plugin) — no second workspace table.
- UUID primary keys (`advanced.database.generateId: "uuid"`); drizzle adapter with `transaction: false` (neon-http).
- Telemetry off; OAuth tokens encrypted at rest (`account.encryptOAuthTokens`).
- No mock auth in the product: if auth is not configured the UI says so.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | Identity tables | JD-M03 | `users`, `sessions`, `accounts`, `verifications`, `workspace_members`, `invitations` with Better Auth field names; FKs cascade; unique `(workspace_id, user_id)`; `workspaces.updated_at` added | Done |
| 2 | `createAuth()` | JD-M03 | GitHub + Google providers, organization plugin mapped onto `workspaces`, uuid ids, telemetry off, encrypted OAuth tokens; refuses to start without a ≥ 32-byte secret | Done |
| 3 | Personal workspace | JD-M03 | On every new session: if the user has no membership, create `<name>'s workspace` + `owner` membership; set `session.activeOrganizationId`; idempotent | Done |
| 4 | Migration `0001` | JD-M06 | Generated, reviewed, rollback SQL, applied to `dev-agent` | Done |
| 5 | Auth routes + sign-in UI | JD-APP | `/api/auth/[...all]`; `/sign-in` with GitHub and Google buttons (brand voice); topbar shows the signed-in user and sign-out; honest "sign-in not configured" state | Done |
| 6 | Docs | all | ADR-0006, module.json/README, registry, changeset, memory | Done |
| 7 | Verify on production | JD-APP | Social sign-in redirect URLs point to `https://javisdog.vercel.app/api/auth/callback/{github,google}`; owner signs in once with each provider; agent checks the rows on `dev-agent` (user, account with encrypted token, workspace, owner membership) | Done |

## Review focus

- Two sessions created at once for a brand-new user could create two personal workspaces → accepted (rare); the second is harmless and visible; test owned by task 3 asserts idempotency for sequential sessions.
- A user signs in with GitHub, later with Google using the same email → Better Auth account linking is off by default for unverified emails; expected: separate user unless both providers report a verified email. Verified manually in task 7.
- `BETTER_AUTH_URL` wrong on Vercel → redirect URI mismatch at the provider; task 7 checks the generated URL.

## Log

- 2026-10-22 — Owner signed in with GitHub and Google on production (second attempt; the first left no rows and Vercel logs showed nothing). DB check: users, accounts, personal workspaces (owner) as designed; OAuth access/refresh tokens encrypted; Google `id_token` stored in plain text (not covered by `encryptOAuthTokens`) → account hooks now drop it; test red → green; existing value cleared on `dev-agent`.
- 2026-10-22 — Production verified: `/api/health` ok (2 migrations, 9/9 env), sign-in URLs use the production callback (confirms `BETTER_AUTH_URL`), CI green. Google authorize URL accepted (no `redirect_uri_mismatch`).
- 2026-10-22 — Local production build: sign-in page lists both providers; `sign-in/social` returns provider URLs with our callback and minimal scopes.
- 2026-10-22 — Migration `0001_jd_m03_identity` applied to `dev-agent`; smoke 7/7.
- 2026-10-22 — First workspace test run failed: the new `identity` package had no tests, so Vitest exited 1 and Turbo stopped the rest → added unit tests (no `passWithNoTests`). Test helper switched to `createOAuthUser`, the call the OAuth callback makes.
- 2026-10-22 — drizzle-kit missed the identity tables (discovers named exports only) → JD-M06 `schema.ts` exports them by name; regenerated.
- 2026-10-22 — Sprint start; Better Auth 1.7.7 API read from installed source (generateId uuid, organization schema mapping, drizzle adapter `transaction`, `encryptOAuthTokens`, `disableIpTracking`, telemetry).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm format:check` / `lint` / `typecheck` | 0 | 2 / 7 / 10 s | all | 0 | 0 | 0 | 0 | — |
| `pnpm test` (workspace) | 0 | — | 173 | 0 | 0 | 0 | 0 | identity 6, event-store 22, web 56, projects 27, ui 33, jgr-spec 29 |
| `pnpm build` | 0 | 18 s | — | — | — | — | — | `/sign-in`, `/api/auth/[...all]` dynamic |
| `db:migrate` on `dev-agent` (0001) | 0 | — | applied | — | — | — | — | — |
| `db:smoke` on `dev-agent` | 0 | — | 7 | 0 | 0 | 0 | 0 | 2 migrations, 9 tables |
| local `next start`: `/sign-in`, `POST /api/auth/sign-in/social` ×2, `get-session` | 0 | — | 4 | 0 | — | — | — | GitHub/Google URLs with localhost callback; scopes `read:user user:email` / `openid email profile` |
| Production `/api/health` + `sign-in/social` ×2 (`a55b415`) | 0 | — | 3 | 0 | — | — | — | DB ok, 2 migrations, 9/9 env; callbacks on `javisdog.vercel.app` |
| GitHub Actions CI (`a55b415`) | 0 | — | success | 0 | — | — | — | — |
| Owner sign-in on production: GitHub, Google | 0 | — | 2 | 0 | — | — | — | first attempt left no rows (cause not captured); retry in a private window succeeded |
| Agent DB check on `dev-agent` after sign-in | 0 | — | 2 users, 2 accounts, 2 owner workspaces | 0 | — | — | — | access/refresh tokens hex-encrypted; Google `id_token` stored **plain** → fixed below |
| `identity.test.ts` id_token test, red → green | 1 → 0 | — | 23 | 0 | — | — | — | fails without the hook, passes with it |
| `pnpm test` (workspace, after fix) | 0 | — | 174 | 0 | 0 | 0 | 0 | — |

Screenshots: 0.

## Decisions and deviations

- S2b split into S2b (sign-in) and S2c (project UI, welcome email).

## Retro

- Went well: reading the installed Better Auth source first made the workspace mapping work on the first try; offline tests of the provider redirect caught config issues before any real sign-in.
- Hurt: the first real sign-in failed without any trace (Vercel runtime logs return nothing for this project), so the cause is unknown; the retry worked.
- Change next sprint: log sign-in failures ourselves (Better Auth `onAPIError` / logger → structured, PII-free) so failures leave evidence; S2c builds on the active workspace.

## Guru checkpoint

Due at S2c close (feature completion: identity + projects).
