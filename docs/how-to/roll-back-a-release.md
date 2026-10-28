# How to roll back a release

Applies to production at `https://javisdog.vercel.app` (Vercel project `javisdog`, Neon branch `main`). Decision: ADR-0015. Every push to `claude/clever-goldberg-wlurty` deploys production, so a bad push is the most likely cause of a rollback.

## Decide which layer is broken

| Symptom | Layer | Go to |
|---|---|---|
| Pages or API fail right after a deploy; `/api/health` was fine before it | Application | §1 |
| A migration was applied and the app now fails on SQL errors | Schema | §2 |
| Rows were deleted or overwritten by mistake | Data | §3 |
| Production talks to the wrong database | Configuration | §4 |

Before acting, write the time (UTC), the deployment id, and the last good commit in the sprint log.

## 1. Application: promote the previous deployment

1. In Vercel, open Project `javisdog` → Deployments, find the last deployment that was **Ready** and known good (its commit is in the sprint log), then choose **Instant Rollback** (or **Promote to Production**).
2. Check `https://javisdog.vercel.app/api/health`: `status: ok`, `db.status: ok`, and `deployment.commit` equal to the good commit.
3. Fix forward on the branch: revert the bad commit with `git revert <sha>` (never force-push), run the full gate, then push. That push becomes production again.

**Limit:** an older deployment runs against today's schema. Every migration up to 0005 only adds objects, so older code keeps working. A future migration that drops or renames something must say in its ADR whether instant rollback is still safe.

## 2. Schema: apply the down migration

1. Apply the down files newest first, only for migrations applied after the good state: `packages/event-store/migrations/rollback/NNNN_down.sql`. Each file removes its objects with `IF EXISTS` and deletes its row from `drizzle.__drizzle_migrations`.
2. Run them in the Neon SQL editor on branch `main`, or through the Neon MCP `run_sql_transaction` in one transaction. They are destructive, so the owner approves each one.
3. Verify: `select count(*) from drizzle.__drizzle_migrations` on `main` shows the expected number, and `/api/health` shows the same number in `db.migrationsApplied`.
4. Roll back the application (§1) to a deployment that does not need the removed objects.

**Limit:** a down file deletes data stored in the objects it drops (for example `0005_down.sql` drops budgets and alerts). If that data must be kept, use §3 instead.

## 3. Data: Neon point-in-time restore

1. In the Neon console, open project `neon-javisdog` → branch `main` → **Restore**. Pick a time before the incident.
2. **The window is 6 hours** (free plan, `history_retention_seconds = 21600`, read 2026-10-28). Anything older cannot be restored. Before a risky migration, create a restore point by branching `main`, named `pre-<migration>-<date>`. The free plan allows 10 branches, so delete the branch after the release is verified.
3. A restore overwrites `main`. Neon keeps a backup branch of the state before the restore. Check the schema (`compare_database_schema` against `dev-agent`) and the migration count before you reopen traffic.

## 4. Configuration: point production back

**Last resort only.** Changing `DATABASE_URL` back to `dev-agent` brings the app back but loses every write made on `main` since cutover: sign-ins, projects, tokens, events, budgets.

1. In Vercel → Settings → Environment Variables → Production, set `DATABASE_URL` to the `dev-agent` pooled URL from the Neon console, then redeploy.
2. Record it in the readiness matrix ("Environments") and tell users to sign in again.

## After any rollback

- Write the sprint log entry: cause, the layers rolled back, the evidence (health JSON fields, counts), and the follow-up fix.
- Run a Guru incident checkpoint (`CLAUDE.md` §7).
