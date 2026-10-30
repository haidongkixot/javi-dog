import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_LIMIT, createDashboardReader, type ThreadState } from '../src/index.ts';
import { ago, freshDb, HOUR, MIN, SEC, seeder, type Scope } from './helpers.ts';

// Real migrations on PGlite (TEST_PLAN S4a). The clock is pinned unless a test is about the DB clock.
const NOW = new Date('2026-10-20T12:00:00.000Z');

let ctx: Awaited<ReturnType<typeof freshDb>>;
let seed: ReturnType<typeof seeder>;
let reader: ReturnType<typeof createDashboardReader>;

beforeAll(async () => {
  ctx = await freshDb();
  seed = seeder(ctx.db);
  reader = createDashboardReader(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, ingest_rate_windows cascade');
});

const oneProject = async (name = 'Signal team') => {
  const ws = await seed.workspace(name);
  return seed.project(ws, 'Web App', 'web-app');
};

const snap = (s: Scope | string) =>
  reader.snapshot(typeof s === 'string' ? s : s.workspaceId, { now: NOW });

const threadOf = (threads: ThreadState[], ref: string) => {
  const t = threads.find((x) => x.threadRef === ref);
  if (!t) throw new Error(`thread ${ref} missing`);
  return t;
};

describe('snapshot shape', () => {
  it('returns an empty but complete snapshot for a workspace without projects', async () => {
    const ws = await seed.workspace('Empty team');
    const s = await snap(ws);
    expect(s).toEqual({
      generatedAt: NOW.toISOString(),
      freshnessWindowMs: 180_000,
      windowHours: 24,
      overview: {
        activeProjects: { value: 0, lastSignalAt: null },
        agentsWorking: { value: 0, lastSignalAt: null },
        tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
        tasksCompleted24h: { value: 0, lastSignalAt: null },
      },
      threads: [],
      activity: [],
      projects: [],
    });
  });
});

describe('thread state', () => {
  it('derives first/last signal, last type, agents, tasks and tokens per (project, thread)', async () => {
    const p = await oneProject();
    const t = 'cc_a';
    await seed.event(p, { threadRef: t, type: 'session.started', receivedAt: ago(NOW, 10 * MIN) });
    await seed.event(p, {
      threadRef: t,
      type: 'heartbeat',
      status: 'working',
      agentRef: 'agent_1',
      receivedAt: ago(NOW, 9 * MIN),
    });
    await seed.event(p, {
      threadRef: t,
      type: 'agent.started',
      status: 'working',
      agentRef: 'agent_2',
      receivedAt: ago(NOW, 8 * MIN),
    });
    await seed.event(p, {
      threadRef: t,
      type: 'heartbeat',
      status: 'working',
      agentRef: 'agent_1',
      receivedAt: ago(NOW, 7 * MIN),
    });
    await seed.event(p, { threadRef: t, type: 'task.completed', receivedAt: ago(NOW, 6 * MIN) });
    await seed.event(p, { threadRef: t, type: 'task.completed', receivedAt: ago(NOW, 5 * MIN) });
    await seed.event(p, { threadRef: t, type: 'task.failed', receivedAt: ago(NOW, 4 * MIN) });
    await seed.event(p, { threadRef: t, type: 'task.started', receivedAt: ago(NOW, 2 * MIN) });
    // Same project, another thread: never merged into cc_a.
    await seed.event(p, { threadRef: 'cc_b', type: 'heartbeat', status: 'idle', receivedAt: NOW });

    const s = await snap(p);
    expect(s.threads).toHaveLength(2);
    expect(threadOf(s.threads, t)).toEqual({
      projectId: p.projectId,
      projectSlug: 'web-app',
      projectName: 'Web App',
      threadRef: t,
      status: 'working',
      statusSource: 'collector',
      statusReason: null,
      lastType: 'task.started',
      firstSignalAt: ago(NOW, 10 * MIN).toISOString(),
      lastSignalAt: ago(NOW, 2 * MIN).toISOString(),
      freshness: 'fresh',
      attention: false,
      needsAttention: false,
      agents: 2,
      tasksCompleted: 2,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('keeps the last non-null status across later status-less events; null if none was sent', async () => {
    const p = await oneProject();
    await seed.event(p, {
      threadRef: 'cc_s',
      type: 'heartbeat',
      status: 'blocked',
      receivedAt: ago(NOW, 3 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_s',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 2 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_s',
      type: 'task.completed',
      receivedAt: ago(NOW, 1 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_s',
      type: 'usage.reported',
      usageDelta: { input_tokens: 1 },
      receivedAt: ago(NOW, 30 * SEC),
    });
    await seed.event(p, {
      threadRef: 'cc_n',
      type: 'session.started',
      receivedAt: ago(NOW, 1 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_n',
      type: 'task.started',
      receivedAt: ago(NOW, 30 * SEC),
    });

    const s = await snap(p);
    const withStatus = threadOf(s.threads, 'cc_s');
    expect(withStatus.status).toBe('working');
    expect(withStatus.lastType).toBe('usage.reported');
    const none = threadOf(s.threads, 'cc_n');
    expect(none.status).toBeNull();
    expect(none.attention).toBe(false);
  });

  it('breaks received_at ties by sequence for the last type and status', async () => {
    const p = await oneProject();
    const at = ago(NOW, 1 * MIN);
    // Same receipt time; the higher sequence is the latest event, whatever the insert order.
    for (const [ref, order] of [
      ['cc_latest_last', [1, 2]],
      ['cc_latest_first', [2, 1]],
    ] as const) {
      for (const sequence of order) {
        await seed.event(p, {
          threadRef: ref,
          sequence,
          ...(sequence === 2
            ? { type: 'session.ended', status: 'completed' }
            : { type: 'heartbeat', status: 'waiting' }),
          receivedAt: at,
        });
      }
    }
    const s = await snap(p);
    for (const ref of ['cc_latest_last', 'cc_latest_first']) {
      expect(threadOf(s.threads, ref)).toMatchObject({
        lastType: 'session.ended',
        status: 'completed',
        freshness: 'ended',
        attention: false,
        needsAttention: false,
      });
    }
  });

  it('sets attention only while the latest status-bearing event is waiting', async () => {
    const p = await oneProject();
    // waiting, then a later working event → no attention.
    await seed.event(p, {
      threadRef: 'cc_resumed',
      type: 'attention.requested',
      status: 'waiting',
      receivedAt: ago(NOW, 2 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_resumed',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 1 * MIN),
    });
    // waiting, then a status-less event → still attention.
    await seed.event(p, {
      threadRef: 'cc_waiting',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 2 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_waiting',
      type: 'attention.requested',
      status: 'waiting',
      receivedAt: ago(NOW, 90 * SEC),
    });
    await seed.event(p, {
      threadRef: 'cc_waiting',
      type: 'task.started',
      receivedAt: ago(NOW, 1 * MIN),
    });
    // waiting, then silent for 5 min → still waiting and attention, but stale (review focus).
    await seed.event(p, {
      threadRef: 'cc_quiet',
      type: 'attention.requested',
      status: 'waiting',
      receivedAt: ago(NOW, 5 * MIN),
    });
    // waiting, then the session ended (status-less) → attention flag stays, but not counted.
    await seed.event(p, {
      threadRef: 'cc_gone',
      type: 'attention.requested',
      status: 'waiting',
      receivedAt: ago(NOW, 3 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_gone',
      type: 'session.ended',
      receivedAt: ago(NOW, 2 * MIN),
    });
    await seed.signal(p, ago(NOW, 1 * MIN));

    const s = await snap(p);
    expect(threadOf(s.threads, 'cc_resumed')).toMatchObject({
      status: 'working',
      attention: false,
      needsAttention: false,
      freshness: 'fresh',
    });
    expect(threadOf(s.threads, 'cc_waiting')).toMatchObject({
      status: 'waiting',
      attention: true,
      needsAttention: true,
      freshness: 'fresh',
    });
    expect(threadOf(s.threads, 'cc_quiet')).toMatchObject({
      status: 'waiting',
      attention: true,
      needsAttention: true,
      freshness: 'stale',
    });
    expect(threadOf(s.threads, 'cc_gone')).toMatchObject({
      status: 'waiting',
      attention: true,
      needsAttention: false,
      freshness: 'ended',
    });
    expect(s.projects[0]).toMatchObject({
      freshness: 'fresh',
      freshThreads: 2,
      attentionThreads: 2,
    });
  });

  it('sums input/output tokens of usage.reported only; missing counters count as 0', async () => {
    const p = await oneProject();
    const u = (usageDelta: Record<string, unknown>, ageMs: number, type = 'usage.reported') =>
      seed.event(p, { threadRef: 'cc_u', type, usageDelta, receivedAt: ago(NOW, ageMs) });
    await u({ input_tokens: 1000, output_tokens: 200, model: 'm' }, 3 * HOUR);
    await u({ input_tokens: 50 }, 2 * HOUR);
    await u({ output_tokens: 7 }, 30 * MIN);
    await u({ cache_read_tokens: 999, cost_usd: 0.5 }, 20 * MIN);
    // Not a usage report: ignored even if it carries a delta.
    await u({ input_tokens: 100_000, output_tokens: 100_000 }, 10 * MIN, 'heartbeat');

    const s = await snap(p);
    const t = threadOf(s.threads, 'cc_u');
    expect(t.inputTokens).toBe(1050);
    expect(t.outputTokens).toBe(207);
  });
});

describe('overview counters', () => {
  it('counts active projects and working agents from fresh threads only', async () => {
    const ws = await seed.workspace('Counter team');
    const a = await seed.project(ws, 'Alpha');
    const b = await seed.project(ws, 'Beta');
    const c = await seed.project(ws, 'Gamma');
    await seed.event(a, {
      threadRef: 'cc_a1',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 30 * SEC),
    });
    await seed.event(a, {
      threadRef: 'cc_a2',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 180 * SEC),
    });
    await seed.event(a, {
      threadRef: 'cc_a3',
      type: 'heartbeat',
      status: 'idle',
      receivedAt: ago(NOW, 10 * SEC),
    });
    await seed.event(b, {
      threadRef: 'cc_b1',
      type: 'attention.requested',
      status: 'waiting',
      receivedAt: ago(NOW, 20 * SEC),
    });
    // Stale working thread and an ended one: neither active nor working.
    await seed.event(c, {
      threadRef: 'cc_c1',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 180 * SEC + 1),
    });
    await seed.event(c, {
      threadRef: 'cc_c2',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 2 * SEC),
    });
    await seed.event(c, {
      threadRef: 'cc_c2',
      type: 'session.ended',
      receivedAt: ago(NOW, 1 * SEC),
    });

    const s = await snap(ws);
    expect(s.overview.activeProjects).toEqual({
      value: 2,
      lastSignalAt: ago(NOW, 10 * SEC).toISOString(),
    });
    expect(s.overview.agentsWorking).toEqual({
      value: 2,
      lastSignalAt: ago(NOW, 30 * SEC).toISOString(),
    });
  });

  it('sums tokens of usage reports received in the last 60 min, with count and newest time', async () => {
    const p = await oneProject();
    const report = (ref: string, ageMs: number, input: number, output: number) =>
      seed.event(p, {
        threadRef: ref,
        type: 'usage.reported',
        usageDelta: { input_tokens: input, output_tokens: output },
        receivedAt: ago(NOW, ageMs),
      });
    await report('cc_1', 60 * MIN, 5000, 5000); // exactly 60 min: outside
    await report('cc_1', 59 * MIN, 100, 10);
    await report('cc_2', 5 * MIN, 20, 2);
    await report('cc_2', 2 * HOUR, 7000, 7000); // in the 24 h window, not in the hour
    await seed.event(p, {
      threadRef: 'cc_2',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 1 * MIN),
    });

    const s = await snap(p);
    expect(s.overview.tokensLastHour).toEqual({
      value: 132,
      reports: 2,
      lastSignalAt: ago(NOW, 5 * MIN).toISOString(),
    });
    expect(threadOf(s.threads, 'cc_2').inputTokens).toBe(7020);
  });

  it('reports no usage as zero reports with no time, not a fake signal', async () => {
    const p = await oneProject();
    await seed.event(p, { type: 'heartbeat', status: 'working', receivedAt: ago(NOW, 1 * MIN) });
    const s = await snap(p);
    expect(s.overview.tokensLastHour).toEqual({ value: 0, reports: 0, lastSignalAt: null });
    expect(s.overview.tasksCompleted24h).toEqual({ value: 0, lastSignalAt: null });
  });

  it('counts task.completed events in the 24 h window across threads and projects', async () => {
    const ws = await seed.workspace('Task team');
    const a = await seed.project(ws, 'Alpha');
    const b = await seed.project(ws, 'Beta');
    await seed.event(a, {
      threadRef: 'cc_1',
      type: 'task.completed',
      receivedAt: ago(NOW, 23 * HOUR),
    });
    await seed.event(a, {
      threadRef: 'cc_2',
      type: 'task.completed',
      receivedAt: ago(NOW, 2 * HOUR),
    });
    await seed.event(b, {
      threadRef: 'cc_1',
      type: 'task.completed',
      receivedAt: ago(NOW, 3 * HOUR),
    });
    await seed.event(b, { threadRef: 'cc_1', type: 'task.failed', receivedAt: ago(NOW, 1 * HOUR) });
    await seed.event(b, {
      threadRef: 'cc_1',
      type: 'task.completed',
      receivedAt: ago(NOW, 25 * HOUR),
    });

    const s = await snap(ws);
    expect(s.overview.tasksCompleted24h).toEqual({
      value: 3,
      lastSignalAt: ago(NOW, 2 * HOUR).toISOString(),
    });
  });
});

describe('activity feed', () => {
  it('lists the 25 newest events, newest first, with tool_name as the only collector attribute', async () => {
    const p = await oneProject();
    for (let i = 0; i < 30; i += 1) {
      await seed.event(p, {
        threadRef: `cc_${i % 3}`,
        type: i % 2 ? 'task.started' : 'heartbeat',
        status: i % 2 ? null : 'working',
        attributes: {
          platform: 'claude-code',
          error_code: 'E_SECRET_SHAPE',
          ...(i % 2 ? { tool_name: `Tool${i}` } : {}),
        },
        receivedAt: ago(NOW, (30 - i) * SEC),
      });
    }

    const s = await snap(p);
    expect(ACTIVITY_LIMIT).toBe(25);
    expect(s.activity).toHaveLength(25);
    // Newest (i = 29, 1 s ago) first; the 5 oldest (i = 0..4) fall off.
    expect(s.activity.map((a) => a.at)).toEqual(
      Array.from({ length: 25 }, (_, k) => ago(NOW, (k + 1) * SEC).toISOString()),
    );
    expect(s.activity[0]).toEqual({
      at: ago(NOW, 1 * SEC).toISOString(),
      projectSlug: 'web-app',
      threadRef: 'cc_2',
      type: 'task.started',
      status: null,
      toolName: 'Tool29',
      statusSource: 'collector',
      statusReason: null,
    });
    expect(s.activity[1]).toMatchObject({ type: 'heartbeat', status: 'working', toolName: null });
    const json = JSON.stringify(s.activity);
    expect(json).not.toContain('claude-code');
    expect(json).not.toContain('E_SECRET_SHAPE');
    for (const item of s.activity) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'at',
          'projectSlug',
          'status',
          'statusReason',
          'statusSource',
          'threadRef',
          'toolName',
          'type',
        ].sort(),
      );
    }
  });

  it('orders events with the same receipt time by sequence, latest first', async () => {
    const p = await oneProject();
    const at = ago(NOW, 1 * MIN);
    // Inserted out of order: sequence decides, not insert order.
    await seed.event(p, { type: 'task.completed', sequence: 3, receivedAt: at });
    await seed.event(p, { type: 'task.started', sequence: 1, receivedAt: at });
    await seed.event(p, { type: 'heartbeat', status: 'working', sequence: 2, receivedAt: at });
    const s = await snap(p);
    expect(s.activity.map((a) => a.type)).toEqual(['task.completed', 'heartbeat', 'task.started']);
  });
});

describe('projects and thread order', () => {
  it('lists every project with never / fresh / stale / ended health', async () => {
    const ws = await seed.workspace('Health team');
    const never = await seed.project(ws, 'Never');
    const fresh = await seed.project(ws, 'Fresh');
    const old = await seed.project(ws, 'Old');
    const stale = await seed.project(ws, 'Stale');
    const ended = await seed.project(ws, 'Ended');
    void never;
    await seed.event(fresh, {
      threadRef: 'cc_f1',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 10 * SEC),
    });
    await seed.event(fresh, {
      threadRef: 'cc_f2',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 20 * MIN),
    });
    await seed.event(fresh, {
      threadRef: 'cc_f3',
      type: 'session.ended',
      receivedAt: ago(NOW, 5 * SEC),
    });
    await seed.signal(fresh, ago(NOW, 5 * SEC));
    await seed.event(old, {
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 30 * HOUR),
    });
    await seed.signal(old, ago(NOW, 30 * HOUR));
    await seed.event(stale, {
      threadRef: 'cc_s1',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 10 * MIN),
    });
    await seed.event(stale, {
      threadRef: 'cc_s2',
      type: 'session.ended',
      receivedAt: ago(NOW, 1 * MIN),
    });
    await seed.signal(stale, ago(NOW, 1 * MIN));
    await seed.event(ended, { type: 'session.ended', receivedAt: ago(NOW, 1 * HOUR) });
    await seed.signal(ended, ago(NOW, 1 * HOUR));

    const s = await snap(ws);
    expect(
      s.projects.map((p) => [
        p.name,
        p.freshness,
        p.freshThreads,
        p.attentionThreads,
        p.lastSignalAt,
      ]),
    ).toEqual([
      ['Never', 'never', 0, 0, null],
      ['Fresh', 'fresh', 1, 0, ago(NOW, 5 * SEC).toISOString()],
      ['Old', 'stale', 0, 0, ago(NOW, 30 * HOUR).toISOString()],
      ['Stale', 'stale', 0, 0, ago(NOW, 1 * MIN).toISOString()],
      ['Ended', 'ended', 0, 0, ago(NOW, 1 * HOUR).toISOString()],
    ]);
    expect(s.projects[0]).toEqual({
      id: never.projectId,
      slug: 'never',
      name: 'Never',
      lastSignalAt: null,
      freshness: 'never',
      freshThreads: 0,
      attentionThreads: 0,
    });
  });

  it('sorts threads: attention first, then fresh → stale → ended, then newest signal', async () => {
    const p = await oneProject();
    const hb = (ref: string, ageMs: number, status: 'working' | 'waiting' = 'working') =>
      seed.event(p, { threadRef: ref, type: 'heartbeat', status, receivedAt: ago(NOW, ageMs) });
    await hb('cc_fresh_old', 2 * MIN);
    await hb('cc_fresh_new', 1 * MIN);
    await hb('cc_stale_new', 4 * MIN);
    await hb('cc_stale_old', 9 * MIN);
    await hb('cc_wait_stale', 10 * MIN, 'waiting');
    await hb('cc_wait_fresh', 3 * MIN, 'waiting');
    await hb('cc_ended', 30 * SEC, 'waiting');
    await seed.event(p, {
      threadRef: 'cc_ended',
      type: 'session.ended',
      receivedAt: ago(NOW, 20 * SEC),
    });

    const s = await snap(p);
    expect(s.threads.map((t) => t.threadRef)).toEqual([
      'cc_wait_fresh',
      'cc_wait_stale',
      'cc_fresh_new',
      'cc_fresh_old',
      'cc_stale_new',
      'cc_stale_old',
      'cc_ended',
    ]);
  });
});

describe('window and clock', () => {
  it('includes events received after now − 24 h and excludes the boundary, older and later ones', async () => {
    const p = await oneProject();
    await seed.event(p, {
      threadRef: 'cc_edge',
      type: 'task.completed',
      receivedAt: ago(NOW, 24 * HOUR),
    });
    await seed.event(p, {
      threadRef: 'cc_old',
      type: 'task.completed',
      receivedAt: ago(NOW, 25 * HOUR),
    });
    await seed.event(p, {
      threadRef: 'cc_in',
      type: 'task.completed',
      receivedAt: ago(NOW, 24 * HOUR - 1),
    });
    // Received after the snapshot clock: not part of this snapshot.
    await seed.event(p, {
      threadRef: 'cc_future',
      type: 'task.completed',
      receivedAt: ago(NOW, -1),
    });

    const s = await snap(p);
    expect(s.threads.map((t) => t.threadRef)).toEqual(['cc_in']);
    expect(s.activity.map((a) => a.threadRef)).toEqual(['cc_in']);
    expect(s.overview.tasksCompleted24h.value).toBe(1);
    expect(threadOf(s.threads, 'cc_in').freshness).toBe('stale');
  });

  it('uses the database clock when no time is pinned', async () => {
    const p = await oneProject();
    await seed.event(
      p,
      { threadRef: 'cc_now', type: 'heartbeat', status: 'working' },
      { dbClock: true },
    );
    await seed.event(p, {
      threadRef: 'cc_10min',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(new Date(), 10 * MIN),
    });
    const before = Date.now();
    const s = await reader.snapshot(p.workspaceId);
    const after = Date.now();

    const generated = Date.parse(s.generatedAt);
    expect(s.generatedAt).toBe(new Date(generated).toISOString());
    // PGlite reads the same host clock; allow generous slack so this never flakes.
    expect(generated).toBeGreaterThanOrEqual(before - 60 * SEC);
    expect(generated).toBeLessThanOrEqual(after + 60 * SEC);
    expect(threadOf(s.threads, 'cc_now').freshness).toBe('fresh');
    expect(threadOf(s.threads, 'cc_10min').freshness).toBe('stale');
    expect(Date.parse(threadOf(s.threads, 'cc_now').lastSignalAt)).toBeLessThanOrEqual(generated);
  });
});

describe('workspace isolation', () => {
  it('never returns another workspace’s projects, threads, refs or counts', async () => {
    const wsA = await seed.workspace('Team A');
    const wsB = await seed.workspace('Team A2');
    const a = await seed.project(wsA, 'Web App', 'web-app');
    const b = await seed.project(wsB, 'Web App B', 'web-app-b');
    // B mirrors A's refs and adds its own; it is busier and fresher in every respect.
    await seed.event(a, {
      threadRef: 'cc_shared',
      agentRef: 'agent_1',
      type: 'heartbeat',
      status: 'working',
      receivedAt: ago(NOW, 1 * MIN),
    });
    await seed.event(a, {
      threadRef: 'cc_shared',
      type: 'usage.reported',
      usageDelta: { input_tokens: 10, output_tokens: 1 },
      receivedAt: ago(NOW, 50 * SEC),
    });
    await seed.signal(a, ago(NOW, 50 * SEC));
    await seed.event(b, {
      threadRef: 'cc_shared',
      agentRef: 'agent_2',
      type: 'attention.requested',
      status: 'waiting',
      receivedAt: ago(NOW, 5 * SEC),
    });
    await seed.event(b, {
      threadRef: 'cc_shared',
      type: 'usage.reported',
      usageDelta: { input_tokens: 9000, output_tokens: 900 },
      receivedAt: ago(NOW, 4 * SEC),
    });
    await seed.event(b, {
      threadRef: 'cc_only_b_9f2',
      agentRef: 'agent_only_b',
      type: 'task.completed',
      attributes: { tool_name: 'ToolOnlyB' },
      receivedAt: ago(NOW, 3 * SEC),
    });
    await seed.signal(b, ago(NOW, 3 * SEC));

    const s = await snap(wsA);
    const json = JSON.stringify(s);
    for (const leak of [wsB, b.projectId, 'web-app-b', 'Web App B', 'cc_only_b_9f2', 'ToolOnlyB']) {
      expect(json).not.toContain(leak);
    }
    expect(s.projects.map((p) => p.id)).toEqual([a.projectId]);
    expect(s.threads).toHaveLength(1);
    expect(s.threads[0]).toMatchObject({
      projectId: a.projectId,
      status: 'working',
      attention: false,
      agents: 1,
      inputTokens: 10,
      outputTokens: 1,
    });
    expect(s.activity).toHaveLength(2);
    expect(s.overview.tokensLastHour).toEqual({
      value: 11,
      reports: 1,
      lastSignalAt: ago(NOW, 50 * SEC).toISOString(),
    });
    expect(s.overview.tasksCompleted24h.value).toBe(0);
    expect(s.overview.activeProjects.lastSignalAt).toBe(ago(NOW, 50 * SEC).toISOString());

    // And the other way round.
    const sb = JSON.stringify(await snap(wsB));
    expect(sb).not.toContain(a.projectId);
    expect(sb).not.toContain(wsA);
    expect(sb).not.toContain('"web-app"');
  });

  it('returns nothing for a workspace id that has no rows', async () => {
    const p = await oneProject();
    await seed.event(p, { type: 'heartbeat', status: 'working', receivedAt: ago(NOW, 1 * MIN) });
    const s = await snap('00000000-0000-4000-8000-000000000000');
    expect(s.threads).toEqual([]);
    expect(s.activity).toEqual([]);
    expect(s.projects).toEqual([]);
  });
});
