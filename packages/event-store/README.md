# JD-M06 · `@javis-dog/event-store` — Database client, schema composition and migrations

Status: **in-progress**. S2a: Neon client over HTTP, composed schema (JD-M04 tables), migration `0000`, DB ping for `/api/health`. S3a: `events` and `ingest_rate_windows` (migration `0002`, ADR-0008). Later: rollups (S4) and the scheduled retention purge (S3b).

## Public contract

| Export | Description |
|---|---|
| `createDb(databaseUrl)` | Drizzle over `@neondatabase/serverless` HTTP (one HTTPS request per query; no interactive transactions) |
| `pingDb(db)` | `{ latencyMs, migrationsApplied }`; throws on failure |
| `createEventRepository(db)` | `insertEvents` (dedupe per project, returns stored count), `hitRateWindow` (atomic per-token minute counter), `purgeEventsBefore` (retention: 30 days, but the whole current UTC month is kept — ADR-0008, ADR-0014), `touchSignal` (`projects.last_signal_at`) |
| `EVENT_RETENTION_DAYS`, `retentionCutoff(now)` | Raw retention: 30 days, but the whole current UTC month is kept (ADR-0014): cutoff = `min(now − 30 days, start of the current UTC month)`, at most 31 days; used by the daily purge route (S3b) |
| `getMigrationsFolder()` from **`@javis-dog/event-store/migrations`** | Absolute path of the committed migrations, for scripts and other modules' PGlite tests. Separate entry point because bundlers resolve its `import.meta.url` asset; app code never imports it |
| `schema`, `workspaces`, `projects`, `ingestTokens`, `events`, `ingestRateWindows` | Composed schema (each module owns its tables, ADR-0005) |
| `Db`, `AnyDb`, `DbPing`, `EventRepository`, `NewEvent` | Types |

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @javis-dog/event-store db:generate` | Generate SQL from the schema (offline). CI fails if this produces a change |
| `pnpm --filter @javis-dog/event-store db:migrate` | Apply committed migrations to `DATABASE_URL` over HTTP |
| `pnpm --filter @javis-dog/event-store db:smoke` | Manual round trip on a real branch; cleans up after itself |
| `pnpm --filter @javis-dog/event-store db:events -- --project <slug>` | Read-only: events per type, sessions, first/last receipt and `last_signal_at` for a project slug (counts only) |

See `docs/how-to/run-database-migrations.md`. Tests run on PGlite (in-process Postgres 17) with the committed migration SQL.
