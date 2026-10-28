import { createProjectRepository } from '@javis-dog/projects';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEventRepository, type NewEvent } from '../src/index.ts';
import { freshDb } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let projectsRepo: ReturnType<typeof createProjectRepository>;
let repo: ReturnType<typeof createEventRepository>;

beforeAll(async () => {
  ctx = await freshDb();
  projectsRepo = createProjectRepository(ctx.db);
  repo = createEventRepository(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, ingest_rate_windows cascade');
});

const setup = async (name = 'Signal team') => {
  const ws = await projectsRepo.createWorkspace({ name });
  const p = await projectsRepo.createProject(ws.id, { name: 'Web', platforms: ['claude-code'] });
  return { workspaceId: ws.id, projectId: p.id };
};

const event = (
  scope: { workspaceId: string; projectId: string },
  eventId: string,
  extra: Partial<NewEvent> = {},
): NewEvent => ({
  ...scope,
  producerId: 'prod_a',
  eventId,
  threadRef: 'sess_1',
  sequence: 1,
  type: 'heartbeat',
  status: 'working',
  privacyClass: 'L0',
  occurredAt: new Date('2026-10-23T00:00:00Z'),
  ...extra,
});

const countEvents = async () =>
  (await ctx.client.query<{ n: number }>('select count(*)::int as n from events')).rows[0]!.n;

describe('insertEvents', () => {
  it('stores each (project, producer, event_id) once, across calls and within one call', async () => {
    const s = await setup();
    expect(
      await repo.insertEvents([
        event(s, '01JBZ4XQ800000000000000001'),
        event(s, '01JBZ4XQ800000000000000002'),
        event(s, '01JBZ4XQ800000000000000001'),
      ]),
    ).toBe(2);
    expect(
      await repo.insertEvents([
        event(s, '01JBZ4XQ800000000000000001'),
        event(s, '01JBZ4XQ800000000000000003'),
      ]),
    ).toBe(1);
    expect(await countEvents()).toBe(3);
  });

  it('scopes the dedupe key by project: another tenant cannot pre-claim an id', async () => {
    const a = await setup('A team');
    const b = await setup('B team');
    expect(await repo.insertEvents([event(a, '01JBZ4XQ800000000000000020')])).toBe(1);
    expect(await repo.insertEvents([event(b, '01JBZ4XQ800000000000000020')])).toBe(1);
  });

  it('refuses an event whose project lives in another workspace', async () => {
    const a = await setup('A team');
    const b = await setup('B team');
    await expect(
      repo.insertEvents([event({ projectId: a.projectId, workspaceId: b.workspaceId }, 'x')]),
    ).rejects.toThrow();
    expect(await countEvents()).toBe(0);
  });

  it('cascades project deletion to its events', async () => {
    const s = await setup();
    await repo.insertEvents([event(s, '01JBZ4XQ800000000000000001')]);
    await ctx.client.query('delete from projects where id = $1', [s.projectId]);
    expect(await countEvents()).toBe(0);
  });

  it('returns 0 without a query for an empty list', async () => {
    expect(await repo.insertEvents([])).toBe(0);
  });
});

describe('hitRateWindow', () => {
  it('counts per token and minute and reports the window end', async () => {
    const t = '00000000-0000-4000-8000-000000000001';
    const at = new Date('2026-10-23T10:00:15Z');
    expect(await repo.hitRateWindow(t, at)).toEqual({
      count: 1,
      resetAt: new Date('2026-10-23T10:01:00Z'),
    });
    expect((await repo.hitRateWindow(t, new Date('2026-10-23T10:00:59Z'))).count).toBe(2);
    expect((await repo.hitRateWindow(t, new Date('2026-10-23T10:01:00Z'))).count).toBe(1);
    const other = '00000000-0000-4000-8000-000000000002';
    expect((await repo.hitRateWindow(other, at)).count).toBe(1);
  });

  it('is atomic under concurrent hits', async () => {
    const t = '00000000-0000-4000-8000-000000000003';
    const at = new Date('2026-10-23T11:00:00Z');
    await Promise.all(Array.from({ length: 10 }, () => repo.hitRateWindow(t, at)));
    expect((await repo.hitRateWindow(t, at)).count).toBe(11);
  });
});

describe('purgeEventsBefore', () => {
  it('deletes only events received before the cutoff, and old rate windows', async () => {
    const s = await setup();
    await repo.insertEvents([
      event(s, '01JBZ4XQ800000000000000010', { receivedAt: new Date('2026-09-01T00:00:00Z') }),
      event(s, '01JBZ4XQ800000000000000011', { receivedAt: new Date('2026-10-22T00:00:00Z') }),
    ]);
    const now = new Date('2026-10-23T00:00:00Z');
    await repo.hitRateWindow(
      '00000000-0000-4000-8000-000000000004',
      new Date('2026-10-22T00:00:00Z'),
    );
    await repo.hitRateWindow('00000000-0000-4000-8000-000000000004', now);
    expect(await repo.purgeEventsBefore(new Date('2026-09-23T00:00:00Z'), now)).toEqual({
      deleted: 1,
      batches: 1,
      complete: true,
    });
    const left = await ctx.client.query<{ event_id: string }>('select event_id from events');
    expect(left.rows.map((r) => r.event_id)).toEqual(['01JBZ4XQ800000000000000011']);
    const windows = await ctx.client.query<{ n: number }>(
      'select count(*)::int as n from ingest_rate_windows',
    );
    expect(windows.rows[0]!.n).toBe(1);
  });
});

describe('touchSignal and markTokenUsed', () => {
  it('sets last_signal_at for the scoped project and last_used_at for the token', async () => {
    const s = await setup();
    const { record } = await projectsRepo.issueToken(s.workspaceId, s.projectId, 'cli');
    const at = new Date('2026-10-23T12:00:00Z');
    await repo.touchSignal(s, at);
    await projectsRepo.markTokenUsed(record.id, at);
    expect((await projectsRepo.getProject(s.workspaceId, s.projectId))?.lastSignalAt).toEqual(at);
    expect((await projectsRepo.listTokens(s.workspaceId, s.projectId))[0]?.lastUsedAt).toEqual(at);
  });

  it('does not touch a project when the workspace does not match', async () => {
    const a = await setup('A team');
    const b = await setup('B team');
    await repo.touchSignal({ projectId: a.projectId, workspaceId: b.workspaceId }, new Date());
    expect((await projectsRepo.getProject(a.workspaceId, a.projectId))?.lastSignalAt).toBeNull();
  });
});

describe('S3d hardening', () => {
  const ULID = (n: number) => `01JBZ4XQ80000000000000${String(n).padStart(4, '0')}`;

  it('H1: stores a lower-case ULID once, even when the caller skipped validateEvent', async () => {
    const s = await setup();
    expect(await repo.insertEvents([event(s, ULID(1).toLowerCase())])).toBe(1);
    expect(await repo.insertEvents([event(s, ULID(1))])).toBe(0);
    const ids = await ctx.client.query<{ event_id: string }>('select event_id from events');
    expect(ids.rows).toEqual([{ event_id: ULID(1) }]);
  });

  it('H1: the database refuses a non-canonical id written directly', async () => {
    const s = await setup();
    await expect(
      ctx.client.query(
        `insert into events (project_id, workspace_id, producer_id, event_id, thread_ref, sequence, type, privacy_class, occurred_at)
         values ($1, $2, 'p', $3, 's', 1, 'heartbeat', 'L0', now())`,
        [s.projectId, s.workspaceId, ULID(2).toLowerCase()],
      ),
    ).rejects.toThrow(/events_event_id_canonical_check/);
  });

  it('H5: keeps the first occurrence when rows arrive out of key order', async () => {
    const s = await setup();
    const stored = await repo.insertEvents([
      event(s, ULID(9), { sequence: 9 }),
      event(s, ULID(3), { sequence: 3 }),
      event(s, ULID(9), { sequence: 99 }),
    ]);
    expect(stored).toBe(2);
    const row = await ctx.client.query<{ sequence: string }>(
      `select sequence from events where event_id = $1`,
      [ULID(9)],
    );
    expect(Number(row.rows[0]!.sequence)).toBe(9);
  });

  it('H6: without a pinned time the window comes from the database clock', async () => {
    const t = '00000000-0000-4000-8000-000000000009';
    const a = await repo.hitRateWindow(t);
    const b = await repo.hitRateWindow(t);
    expect(b.count).toBe(a.count + 1);
    expect(a.resetAt.getUTCSeconds()).toBe(0);
    expect(a.resetAt.getUTCMilliseconds()).toBe(0);
  });

  it('H3: purges in bounded batches and reports whether it finished', async () => {
    const s = await setup();
    const old = new Date('2026-09-01T00:00:00Z');
    await repo.insertEvents(
      Array.from({ length: 5 }, (_, i) => event(s, ULID(100 + i), { receivedAt: old })),
    );
    const now = new Date('2026-10-23T00:00:00Z');
    const cutoff = new Date('2026-09-23T00:00:00Z');
    expect(await repo.purgeEventsBefore(cutoff, now, { batchSize: 2 })).toEqual({
      deleted: 5,
      batches: 3,
      complete: true,
    });
    await repo.insertEvents(
      Array.from({ length: 4 }, (_, i) => event(s, ULID(200 + i), { receivedAt: old })),
    );
    let tick = 0;
    const partial = await repo.purgeEventsBefore(cutoff, now, {
      batchSize: 2,
      budgetMs: 1,
      clock: () => (tick += 5),
    });
    expect(partial).toEqual({ deleted: 2, batches: 1, complete: false });
    await expect(repo.purgeEventsBefore(cutoff, now, { batchSize: 0 })).rejects.toThrow(RangeError);
  });

  it('H2: last_signal_at only moves forward', async () => {
    const s = await setup();
    const read = async () =>
      (
        await ctx.client.query<{ at: Date | null }>(
          'select last_signal_at as at from projects where id = $1',
          [s.projectId],
        )
      ).rows[0]!.at;
    const t1 = new Date('2026-10-23T10:00:00Z');
    await repo.touchSignal(s, t1);
    expect(await read()).toEqual(t1);
    await repo.touchSignal(s, new Date('2026-10-23T09:00:00Z'));
    expect(await read()).toEqual(t1);
    const t2 = new Date('2026-10-23T11:00:00Z');
    await repo.touchSignal(s, t2);
    expect(await read()).toEqual(t2);
  });

  it('H2: markTokenUsed writes at most once a minute', async () => {
    const ws = await projectsRepo.createWorkspace({ name: 'Token team' });
    const p = await projectsRepo.createProject(ws.id, { name: 'Web', platforms: ['claude-code'] });
    const { record } = await projectsRepo.issueToken(ws.id, p.id, 'ci');
    const read = async () =>
      (
        await ctx.client.query<{ at: Date | null }>(
          'select last_used_at as at from ingest_tokens where id = $1',
          [record.id],
        )
      ).rows[0]!.at;
    const t0 = new Date('2026-10-23T10:00:00Z');
    await projectsRepo.markTokenUsed(record.id, t0);
    await projectsRepo.markTokenUsed(record.id, new Date('2026-10-23T10:00:30Z'));
    expect(await read()).toEqual(t0);
    const t2 = new Date('2026-10-23T10:01:30Z');
    await projectsRepo.markTokenUsed(record.id, t2);
    expect(await read()).toEqual(t2);
  });
});
