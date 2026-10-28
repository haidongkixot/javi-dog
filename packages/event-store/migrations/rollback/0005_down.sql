-- Manual rollback for 0005_jd_m12_budgets (ADR-0014, S4c).
DROP TABLE IF EXISTS "budget_alerts";
DROP TABLE IF EXISTS "project_budgets";
DELETE FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = '700d76df80ce7f211dc1951e6f82b4cbc2f78d945d224b0d1c29e96e91fab955';
