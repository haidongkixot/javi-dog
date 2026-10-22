# JD-M06 · `@javis-dog/event-store` — Database client, schema composition and migrations

Status: **in-progress**. S2a: Neon client over HTTP, composed schema (JD-M04 tables), migration `0000`, DB ping for `/api/health`. S3: JGR events, rollups and retention.

## Public contract

| Export | Description |
|---|---|
| `createDb(databaseUrl)` | Drizzle over `@neondatabase/serverless` HTTP (one HTTPS request per query; no interactive transactions) |
| `pingDb(db)` | `{ latencyMs, migrationsApplied }`; throws on failure |
| `schema`, `workspaces`, `projects`, `ingestTokens` | Composed schema (each module owns its tables, ADR-0005) |
| `Db`, `AnyDb`, `DbPing` | Types |

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @javis-dog/event-store db:generate` | Generate SQL from the schema (offline). CI fails if this produces a change |
| `pnpm --filter @javis-dog/event-store db:migrate` | Apply committed migrations to `DATABASE_URL` over HTTP |
| `pnpm --filter @javis-dog/event-store db:smoke` | Manual round trip on a real branch; cleans up after itself |

See `docs/how-to/run-database-migrations.md`. Tests run on PGlite (in-process Postgres 17) with the committed migration SQL.
