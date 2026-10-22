# Sprint 02c — Projects, ingest tokens, welcome email

- Dates: 2026-10-22 (timebox 30 min) · Status: **ACTIVE** (tasks 1–5 done; owner check on production pending)
- Goal: a signed-in user can create projects in their workspace, issue and revoke ingest tokens, gets a welcome email on first sign-in, and failed sign-ins leave evidence.
- Modules touched: JD-APP, JD-M03, JD-M04, JD-M09 (new package)
- Readiness gate: S2b closed; Resend AVAILABLE (B5)
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S2c
- Decisions: ADR-0006 (authorization rule), ADR-0007 (welcome email + auth logging)

## Global constraints

- `workspaceId` always comes from the session's active workspace **after a membership check** — never from form or URL input.
- Plaintext ingest tokens are shown once in the response that created them and never logged, cached or stored.
- Projects show "No signal yet" until JD-M05 writes `last_signal_at` (product rule 2).
- Logs are structured and PII-free (no emails, names, tokens).
- Email failure never blocks sign-in.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | `resolveWorkspace()` | JD-M03 | Returns the active workspace only if the user is a member; otherwise the user's first workspace; tested on PGlite incl. a forged active id | Done |
| 2 | Projects list + create | JD-APP | Signed out → sign-in prompt; signed in → real rows of the workspace; create form with validation errors from `normalizeProjectInput`; slug clash message | Done |
| 3 | Project detail + tokens | JD-APP | `/projects/[id]` only for projects in the viewer's workspace (else 404); issue token (shown once, copy hint), list by display prefix, revoke | Done |
| 4 | Auth failure evidence | JD-M03, JD-APP | Better Auth logger → structured JSON with emails/tokens redacted; `errorURL` → `/sign-in?error=…` with a readable message | Done |
| 5 | Welcome email | JD-M09, JD-M03 | `sendWelcomeEmail()` via Resend REST (no new dependency); sent once from the user-created hook; failures logged without PII; smoke send to `delivered@resend.dev` | Done |
| 6 | Docs + checkpoint | all | ADR-0007, READMEs, registry, changeset, memory; Guru checkpoint G2-prep | Planned |

## Review focus

- A user edits the session cookie or posts another workspace's project id → 404 / `not_found`, never data (tests in tasks 1 and 3).
- Double-submit of "issue token" → two tokens, both listed; soft limit 5 holds.
- Resend down or domain misconfigured → sign-in still succeeds; one `onUserCreated failed: <ErrorName>` log line (tested).

## Log

- 2026-10-22 — Built: `resolveWorkspace`, redacted auth logger + `errorURL`, `onUserCreated` → JD-M09 welcome email (Resend REST), project list/create, project detail with token issue/revoke. 203 tests green; welcome email accepted by Resend sink; signed-out pages verified locally.
- 2026-10-22 — Sprint start; Better Auth `onAPIError.errorURL` and `logger.log` confirmed in 1.7.7 source.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm format:check` / `lint` / `typecheck` / `build` | 0 | — | all | 0 | 0 | 0 | 0 | `/projects`, `/projects/[id]`, `/sign-in` dynamic |
| `pnpm test` (workspace) | 0 | — | 203 | 0 | 0 | 0 | 0 | web 77, event-store 26, identity 7, notify 4, projects 27, ui 33, jgr-spec 29 |
| `email:smoke` → `delivered@resend.dev` | 0 | — | 1 | 0 | — | — | — | accepted by Resend |
| local `next start` (dev-agent): signed-out `/projects`, `/projects/[id]`, `/sign-in?error=…`, `/api/health` | 0 | — | 4 | 0 | — | — | — | prompts and message rendered |
| Signed-in flow on production | — | — | — | — | — | — | 1 | owner check |

Screenshots: 0.

## Decisions and deviations

- ADR-0007: welcome email via Resend REST (no new dependency), PII-free auth logging, failed callbacks → `/sign-in?error=`.
- Welcome email only for users created after this deploy; the owner's two accounts predate it.

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

Due at close (feature completion: identity + projects).
