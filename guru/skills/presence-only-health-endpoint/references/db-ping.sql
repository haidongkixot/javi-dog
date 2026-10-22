-- Database ping that also works on an empty (unmigrated) Postgres database.
-- Guru skill `presence-only-health-endpoint`.
--
-- Do NOT guard a possibly-missing table with CASE/COALESCE in one statement:
--
--   select case when to_regclass('app_migrations') is null then 0
--               else (select count(*) from app_migrations) end;
--
-- Postgres resolves relation names before execution, so this fails with
-- `relation "app_migrations" does not exist` whenever the table is absent
-- (verified on PGlite / Postgres 17 at G2-prep).
--
-- Use two statements instead. Statement 1 never fails on a missing table:

select to_regclass('app_migrations') is not null as present;

-- Statement 2 runs only when statement 1 returned present = true:

select count(*)::int as applied from app_migrations;

-- Replace `app_migrations` with your migration tool's bookkeeping table
-- (schema-qualified if it lives outside the search path).
