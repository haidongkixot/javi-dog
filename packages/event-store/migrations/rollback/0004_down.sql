-- Manual rollback for 0004_jd_m06_workspace_received_idx (ADR-0013, S4b).
DROP INDEX IF EXISTS "events_workspace_received_idx";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = 'b160094a077b8f829c86c3619c206c435332dfe404973769ce4d08d34999c1b3';
