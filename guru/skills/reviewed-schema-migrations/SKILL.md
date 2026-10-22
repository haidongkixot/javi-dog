---
name: reviewed-schema-migrations
description: Treat database schema migrations as reviewed, tested artifacts — generate SQL offline from table definitions, read the generated diff for integrity and tenancy holes, write and test a manual rollback, run up/down/re-apply on an in-process or throwaway real SQL engine in the unit test suite, assert the exact table list so silently skipped tables fail, check schema-vs-SQL drift in CI, and apply only by an explicit command to a named environment, never at build or deploy time. Use when adding an ORM with a migration generator (Drizzle, Prisma, TypeORM, Alembic, Django, Rails, Ecto, Flyway), composing tables owned by several modules, choosing how tests get a real database, wiring migrations into CI/CD, or after a generator "succeeded" but a table or constraint is missing.
metadata:
  version: "0.1.0"
  origin: "javis-dog G2-prep"
  confidence: medium
---

# Reviewed schema migrations

Migration generators are convenient and quietly lossy: they emit what they discovered, in the shape they chose, and a green "generated" message says nothing about whether every table is there or whether the constraints express your rules. Applying migrations automatically at deploy time then turns an unreviewed diff into a production change.

The rule: **generated SQL is source code — reviewed in the diff, executed in tests on a real engine, checked for drift in CI, and applied on purpose.**

## Forces

- **Speed vs. control.** Push-style "sync the schema" commands are fast; they skip review and leave no artifact.
- **Real engine vs. test cost.** Mocks cannot run DDL or constraints. A shared cloud database is slow and stateful. An in-process engine (for Postgres: PGlite) or a disposable container runs the real SQL offline — at the price of a version gap with production.
- **Forward-only tools vs. rollback.** Many generators have no down migrations; a rollback you never ran is a guess.

## Workflow

### 1. Generate offline, commit the SQL

Change the table definitions, run the generator to produce a numbered SQL file, and commit it with the change. If several modules own tables, let each export its tables and compose them in the module that owns migrations, so ownership stays clear and the generator sees one schema.

### 2. Review the SQL, not just the model code

Read the generated file with a checklist:

- Every expected table, column, index and constraint is present.
- Every foreign key expresses the real rule — in multi-tenant schemas, can a row reference a parent in another tenant? (Fix with a composite key; see the `tenant-isolation-by-construction` skill.)
- Checks for closed sets and formats exist where the application assumes them (enums as `CHECK`, hash formats as regex checks).
- Nothing destructive (drops, type narrowing) that you did not intend.

### 3. Write the rollback by hand and test it

For forward-only tools, write `rollback/NNNN_down.sql` next to each migration, including removal of the tool's bookkeeping row. In tests: migrate up, run the rollbacks newest first, assert the schema is back to the previous state, then migrate up again and assert it is complete. Keep platform restore (point-in-time recovery) as the data-loss fallback, not the plan.

### 4. Run migrations in the unit test suite on a real engine

- Each test file gets a fresh engine with the committed migrations applied — the same SQL production will run.
- **Assert the exact table list** after migrating. Generators that discover tables by scanning exports can silently skip tables declared in an unexpected shape (for example nested inside an exported object); a table-list assertion turns that into a failing test.
- Avoid features that exist only in the production engine's newer version (or add a separate check against a real staging database for them). In the origin, ids use a function available in both versions instead of a newer one.
- Cold starts of in-process engines can be slow; raise the package's test timeout and record why. Do not add retries.
- Code that runs against possibly unmigrated databases (health checks, startup probes) needs its own empty-schema test; see the `presence-only-health-endpoint` skill for a Postgres trap.

### 5. Check drift in CI

Regenerate in CI and fail if the migrations folder changes:

```bash
<generate command>
test -z "$(git status --porcelain <migrations-dir>)"
```

This catches model changes committed without their migration, and hand edits to generated files.

### 6. Apply on purpose

- A dedicated command applies migrations to the environment named by its connection variable; record each application (command, exit code, environment, migration count) in the iteration record.
- **Never at build or deploy time**: a build that migrates turns every deploy into a schema change and every preview into a risk to shared data.
- Use the transport that works where you run it: if raw database ports are blocked (agent sandboxes, some CI), an HTTP-based driver or migrator may be the only path.
- Follow with a smoke script (insert/read/delete round trip, cleaned up) and a read of the deployed health endpoint's migration count.
- Production databases are migrated only with owner approval.

## Pitfalls

- **"Generated successfully" as evidence.** Check the table list.
- **Reviewing only the model diff.** Integrity holes are easier to see in SQL.
- **Editing an applied migration.** Add a new one instead.
- **Migrating in the build step.** Convenient once, dangerous forever.
- **Rollbacks never executed.** If the test suite does not run them, they are documentation.

## Evidence from origin project

Javi's Dog, Sprints 2a and 2b (2026-10-22), Drizzle ORM + Postgres (Neon in deployment, PGlite in tests). Confidence **medium**: the workflow ran for two migrations; review, drift and table-list checks each caught or would catch a real defect once.

- Decision: ADR-0005 (offline generate + HTTP migrator, never at build time, manual rollback SQL, module-owned tables composed by the store module, PGlite tests; *Changes*). How-to: `docs/how-to/run-database-migrations.md`.
- Review catch: the generated SQL showed tokens could reference a project in another workspace → composite FK (`docs/sprints/SPRINT-02a.md` Log, `dc6ef61`).
- Discovery catch: the generator missed the identity tables, which were only reachable through an exported object; fixed by named exports in `packages/event-store/src/schema.ts` (`docs/sprints/SPRINT-02b.md` Log, `a55b415`). The table-list assertion in `packages/event-store/test/migrations.test.ts` now covers all nine tables.
- Rollback tests: up → down (newest first) → re-apply in `packages/event-store/test/migrations.test.ts`; rollback files `packages/event-store/migrations/rollback/0000_down.sql`, `0001_down.sql`.
- CI drift step: `.github/workflows/ci.yml` (`dc6ef61`); CI run 18 green with it (`SPRINT-02a.md`).
- Applied by command to the development branch: `db:migrate` exit 0 and `db:smoke` 7/7 for both migrations (`SPRINT-02a.md`, `SPRINT-02b.md` Test evidence). Raw TCP to Postgres timed out in the agent sandbox; the HTTP migrator worked (`docs/agent-ops/READINESS_MATRIX.md`).
- PGlite cold start exceeded 5 s on first run → package timeout raised to 30 s, explicitly "not a retry" (`SPRINT-02a.md` Log).
- Not verified: the workflow against a production database (none migrated yet; planned for the release gate), and behavior differences between the test engine (Postgres 17) and production (Postgres 18) beyond the avoided `uuidv7()`.
