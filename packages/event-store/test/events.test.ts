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
    expect(await repo.insertEvents([event(s, 'e1'), event(s, 'e2'), event(s, 'e1')])).toBe(2);
    expect(await repo.insertEvents([event(s, 'e1'), event(s, 'e3')])).toBe(1);
    expect(await countEvents()).toBe(3);
  });

  it('scopes the dedupe key by project: another tenant cannot pre-claim an id', async () => {
    const a = await setup('A team');
    const b = await setup('B team');
    expect(await repo.insertEvents([event(a, 'same')])).toBe(1);
    expect(await repo.insertEvents([event(b, 'same')])).toBe(1);
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
    await repo.insertEvents([event(s, 'e1')]);
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
      event(s, 'old', { receivedAt: new Date('2026-09-01T00:00:00Z') }),
      event(s, 'new', { receivedAt: new Date('2026-10-22T00:00:00Z') }),
    ]);
    const now = new Date('2026-10-23T00:00:00Z');
    await repo.hitRateWindow(
      '00000000-0000-4000-8000-000000000004',
      new Date('2026-10-22T00:00:00Z'),
    );
    await repo.hitRateWindow('00000000-0000-4000-8000-000000000004', now);
    expect(await repo.purgeEventsBefore(new Date('2026-09-23T00:00:00Z'), now)).toBe(1);
    const left = await ctx.client.query<{ event_id: string }>('select event_id from events');
    expect(left.rows.map((r) => r.event_id)).toEqual(['new']);
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
