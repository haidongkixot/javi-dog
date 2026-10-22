-- Manual rollback for 0001_jd_m03_identity (ADR-0006).
-- Review before running; destroys all users, sessions, accounts and memberships.
DROP TABLE IF EXISTS "invitations";
DROP TABLE IF EXISTS "workspace_members";
DROP TABLE IF EXISTS "verifications";
DROP TABLE IF EXISTS "accounts";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "users";
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "updated_at";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = '17468d4d54bab7185f06141b3704526de493c969d9d9df4b9dceeb0870bbcc5c';
