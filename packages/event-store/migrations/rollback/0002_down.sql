-- Manual rollback for 0002_jd_m06_events (ADR-0008).
-- Review before running; destroys all stored JGR events and rate windows.
DROP TABLE IF EXISTS "ingest_rate_windows";
DROP TABLE IF EXISTS "events";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = 'a0c5645b7dc1e99da56a35fac20dff80a11ca8d3dc771cbe91417852df9eab02';
