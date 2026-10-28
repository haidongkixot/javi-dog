-- Manual rollback for 0003_jd_m06_canonical_event_ids (ADR-0008 Changes, S3d H1).
ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_event_id_canonical_check";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = '2fbf2bbba298ed741f075f039d98acbaeaa7d3385e5565c5817fa9d1a4d63f2c';
