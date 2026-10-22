-- Manual rollback for 0000_jd_m04_workspaces_projects_tokens (ADR-0005).
-- Review before running; destroys all workspaces, projects and ingest tokens.
DROP TABLE IF EXISTS "ingest_tokens";
DROP TABLE IF EXISTS "projects";
DROP TABLE IF EXISTS "workspaces";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = '2052023254905de060acfc61615757ccaa41dc4f694ee4afb0b98414d3ab9e88';
