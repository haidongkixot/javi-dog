-- Manual rollback for 0006_jd_m10_github (ADR-0019, S5g). Repositories first: they reference
-- github_installations. Drops every installation, link and delivery hash; signals already stored
-- as events stay. A build that still serves the JD-M10 webhook then answers 500 on deliveries.
DROP TABLE IF EXISTS "github_repositories";
DROP TABLE IF EXISTS "github_installations";
DROP TABLE IF EXISTS "github_deliveries";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = '876b4c7b8b6d6487503679cb3598b4902fb4da0dfc4aa57793b8bd44c49511f3';
