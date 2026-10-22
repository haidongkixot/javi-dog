# ADR-0005: Data layer — Drizzle over Neon HTTP, module-owned tables, hashed ingest tokens

- Status: **Accepted** 2026-10-22 (owner took the recommendations for Q1–Q4 in `docs/sprints/SPRINT-02a.md`); see *Changes*
- Date: 2026-10-20
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: JD-M06, JD-M04, JD-APP; JD-M03 (consumer from S2b), JD-M05 (consumer from S3)

## Context and problem statement

S2a introduces the first persistent data: workspaces, projects and the ingest tokens that collectors will use in S3. ADR-0002 fixes the stack (Neon + Drizzle). Open questions: where table definitions live without breaking ADR-0001 boundaries, how migrations are generated and applied, how tokens are stored, how tenancy is enforced, and how this is tested.

Facts (2026-10-20): Neon `dev-agent` answers over HTTPS (PostgreSQL 18.6, 0 public tables); raw TCP to port 5432 from the agent sandbox times out; Vercel env listing is 403 for the agent.

## Considered options

### Table ownership

1. One shared `schema.ts` in JD-M06 holding every table.
2. **Each module defines its tables and exports them from its public index; JD-M06 composes them** for migrations and owns the client.
3. Schema in JD-APP.

### Migration path

1. `drizzle-kit push` / `migrate` straight from the CLI (TCP or WebSocket).
2. **`drizzle-kit generate` offline + apply with the `drizzle-orm/neon-http/migrator` from a script.**
3. Run migrations during `next build` on Vercel.

### Ingest token storage

1. Plaintext.
2. Slow hash (argon2/bcrypt).
3. **SHA-256 of a 256-bit random token**, unique-indexed, with a short display prefix.
4. HMAC-SHA-256 with a server pepper.

## Decision outcome

- **Tables: option 2.** JD-M04 owns `workspaces`, `projects`, `ingest_tokens` (defined with `drizzle-orm/pg-core`, exported from `@javis-dog/projects`). JD-M06 owns the Neon client (`createDb`), `pingDb`, the composed `schema`, `drizzle.config.ts` and `migrations/`; it consumes JD-M04 through its public index. JD-M04's repository receives the `db` handle by injection, so JD-M04 does not import JD-M06 (no cycle). Later modules (JD-M03 auth tables, JD-M06 events) follow the same pattern.
- **Migrations: option 2.** SQL is generated offline and reviewed in the diff; it is applied by `pnpm --filter @javis-dog/event-store db:migrate`, which uses the HTTP migrator (works through the sandbox proxy and on Vercel). Never at build time (option 3 would change production schema on every deploy). In S2a only the `dev-agent` branch is migrated. Drizzle has no down migrations: each migration gets a reviewed `rollback/NNNN_down.sql`, run manually; Neon point-in-time restore is the fallback.
- **Tokens: option 3.** Format `jd_it_<43 base64url chars>` (32 bytes from `crypto.getRandomValues`). The prefix makes leaked tokens greppable by secret scanners. Store `sha256(token)` hex (unique index) and `display_prefix` (first 8 secret chars) for the UI. Plaintext is returned once by `issueToken`. Lookup is by hash, so no timing-sensitive comparison of secrets happens in application code. A slow hash adds latency on every ingest batch without benefit for 256-bit random secrets; a pepper (option 4) adds a secret whose loss invalidates every token — revisit if the threat model changes.
- **Tenancy:** every repository method takes `workspaceId` and filters by it; there is no unscoped read. Projects and tokens cascade on workspace delete. `last_signal_at` is written only by the ingest path (S3), never by user input (product rule 2).
- **IDs:** UUID v4 via `gen_random_uuid()` (works on Neon PG 18 and in PGlite PG 17; PG 18's `uuidv7()` is not used so tests and production share one SQL).
- **Better Auth compatibility (hypothesis, verify in S2b):** `workspaces` carries `id`, `name`, `slug` (globally unique), `logo`, `metadata`, `created_at` so Better Auth's organization plugin can map its `organization` model onto it via `modelName`/`fields`; members and invitations arrive with JD-M03 in S2b.
- **Tests (pending Q1):** repository and migration tests run on PGlite in-process, applying the committed migration SQL; one manual smoke script checks `dev-agent`.

### Data model (S2a)

| Table | Columns |
|---|---|
| `workspaces` | `id uuid pk`, `name text not null`, `slug text unique not null`, `logo text null`, `metadata jsonb null`, `created_at timestamptz default now()` |
| `projects` | `id uuid pk`, `workspace_id uuid fk → workspaces on delete cascade`, `name`, `slug`, `description null`, `platforms text[] not null`, `privacy_class text check in ('L0','L1','L2') default 'L0'`, `repository_url null`, `created_at`, `last_signal_at null`; unique `(workspace_id, slug)` |
| `ingest_tokens` | `id uuid pk`, `project_id uuid fk → projects on delete cascade`, `workspace_id uuid fk` (denormalized for scoped lookups), `name text`, `token_hash char(64) unique`, `display_prefix char(8)`, `created_at`, `last_used_at null`, `revoked_at null`; partial index on active tokens per project |

## Consequences

- Positive: boundaries stay lint-enforceable; migration SQL is reviewable; tokens are useless if the DB leaks; tests use real SQL without network.
- Negative: one extra composition step in JD-M06 for each new module; PGlite (PG 17) differs slightly from Neon (PG 18) — avoid PG 18-only features or add a dev-agent check for them; manual rollback scripts must be kept in sync.
- Follow-up: S2b verifies the Better Auth mapping; S3 adds `events` (with retention ADR) and `last_used_at` updates; S5 decides per-environment Neon branches for previews and production.

## Changes

- 2026-10-22 (implementation, S2a):
  - `ingest_tokens` references `projects(id, workspace_id)` with a **composite foreign key** (plus a unique constraint on `projects(id, workspace_id)`), so Postgres itself refuses a token whose project lives in another workspace. The separate `workspace_id → workspaces` FK was dropped; cascade still flows through `projects`.
  - `token_hash`/`display_prefix` are `text` with a `CHECK` on 64 lowercase hex chars instead of `char(n)`.
  - Repository integration tests live in **JD-M06** (`packages/event-store/test/`), which owns the migrations; JD-M04 keeps pure unit tests. This avoids a JD-M04 → JD-M06 dependency cycle.
  - `pingDb` checks for `drizzle.__drizzle_migrations` with a separate statement: Postgres resolves relation names at plan time, so a `CASE` guard failed on an unmigrated database (caught by a test).
  - `tsconfig.base.json` sets `erasableSyntaxOnly` so code stays runnable by Node's built-in type stripping (used by `db:migrate` / `db:smoke`).
