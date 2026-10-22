import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema } from '../src/index.ts';

// fileURLToPath, not URL.pathname: pathname keeps %20 and a leading "/D:" on Windows.
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** A fresh in-process Postgres with the committed migrations applied (TEST_PLAN S2a, Q1 = PGlite). */
export const freshDb = async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { client, db };
};

export const rollbackSql = (n: '0000' | '0001' | '0002') =>
  readFileSync(new URL(`../migrations/rollback/${n}_down.sql`, import.meta.url), 'utf8');
