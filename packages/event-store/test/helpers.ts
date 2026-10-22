import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema } from '../src/index.ts';

export const migrationsFolder = new URL('../migrations', import.meta.url).pathname;

/** A fresh in-process Postgres with the committed migrations applied (TEST_PLAN S2a, Q1 = PGlite). */
export const freshDb = async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { client, db };
};

export const rollbackSql = () =>
  readFileSync(new URL('../migrations/rollback/0000_down.sql', import.meta.url), 'utf8');
