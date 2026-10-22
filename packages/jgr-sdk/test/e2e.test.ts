import { PGlite } from '@electric-sql/pglite';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';
import { createProjectRepository } from '@javis-dog/projects';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { createJgrClient } from '../src/index.ts';

// SDK → real JD-M05 handler → JD-M06 tables on PGlite (TEST_PLAN S3b).
describe('SDK against the real ingest handler', () => {
  it('delivers once, survives a retry and lets the receiver dedupe a resend', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: getMigrationsFolder() });
    const projects = createProjectRepository(db);
    const ws = await projects.createWorkspace({ name: 'SDK team' });
    const p = await projects.createProject(ws.id, { name: 'Web App', platforms: ['claude-code'] });
    const { token } = await projects.issueToken(ws.id, p.id, 'sdk');

    const handler = createIngestHandler(createIngestDeps(db));
    let failNext = true;
    const sdk = createJgrClient({
      endpoint: 'https://javisdog.test/api/v1/events',
      token,
      producerId: 'prod_sdk',
      sleep: async () => {},
      fetch: async (url, init) => {
        if (failNext) {
          failNext = false;
          throw new TypeError('fetch failed');
        }
        return handler(new Request(url as string, init));
      },
    });

    for (let i = 0; i < 120; i++) {
      const r = await sdk.record({
        project_ref: 'web-app',
        thread_ref: 'sess_1',
        type: 'heartbeat',
        status: 'working',
      });
      expect(r.ok).toBe(true);
    }
    const first = await sdk.flush();
    expect(first).toMatchObject({ status: 'ok', accepted: 120, duplicates: 0, remaining: 0 });

    // A second producer process re-sending the same events (shared spool race) is harmless.
    const stored = await client.query<{ event_id: string }>('select event_id from events');
    expect(stored.rows).toHaveLength(120);
    const again = createJgrClient({
      endpoint: 'https://javisdog.test/api/v1/events',
      token,
      producerId: 'prod_sdk',
      fetch: async (url, init) => handler(new Request(url as string, init)),
    });
    expect(await sdk.spool.count()).toBe(0);
    const [one] = (
      await client.query<{ event_id: string; sequence: number }>(
        'select event_id, sequence::int from events order by sequence limit 1',
      )
    ).rows;
    await again.spool.append([
      {
        jgr: '0.1',
        event_id: one!.event_id,
        producer_id: 'prod_sdk',
        project_ref: 'web-app',
        thread_ref: 'sess_1',
        sequence: one!.sequence,
        type: 'heartbeat',
        status: 'working',
        occurred_at: new Date().toISOString(),
        privacy_class: 'L0',
      },
    ]);
    expect(await again.flush()).toMatchObject({ status: 'ok', accepted: 0, duplicates: 1 });
    expect((await client.query('select 1 from events')).rows).toHaveLength(120);
  });
});
