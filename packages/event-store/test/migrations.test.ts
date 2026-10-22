import { describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { pingDb } from '../src/index.ts';
import { freshDb, migrationsFolder, rollbackSql } from './helpers.ts';

const publicTables = async (client: Awaited<ReturnType<typeof freshDb>>['client']) =>
  (
    await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    )
  ).rows.map((r) => r.table_name);

describe('migration 0000', () => {
  it('creates the three JD-M04 tables and records itself', async () => {
    const { client, db } = await freshDb();
    expect(await publicTables(client)).toEqual(['ingest_tokens', 'projects', 'workspaces']);
    expect((await pingDb(db)).migrationsApplied).toBe(1);
  });

  it('rolls back with the committed down SQL and re-applies cleanly', async () => {
    const { client, db } = await freshDb();
    await client.exec(rollbackSql());
    expect(await publicTables(client)).toEqual([]);
    expect((await pingDb(db)).migrationsApplied).toBe(0);
    await migrate(db, { migrationsFolder });
    expect(await publicTables(client)).toEqual(['ingest_tokens', 'projects', 'workspaces']);
  });

  it('reports 0 applied migrations on an empty database', async () => {
    const { client, db } = await freshDb();
    await client.exec('drop schema drizzle cascade');
    expect((await pingDb(db)).migrationsApplied).toBe(0);
  });
});
