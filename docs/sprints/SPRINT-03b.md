# Sprint 03b — JGR SDK and retention purge

- Dates: 2026-10-23 (timebox 30 min) · Status: **IN PROGRESS**
- Goal: collectors get one SDK that builds valid JGR events and delivers them reliably (batches, jittered retry, local spool); the 30-day retention runs daily.
- Modules touched: JD-M02 (new package `@javis-dog/jgr-sdk`), JD-M06 (`EVENT_RETENTION_DAYS`), JD-APP (cron route, `vercel.json`, health)
- Readiness gate: S3a closed (ingest live); Vercel Cron available on Hobby (daily); `CRON_SECRET` must be added by the owner (agent gets 403 on Vercel env)
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S3b
- Decisions: ADR-0009

## Global constraints

- The SDK never writes the ingest token to disk or into error messages.
- Only events that pass JD-M01 validation are spooled; L0 by default.
- The purge deletes nothing unless the request carries the exact `CRON_SECRET`.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | Event builder | JD-M02 | Monotonic ULIDs; per-thread sequence; JD-M01 validation; invalid input → issues, nothing spooled | Done |
| 2 | Spools | JD-M02 | `MemorySpool` and `FileSpool`: FIFO by event id, bounded with oldest-first eviction, atomic writes, corrupt files skipped and removed | Done |
| 3 | Delivery | JD-M02 | Batches ≤ 100 / 256 KB; gzip > 1 KB; retry rules per ADR-0009 incl. `Retry-After`; 401/403 keep spool; 413 halves; 400 drops + reports | Done |
| 4 | Purge route | JD-APP, JD-M06 | `GET /api/cron/purge-events`: 503 without secret, 401 wrong secret (constant time), 200 `{ deleted }`; cutoff = now − 30 days; daily cron in `apps/web/vercel.json` | Done |
| 5 | Docs | all | ADR-0009, READMEs, registry, changeset, health lists `CRON_SECRET`, memory | Done |
| 6 | `CRON_SECRET` on Vercel + first run | owner | Health shows `CRON_SECRET: true`; a manual call with the secret → 200 | Pending owner |

## Log

- 2026-10-23 — Built tasks 1–5. First SDK run: 2 red, both test-fixture errors (an all-31 random source correctly overflows the ULID; two scripted 413s correctly shrink the batch to 1) — fixtures/expectations corrected, behaviour unchanged, overflow now has its own test.
- 2026-10-23 — Sprint start; Vercel project root `apps/web` (provisioning how-to), Hobby cron = daily; ADR-0009.

## Owner steps

1. Generate a secret without showing it (copied to the clipboard):

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard
   ```

2. Vercel → `javisdog` → Settings → Environment Variables → add `CRON_SECRET` (Production), paste, save, then redeploy the latest deployment.
3. Check: `https://javisdog.vercel.app/api/health` shows `"CRON_SECRET": true`, and Settings → Cron Jobs lists `/api/cron/purge-events` daily at 20:00 UTC (03:00 GMT+7). If no cron is listed, the project's Root Directory is not `apps/web` — tell the agent.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm format:check` / `lint` / `typecheck` / `docs:check` / `build` (Windows) | 0 | — | all | 0 | 0 | 0 | 0 | `/api/cron/purge-events` and `/api/v1/events` dynamic |
| `pnpm test` (workspace) | 0 | — | 280 | 0 | 0 | 0 | 0 | web 90, jgr-sdk 29, ingest 19, event-store 36, projects 27, identity 13, jgr-spec 29, ui 33, notify 4 |
| SDK → real ingest handler on PGlite (`e2e.test.ts`) | 0 | — | 1 | 0 | — | — | — | 120 events, one network failure retried, resend deduplicated |
| Production after deploy of `07dfa99`: `GET /api/health`; `GET /api/cron/purge-events` without secret | 0 | — | 2 | 0 | — | — | — | health 200, 3 migrations, `CRON_SECRET: false`; purge 503 `not_configured` (deletes nothing) |
| Cron registered on Vercel | — | — | — | — | — | — | 1 | UNKNOWN: Vercel MCP `get_deployment` does not expose crons; check Settings → Cron Jobs |
| Purge with the real `CRON_SECRET` on production | — | — | — | — | — | — | 1 | owner step |

Screenshots: 0.

## Decisions and deviations

## Retro

## Guru checkpoint

G2 at the end of S3 (after S3c).
