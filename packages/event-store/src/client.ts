import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { schema } from './schema.ts';

/** Drizzle over Neon's HTTP driver: one HTTPS request per query, no TCP or WebSocket. */
export const createDb = (databaseUrl: string) => drizzle(neon(databaseUrl), { schema });

export type Db = ReturnType<typeof createDb>;

/** Any Postgres Drizzle handle with the composed schema (Neon in the app, PGlite in tests). */
export type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbPing {
  latencyMs: number;
  /** Rows in drizzle.__drizzle_migrations; 0 when migrations never ran. */
  migrationsApplied: number;
}

/** Round-trips the database and counts applied migrations. Throws on any failure. */
export const pingDb = async (db: AnyDb, now: () => number = Date.now): Promise<DbPing> => {
  const started = now();
  // Two statements: Postgres resolves relation names at plan time, so a CASE guard
  // around a missing drizzle.__drizzle_migrations would still fail.
  const [present] = rowsOf<{ present: boolean }>(
    await db.execute(
      sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
    ),
  );
  let applied = 0;
  if (present?.present) {
    const [row] = rowsOf<{ applied: number }>(
      await db.execute(sql`select count(*)::int as applied from drizzle.__drizzle_migrations`),
    );
    applied = Number(row?.applied ?? 0);
  }
  return { latencyMs: now() - started, migrationsApplied: applied };
};

// neon-http and PGlite both return `{ rows }`; keep the accessor in one place.
const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;
