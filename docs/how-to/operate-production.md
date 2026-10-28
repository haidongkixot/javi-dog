# How to operate production (runbooks)

Applies to `https://javisdog.vercel.app` (Vercel project `javisdog`, Neon project `neon-javisdog`, branch `main`). Decisions: ADR-0008, ADR-0009, ADR-0014, ADR-0015. Rolling back is covered in `roll-back-a-release.md`.

Ground rules for every runbook:

- Never paste a connection string, token, password or API key into chat, a log, an issue or a commit. Report presence and shape only.
- On production, read **counts** and ids, never rows with personal data (emails, names, OAuth tokens).
- Deleting or changing data on `main` needs the owner's approval, written in the sprint log.
- Server logs are one JSON line each: `{"level","module","msg",…}`, plus `{"event":"auth",…}` lines from sign-in. Read them in Vercel → Project → Logs, or through the Vercel MCP `get_runtime_logs` / `get_runtime_errors`.

## First check for any incident

1. `curl -s https://javisdog.vercel.app/api/health`. Look at `status`, `db.status`, `db.migrationsApplied` (expected **6**), `deployment.commit` and the `env` booleans. Values are never shown.
2. Vercel → Deployments: is the latest production deployment **Ready**, and from which commit?
3. Vercel runtime errors for the last hour.
4. Neon console → `main` → Monitoring: compute state, connections, storage. Free plan: 0.25 CU and 512 MiB per branch.

## Ingest failures (`POST /api/v1/events`)

| Symptom | Check | Action |
|---|---|---|
| Collectors report `401` | Token revoked or issued on another database (after cutover, every `dev-agent` token is gone) | Issue a new token on the project page and run `javi init` again |
| `415` | Wrong `Content-Type` or `Content-Encoding` from a custom producer | The JGR SDK keeps its spool on 415; fix the producer's headers |
| `413` | Batch > 256 KB after gzip or > 100 events | The SDK halves the batch by itself; a custom producer must split |
| `429` | > 60 batches/min for one token | Expected under bursts; the SDK honours `Retry-After`. If it persists, look for a runaway producer |
| `503 not_configured` | `/api/health` `env.DATABASE_URL` false | Restore the env var in Vercel (owner), then redeploy |
| `500` with `{"module":"JD-M05"…}` logs | Database errors in the log `msg` | Check Neon compute and storage; if `main` hit 512 MiB, see "Neon limits" |

Dashboards show `stale` honestly while ingest is down. Do not change freshness rules to hide an outage.

## Sign-in failures

1. Logs with `"event":"auth"`: emails and tokens are already redacted.
2. `env.GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` must all be true.
3. The OAuth apps' callback URLs must be `https://javisdog.vercel.app/api/auth/callback/github` and `…/google` (owner checks in GitHub and Google Cloud).
4. Users land on `/sign-in?error=…` when a sign-in fails. That is the expected route, not a crash.

## Email failures (welcome, budget alerts)

- Budget alerts log `budget alert sent|failed` with `outcome` and the error names. Addresses are never logged.
- `failed` alerts are retried on a later usage report, up to 5 attempts (ADR-0014). Duplicates are possible after a timeout or a partial failure, and that is a documented limitation.
- Without `RESEND_API_KEY`, `EMAIL_FROM` or `BETTER_AUTH_URL`, no email is attempted and no alert is claimed.
- Check the Resend dashboard for domain `eagodi.com`: verified, no suppression of the owner's address. Resend rate limits are UNVERIFIED.

## Retention purge and `CRON_SECRET`

- The daily Vercel Cron (20:00 UTC, `apps/web/vercel.json`) calls `GET /api/cron/purge-events` with `Authorization: Bearer $CRON_SECRET`.
- `env.CRON_SECRET` false means **no purge runs**, so events pile up past 30 days. Owner steps are in `docs/sprints/SPRINT-03b.md` "Owner steps".
- A run deletes in bounded batches and reports `{deleted, batches, complete}`. When `complete` is false, the next day continues.
- The cutoff keeps the whole current UTC month (ADR-0014), so up to 31 days are kept.

## Migrations on production

1. Apply the migration to `dev-agent` first (`docs/how-to/run-database-migrations.md`), run `db:smoke`, and get CI green.
2. Create a restore point (a branch of `main`), because point-in-time restore reaches back only 6 h.
3. Apply it to `main` one of two ways. (a) The owner runs `pnpm --filter @javis-dog/event-store db:migrate` with `main`'s URL on their own machine. (b) The agent prints the statements with `db:statements --after <last created_at>` and runs each migration in one Neon MCP transaction, including its `drizzle.__drizzle_migrations` row.
4. Verify: the ledger hashes match `dev-agent`, `compare_database_schema` against `dev-agent` is empty, and `/api/health` shows the new count.
5. Push the code that needs the migration only after the migration is on `main`. Code must also keep working one migration behind, so that instant rollback stays safe.

## Secrets

- Accepted risk (owner, 2026-10-28): the `neondb_owner` password and the GitHub client secret pasted in chat are **not rotated** (readiness matrix).
- To rotate later:
  1. Neon: reset the `neondb_owner` password on `main`. Branches keep separate copies of a role's password.
  2. Vercel: update Production `DATABASE_URL` and redeploy.
  3. GitHub: generate a new client secret, update Vercel, redeploy, then delete the old one.
  4. Verify sign-in and `/api/health`.
- A leaked ingest token: revoke it on the project page. The next batch gets `401`.

## Neon limits (free plan, read 2026-10-28)

- 512 MiB per branch, 0.25 CU, 6 h history, 10 branches.
- Watch storage under Neon → `main` → Monitoring. If it nears the limit:
  1. Make sure the purge runs (`CRON_SECRET`).
  2. Ask the owner about a paid plan (readiness: Budget).
  3. Never delete event rows by hand without owner approval.

## Escalation

The owner (Hai) is the only escalation path today. Write what happened, the time in UTC, the evidence and the next step in the active sprint file. Vercel Hobby has no SLA. Commercial use needs a paid plan first (readiness: Budget).
