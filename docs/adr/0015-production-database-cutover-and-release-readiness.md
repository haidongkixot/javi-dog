# ADR-0015: Production database cutover, rollback and release-readiness checks

- Status: **Accepted** 2026-10-28 (owner: "Release-first", "New production branch", "Accept risk, no rotation")
- Date: 2026-10-28
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules: JD-M06 (migrations), JD-APP (deployment); every module that reads or writes the database

## Context and problem statement

The release gate (roadmap, end of S5) needs working end-to-end telemetry, verified access boundaries, test evidence and a rollback plan. Today production (`https://javisdog.vercel.app`) reads the Neon `dev-agent` branch (owner decision Q5 = A, 2026-10-22). Facts from S5a discovery, 2026-10-28:

- Neon project `neon-javisdog` (`wispy-rice-64407917`), plan `free_v3`, fixed 0.25 CU compute, 512 MiB per branch, **history retention 21 600 s (6 h point-in-time restore)**, no snapshot schedule, 10 branches maximum.
- Branch `main` (`br-polished-voice-b85qksl1`) is the default branch and is marked as the **Vercel production branch** by the Vercel–Neon integration. It cannot be deleted. It has **no tables in `public` and no `drizzle` schema**. It holds only an empty, unused `neon_auth` schema (9 tables, 0 users) that Neon provisioned. The app does not use it, because it uses Better Auth tables in `public` (ADR-0006).
- Branch `dev-agent` holds test rows only and runs 6 migrations.
- The agent cannot list or write Vercel env vars (403). `psql`/TCP is blocked from the sandbox; only HTTPS reaches Neon.
- The JGR delivery target is p95 < 2 s, which is a hypothesis to measure in S5 (JGR v0.1 §1, ADR-0008).

## Decision outcome

1. **Production database = Neon `main`.** It is the integration's production branch, so no third branch is created. `dev-agent` stays the development and smoke branch. Nothing is copied from `dev-agent`, because it holds test data only. After cutover, everyone signs in again and gets a new personal workspace. Ingest tokens issued on `dev-agent` stop working, and the collector shows `401` until `javi init` runs with a new token.
2. **Migrations on `main`** use the committed files only, in journal order, with no hand-written DDL. They are applied through the Neon MCP server, so no connection string enters the agent session. Drizzle's own `readMigrationFiles` produces the statements and hashes (`db:statements` script). Each migration runs as **one transaction** that includes its `drizzle.__drizzle_migrations` row (`hash`, `created_at` = journal `when`), the same rows that `drizzle-orm/neon-http/migrator` writes. A later `pnpm db:migrate` against `main` therefore continues from the same state. The order is always `dev-agent` first (with `db:smoke`), then `main`. Verification: a schema comparison of `main` with `dev-agent` shows no difference in `public`/`drizzle`, and the migration rows match. The owner's alternative path is `pnpm db:migrate` with `main`'s URL from their own machine.
3. **Cutover is an owner step.** In Vercel → Project → Settings → Environment Variables, set Production `DATABASE_URL` to `main`'s pooled connection string (Neon console → `main` → Connect) and redeploy. Verification has three checks:
   - `/api/health` reports `db.status = ok` and 6 migrations.
   - The count of `users` on `main` grows from 0 after the owner signs in. Only counts are read, never rows.
   - `dev-agent` receives no new sign-ins.
4. **Rollback plan** (`docs/how-to/roll-back-a-release.md`):
   - Application: use Vercel instant rollback (promote the previous production deployment). This is safe only while the schema is backward compatible, and every migration so far is additive.
   - Schema: apply the committed `rollback/NNNN_down.sql` files, newest first.
   - Data: use Neon point-in-time restore. It reaches back **6 h only**, so take a manual restore point before risky migrations.
   - Last resort: switch `DATABASE_URL` back to `dev-agent`. This loses every production write made since cutover.
5. **Runbooks** (`docs/how-to/operate-production.md`) cover ingest errors, sign-in failure, email failure, purge and `CRON_SECRET`, migrations, secret rotation, and Neon limits. Each one lists symptom, check, action and escalation.
6. **Load test**, bounded and run once, with its budget fixed before the run:
   - One ephemeral workspace, project and ingest token, seeded on `main` through MCP SQL. Only the SHA-256 of a locally generated token is stored. The token lives in a scratch file and is never printed.
   - At most **70 requests within 2 minutes** and at most **6 000 events**, staying under the 60 batches/min/token limit.
   - Mix: about 50 batches of 100 typical events at concurrency ≤ 5, plus 5 near-limit payloads of about 255 KiB **after decompression** (the 256 KB limit applies to the decompressed body, ADR-0008). Valid events then gzip to about 177 KB.
   - Measure client-side p50, p95 and max, including the sandbox proxy, and record any `429`.
   - Afterwards, delete the ephemeral workspace (cascade) only after the owner says OK (Neon MCP rule: no destructive SQL without asking).
   - Target: p95 < 2 s. A miss is reported as a finding, not tuned away.
7. **Access boundaries.** A route- and action-level suite covers every route handler, page loader and server action, written by QA from the ADR text (ADR-0005/0006/0008/0012/0014). Cases: signed out, a member of another workspace, a foreign project id, wrong role (budget writes), and wrong or missing bearer or cron secret. A read-only security review covers the whole app. The release gate requires both to have no open high findings.
8. **End-to-end telemetry smoke.** The real `javi` tarball, run in a temporary home against production: `init`, then hook events and `flush`. Rows are confirmed by count on `main`, and the dashboard reader runs against the same project. This uses the same ephemeral workspace and the same cleanup rule.
9. **Accepted risk (owner, 2026-10-28): no secret rotation before release.**
   - Exposed in chat: the `neondb_owner` password for `dev-agent` (2026-10-20 and 2026-10-23) and the GitHub OAuth client secret (2026-10-22).
   - New fact: Neon copies roles with their passwords when it creates a branch, so `main`'s `neondb_owner` probably has the same password (UNVERIFIED: the agent never reads passwords). If so, the exposed credential would also open production.
   - Recorded in the readiness matrix. A password reset on `main` alone costs nothing at cutover time, because the owner copies the URL then anyway. That is offered as an option, not done.

## Consequences

- Positive: production data is separated from development data, using the branch the integration expects. Schema changes are reproducible and checked against `dev-agent`. No credential is handled by the agent. Rollback paths and their limits are written down before the first real user.
- Negative:
  - Cutover depends on an owner action, because the agent cannot write Vercel env vars.
  - Production sign-ins and tokens start over.
  - Free-plan limits apply: 6 h restore window, 512 MiB per branch, 0.25 CU, and Vercel Hobby non-commercial terms. The commercial beta stays blocked on paid plans (readiness: Budget).
  - The MCP migration path depends on the Neon MCP connection, with `db:migrate` as the fallback.
  - Load-test latencies include the sandbox proxy, so they are an upper bound for the ingest path, not a server-side SLO.
