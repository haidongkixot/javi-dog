-- Manual rollback for 0006_jd_m10_github (ADR-0019, S5g). Repositories first: they reference
-- github_installations. Drops every installation, link and delivery hash (installation hashes
-- included: re-applying 0006 starts the replay guard empty); signals already stored
-- as events stay. A build that still serves the JD-M10 webhook then answers 500 on deliveries.
DROP TABLE IF EXISTS "github_repositories";
DROP TABLE IF EXISTS "github_installations";
DROP TABLE IF EXISTS "github_deliveries";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = '4f3f244c2e7e7f1df3f7301360ddec134ed0b24347ed88f37bce26b6650188b7';
