# How to change the database schema and run migrations

Applies to JD-M06 (`packages/event-store`). Decision: ADR-0005. Migrate `dev-agent` first, then production (`main`) as described in §5 (ADR-0015).

## 1. Change the schema

Edit the owning module's tables (for example `packages/projects/src/db/tables.ts`) and export them through its public `src/index.ts`. New modules are added to `packages/event-store/src/schema.ts`.

## 2. Generate SQL (offline)

```bash
pnpm --filter @javis-dog/event-store exec drizzle-kit generate --name <short_snake_case_name>
```

Review the generated `migrations/NNNN_<name>.sql` in the diff. Write `migrations/rollback/NNNN_down.sql` by hand, including the `DELETE` from `drizzle.__drizzle_migrations` (the hash is `sha256sum` of the SQL file). Never edit a migration that has been applied anywhere.

## 3. Test

```bash
pnpm --filter @javis-dog/event-store test   # PGlite: up, down, re-apply, repository
```

## 4. Apply to dev-agent

`DATABASE_URL` must point at `dev-agent`. In the agent sandbox Node needs the proxy flag, and `psql` cannot connect (TCP is blocked):

```bash
NODE_USE_ENV_PROXY=1 pnpm --filter @javis-dog/event-store db:migrate
NODE_USE_ENV_PROXY=1 pnpm --filter @javis-dog/event-store db:smoke
```

Then open `/api/health` and check `db.migrationsApplied`.

**If a migration fails half-way:** the neon-http migrator runs statement by statement without a transaction and records the journal row only at the end, so a retry fails with "relation already exists". Run the migration's reviewed `rollback/NNNN_down.sql` (it uses `IF EXISTS`, so it clears partial state) in the Neon SQL editor, fix the cause, then migrate again.

## 5. Apply to production (`main`)

After `dev-agent` passes `db:smoke` and CI is green, follow `docs/how-to/operate-production.md` "Migrations on production". It covers the restore-point branch, `db:migrate` from the owner's machine or `db:statements --after <created_at>` through the Neon MCP (one transaction per migration, including its ledger row), and verification against `dev-agent`.

## Rollback

Run the reviewed `rollback/NNNN_down.sql` in the Neon SQL editor. For data loss, use Neon point-in-time restore on the branch. The window is 6 h on the free plan. Full procedure: `docs/how-to/roll-back-a-release.md`.

## Never

- Run migrations from `next build` or a Vercel deploy.
- Migrate a production branch without owner approval.
