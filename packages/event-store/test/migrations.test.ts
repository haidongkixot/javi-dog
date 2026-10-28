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

const ALL_TABLES = [
  'accounts',
  'events',
  'ingest_rate_windows',
  'ingest_tokens',
  'invitations',
  'projects',
  'sessions',
  'users',
  'verifications',
  'workspace_members',
  'workspaces',
];

describe('migrations 0000–0004', () => {
  it('creates the JD-M04, JD-M03 and JD-M06 tables and records every migration', async () => {
    const { client, db } = await freshDb();
    expect(await publicTables(client)).toEqual(ALL_TABLES);
    expect((await pingDb(db)).migrationsApplied).toBe(5);
  });

  it('rolls back with the committed down SQL (newest first) and re-applies cleanly', async () => {
    const { client, db } = await freshDb();
    const index = `select 1 from pg_indexes where indexname = 'events_workspace_received_idx'`;
    expect((await client.query(index)).rows).toHaveLength(1);
    await client.exec(rollbackSql('0004'));
    expect((await client.query(index)).rows).toHaveLength(0);
    expect((await pingDb(db)).migrationsApplied).toBe(4);
    await client.exec(rollbackSql('0003'));
    expect((await pingDb(db)).migrationsApplied).toBe(3);
    const check = await client.query(
      `select 1 from pg_constraint where conname = 'events_event_id_canonical_check'`,
    );
    expect(check.rows).toHaveLength(0);
    await client.exec(rollbackSql('0002'));
    expect(await publicTables(client)).not.toContain('events');
    expect((await pingDb(db)).migrationsApplied).toBe(2);
    await client.exec(rollbackSql('0001'));
    expect(await publicTables(client)).toEqual(['ingest_tokens', 'projects', 'workspaces']);
    expect((await pingDb(db)).migrationsApplied).toBe(1);
    await client.exec(rollbackSql('0000'));
    expect(await publicTables(client)).toEqual([]);
    expect((await pingDb(db)).migrationsApplied).toBe(0);
    await migrate(db, { migrationsFolder });
    expect(await publicTables(client)).toEqual(ALL_TABLES);
    expect((await client.query(index)).rows).toHaveLength(1);
  });

  it('reports 0 applied migrations on an empty database', async () => {
    const { client, db } = await freshDb();
    await client.exec('drop schema drizzle cascade');
    expect((await pingDb(db)).migrationsApplied).toBe(0);
  });

  it('0003 refuses to apply while non-canonical ids exist (why the pre-check matters)', async () => {
    const { client, db } = await freshDb();
    await client.exec(rollbackSql('0004'));
    await client.exec(rollbackSql('0003'));
    await client.exec(`insert into workspaces (name, slug) values ('W', 'w')`);
    await client.exec(
      `insert into projects (workspace_id, name, slug, platforms) select id, 'P', 'p', '{claude-code}' from workspaces`,
    );
    await client.exec(
      `insert into events (project_id, workspace_id, producer_id, event_id, thread_ref, sequence, type, privacy_class, occurred_at)
       select id, workspace_id, 'p', '01jbz4xq800000000000000001', 's', 1, 'heartbeat', 'L0', now() from projects`,
    );
    await expect(migrate(db, { migrationsFolder })).rejects.toThrow();
  });
});
