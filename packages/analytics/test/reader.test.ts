import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalyticsReader, type UsageAnalytics, type UsageDay } from '../src/index.ts';
import { ago, DAY, freshDb, MIN, SEC, seeder, type Scope } from './helpers.ts';

// Real migrations incl. 0004 on PGlite (TEST_PLAN S4b). The clock is pinned unless a test is
// about the database clock. 14 days ending 2026-10-20 → from 2026-10-07.
const NOW = new Date('2026-10-20T12:00:00.000Z');
const FROM_START = new Date('2026-10-07T00:00:00.000Z');

let ctx: Awaited<ReturnType<typeof freshDb>>;
let seed: ReturnType<typeof seeder>;
let reader: ReturnType<typeof createAnalyticsReader>;

beforeAll(async () => {
  ctx = await freshDb();
  seed = seeder(ctx.db);
  reader = createAnalyticsReader(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, ingest_rate_windows cascade');
});
afterEach(() => {
  vi.restoreAllMocks();
});

const at = (iso: string) => new Date(iso);

const oneProject = async (team = 'Signal team', name = 'Web App', slug = 'web-app') => {
  const ws = await seed.workspace(team);
  return seed.project(ws, name, slug);
};

const usage = (
  s: Scope | string,
  opts: Parameters<ReturnType<typeof createAnalyticsReader>['usage']>[1] = {},
): Promise<UsageAnalytics> =>
  reader.usage(typeof s === 'string' ? s : s.workspaceId, { now: NOW, ...opts });

const dayOf = (a: UsageAnalytics, date: string): UsageDay => {
  const d = a.days.find((x) => x.date === date);
  if (!d) throw new Error(`day ${date} missing`);
  return d;
};

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
  reports: 0,
  estimatedReports: 0,
};
const ZERO_DAY = { ...ZERO, tasksCompleted: 0, tasksFailed: 0 };

/** Consecutive UTC dates `from`…`to` inclusive. */
const dateRange = (from: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00.000Z`) + i * DAY).toISOString().slice(0, 10),
  );

describe('shape and empty workspace', () => {
  it('returns a complete all-zero result with 14 zero-filled UTC days by default', async () => {
    const ws = await seed.workspace('Empty team');
    const a = await usage(ws);
    expect(a).toEqual({
      generatedAt: NOW.toISOString(),
      from: '2026-10-07',
      to: '2026-10-20',
      days: dateRange('2026-10-07', 14).map((date) => ({ date, ...ZERO_DAY })),
      byModel: [],
      byProject: [],
      totals: ZERO_DAY,
      lastReportAt: null,
    });
  });
});

describe('UTC day bucketing', () => {
  it('puts 23:59:59.999 and 00:00:00.000 of the next day on different dates', async () => {
    const p = await oneProject();
    await seed.usage(p, at('2026-10-18T23:59:59.999Z'), { input_tokens: 10 });
    await seed.usage(p, at('2026-10-19T00:00:00.000Z'), { input_tokens: 20 });
    const a = await usage(p);
    expect(dayOf(a, '2026-10-18')).toMatchObject({ inputTokens: 10, reports: 1 });
    expect(dayOf(a, '2026-10-19')).toMatchObject({ inputTokens: 20, reports: 1 });
    expect(a.totals).toMatchObject({ inputTokens: 30, reports: 2 });
  });

  it('buckets by received time, not occurred time', async () => {
    const p = await oneProject();
    await seed.event(p, {
      type: 'usage.reported',
      occurredAt: at('2026-10-18T23:59:00.000Z'),
      receivedAt: at('2026-10-19T00:00:30.000Z'),
      usageDelta: { output_tokens: 7 },
    });
    const a = await usage(p);
    expect(dayOf(a, '2026-10-18').reports).toBe(0);
    expect(dayOf(a, '2026-10-19')).toMatchObject({ outputTokens: 7, reports: 1 });
  });

  it('ends the range at now: an event at now counts, one 1 ms later does not', async () => {
    const p = await oneProject();
    const midnight = at('2026-10-20T00:00:00.000Z');
    await seed.usage(p, midnight, { input_tokens: 1 });
    await seed.usage(p, new Date(midnight.getTime() + 1), { input_tokens: 100 });
    const a = await usage(p, { now: midnight, days: 2 });
    expect(a.from).toBe('2026-10-19');
    expect(a.to).toBe('2026-10-20');
    expect(dayOf(a, '2026-10-20')).toMatchObject({ inputTokens: 1, reports: 1 });
    expect(a.lastReportAt).toBe(midnight.toISOString());
  });

  it('uses the UTC date of now as the last day, also one ms before midnight', async () => {
    const ws = await seed.workspace('Late team');
    const a = await usage(ws, { now: at('2026-10-20T23:59:59.999Z'), days: 3 });
    expect(a.days.map((d) => d.date)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
  });
});

describe('range length, zero-fill and clamp', () => {
  it.each([
    [1, '2026-10-20'],
    [14, '2026-10-07'],
    [30, '2026-09-21'],
  ])('days=%i gives exactly that many consecutive dates, oldest first', async (days, from) => {
    const p = await oneProject();
    await seed.usage(p, at('2026-10-20T01:00:00.000Z'), { input_tokens: 5 });
    const a = await usage(p, { days });
    expect(a.days).toHaveLength(days);
    expect(a.from).toBe(from);
    expect(a.to).toBe('2026-10-20');
    expect(a.days.map((d) => d.date)).toEqual(dateRange(from, days));
    // Only the last day carries data; the rest are zero-filled entries, not omitted.
    expect(a.days.slice(0, -1).every((d) => d.reports === 0 && d.inputTokens === 0)).toBe(true);
    expect(a.days.at(-1)).toMatchObject({ inputTokens: 5, reports: 1 });
  });

  it.each([
    [0, 1],
    [-3, 1],
    [45, 30],
    [7.6, 8],
    [7.4, 7],
    [undefined, 14],
    [Number.NaN, 14],
  ])('clamps days=%s to %i', async (days, expected) => {
    const ws = await seed.workspace('Clamp team');
    const a = await usage(ws, days === undefined ? {} : { days });
    expect(a.days).toHaveLength(expected);
    expect(a.to).toBe('2026-10-20');
    const from = new Date(Date.parse('2026-10-20T00:00:00.000Z') - (expected - 1) * DAY)
      .toISOString()
      .slice(0, 10);
    expect(a.from).toBe(from);
    expect(a.days.map((d) => d.date)).toEqual(dateRange(from, expected));
  });

  it('excludes an event 1 ms before the first day and includes one at 00:00:00.000', async () => {
    const p = await oneProject();
    await seed.usage(p, ago(FROM_START, 1), { input_tokens: 1000, cost_usd: 9 });
    await seed.usage(p, FROM_START, { input_tokens: 3 });
    await seed.task(p, ago(FROM_START, 1), 'completed');
    const a = await usage(p);
    expect(a.from).toBe('2026-10-07');
    expect(dayOf(a, '2026-10-07')).toMatchObject({ inputTokens: 3, reports: 1 });
    expect(a.totals).toEqual({ ...ZERO_DAY, inputTokens: 3, reports: 1 });
    expect(a.byModel).toEqual([{ model: null, ...ZERO, inputTokens: 3, reports: 1 }]);
    expect(a.byProject).toHaveLength(1);
    expect(a.byProject[0]).toMatchObject({ inputTokens: 3, reports: 1, estimatedCostUsd: 0 });
  });
});

describe('sums', () => {
  it('sums all four token counters, cost and reports per day and in total', async () => {
    const p = await oneProject();
    const d1 = at('2026-10-19T08:00:00.000Z');
    const d2 = at('2026-10-20T08:00:00.000Z');
    await seed.usage(p, d1, {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 1000,
      cache_write_tokens: 200,
      cost_usd: 0.1,
      model: 'claude-opus',
    });
    await seed.usage(p, d1, {
      input_tokens: 3_000_000_000,
      output_tokens: 2,
      cache_read_tokens: 1,
      cache_write_tokens: 1,
      cost_usd: 0.2,
    });
    await seed.usage(p, d2, { input_tokens: 2_000_000_000, cost_usd: 0.0000004 });
    await seed.usage(p, d2, { output_tokens: 1, cost_usd: 0.0000004 });
    const a = await usage(p);

    expect(dayOf(a, '2026-10-19')).toEqual({
      date: '2026-10-19',
      inputTokens: 3_000_000_100,
      outputTokens: 42,
      cacheReadTokens: 1001,
      cacheWriteTokens: 201,
      estimatedCostUsd: 0.3, // not 0.30000000000000004
      reports: 2,
      estimatedReports: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
    });
    // 0.0000008 rounds to 6 decimals.
    expect(dayOf(a, '2026-10-20')).toMatchObject({
      inputTokens: 2_000_000_000,
      outputTokens: 1,
      estimatedCostUsd: 0.000001,
      reports: 2,
    });
    expect(a.totals).toEqual({
      inputTokens: 5_000_000_100,
      outputTokens: 43,
      cacheReadTokens: 1001,
      cacheWriteTokens: 201,
      // Rounded once from the exact range sum 0.3000008.
      estimatedCostUsd: 0.300001,
      reports: 4,
      estimatedReports: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
    });
    expect(a.lastReportAt).toBe(d2.toISOString());
  });

  it('counts missing or non-numeric counters as 0 but still counts the report', async () => {
    const p = await oneProject();
    const t = at('2026-10-20T09:00:00.000Z');
    await seed.usage(p, t, {
      input_tokens: '12',
      output_tokens: null,
      cache_read_tokens: { n: 1 },
      cache_write_tokens: [3],
      cost_usd: 'free',
    });
    await seed.usage(p, t, { cost_usd: 0.25 });
    await seed.event(p, { type: 'usage.reported', receivedAt: t, usageDelta: null });
    const a = await usage(p);
    expect(a.totals).toEqual({ ...ZERO_DAY, estimatedCostUsd: 0.25, reports: 3 });
    expect(a.byModel).toEqual([{ model: null, ...ZERO, estimatedCostUsd: 0.25, reports: 3 }]);
  });

  it('ignores usage on non-usage events and they never set lastReportAt', async () => {
    const p = await oneProject();
    const report = at('2026-10-20T07:00:00.000Z');
    await seed.usage(p, report, { input_tokens: 10, model: 'm' });
    const later = at('2026-10-20T11:00:00.000Z');
    const delta = { input_tokens: 999, output_tokens: 999, cost_usd: 9.99, model: 'ghost' };
    for (const type of ['heartbeat', 'task.completed', 'session.started', 'usage.estimated']) {
      await seed.event(p, { type, receivedAt: later, usageDelta: delta });
    }
    const a = await usage(p);
    expect(a.totals).toMatchObject({ inputTokens: 10, outputTokens: 0, reports: 1 });
    expect(a.totals.estimatedCostUsd).toBe(0);
    expect(a.totals.tasksCompleted).toBe(1);
    expect(a.byModel.map((m) => m.model)).toEqual(['m']);
    expect(a.lastReportAt).toBe(report.toISOString());
  });
});

describe('task outcomes', () => {
  it('counts task.completed and task.failed per UTC day and in total', async () => {
    const p = await oneProject();
    await seed.task(p, at('2026-10-18T23:59:59.999Z'), 'completed');
    await seed.task(p, at('2026-10-19T00:00:00.000Z'), 'completed');
    await seed.task(p, at('2026-10-19T10:00:00.000Z'), 'completed');
    await seed.task(p, at('2026-10-19T11:00:00.000Z'), 'failed');
    await seed.task(p, at('2026-10-20T11:00:00.000Z'), 'failed');
    await seed.event(p, { type: 'task.started', receivedAt: at('2026-10-20T11:00:00.000Z') });
    const a = await usage(p);
    expect(dayOf(a, '2026-10-18')).toMatchObject({ tasksCompleted: 1, tasksFailed: 0 });
    expect(dayOf(a, '2026-10-19')).toMatchObject({ tasksCompleted: 2, tasksFailed: 1 });
    expect(dayOf(a, '2026-10-20')).toMatchObject({ tasksCompleted: 0, tasksFailed: 1 });
    expect(a.totals).toEqual({ ...ZERO_DAY, tasksCompleted: 3, tasksFailed: 2 });
    // Tasks alone are not usage.
    expect(a.byModel).toEqual([]);
    expect(a.byProject).toEqual([]);
    expect(a.lastReportAt).toBeNull();
  });
});

describe('by model', () => {
  it('groups by usage_delta.model incl. a null bucket; sorts by tokens, then name, null last', async () => {
    const p = await oneProject();
    const t = at('2026-10-20T06:00:00.000Z');
    await seed.usage(p, t, { input_tokens: 400, output_tokens: 100, model: 'claude-haiku' });
    await seed.usage(p, t, { input_tokens: 100, output_tokens: 50, model: 'claude-opus' });
    await seed.usage(p, t, { input_tokens: 75, output_tokens: 75, model: 'a-model' });
    await seed.usage(p, t, { input_tokens: 5, cost_usd: 0.5 });
    await seed.usage(p, t, { output_tokens: 5, cost_usd: 0.25, cache_read_tokens: 9 });
    await seed.usage(p, t, { input_tokens: 10, model: 'z-model' });
    await seed.usage(p, t, { input_tokens: 1, output_tokens: 1, model: 'claude-opus' });
    const a = await usage(p);
    expect(a.byModel).toEqual([
      { model: 'claude-haiku', ...ZERO, inputTokens: 400, outputTokens: 100, reports: 1 },
      { model: 'claude-opus', ...ZERO, inputTokens: 101, outputTokens: 51, reports: 2 },
      { model: 'a-model', ...ZERO, inputTokens: 75, outputTokens: 75, reports: 1 },
      { model: 'z-model', ...ZERO, inputTokens: 10, reports: 1 },
      {
        model: null,
        ...ZERO,
        inputTokens: 5,
        outputTokens: 5,
        cacheReadTokens: 9,
        estimatedCostUsd: 0.75,
        reports: 2,
      },
    ]);
  });

  it('breaks exact token ties by model name ascending', async () => {
    const p = await oneProject();
    const t = at('2026-10-20T06:00:00.000Z');
    await seed.usage(p, t, { input_tokens: 10, model: 'beta' });
    await seed.usage(p, t, { output_tokens: 10, model: 'alpha' });
    await seed.usage(p, t, { input_tokens: 10 });
    const a = await usage(p);
    expect(a.byModel.map((m) => m.model)).toEqual(['alpha', 'beta', null]);
  });
});

describe('by project', () => {
  it('lists workspace projects with usage, with slug and name, sorted by tokens then slug', async () => {
    const ws = await seed.workspace('Signal team');
    const web = await seed.project(ws, 'Web App', 'web-app');
    const api = await seed.project(ws, 'API', 'api');
    const docs = await seed.project(ws, 'Docs', 'docs');
    const idle = await seed.project(ws, 'Idle', 'idle');
    const t = at('2026-10-20T06:00:00.000Z');
    await seed.usage(web, t, { input_tokens: 10, output_tokens: 10, cost_usd: 0.1 });
    await seed.usage(api, t, { input_tokens: 500 });
    await seed.usage(docs, t, { output_tokens: 20 });
    await seed.task(idle, t, 'completed');
    // Out of range: does not make a project appear.
    await seed.usage(idle, ago(FROM_START, 1), { input_tokens: 10_000 });
    const a = await usage(ws);
    expect(a.byProject).toEqual([
      {
        projectId: api.projectId,
        slug: 'api',
        name: 'API',
        ...ZERO,
        inputTokens: 500,
        reports: 1,
      },
      {
        projectId: docs.projectId,
        slug: 'docs',
        name: 'Docs',
        ...ZERO,
        outputTokens: 20,
        reports: 1,
      },
      {
        projectId: web.projectId,
        slug: 'web-app',
        name: 'Web App',
        ...ZERO,
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostUsd: 0.1,
        reports: 1,
      },
    ]);
    expect(a.totals).toMatchObject({ inputTokens: 510, outputTokens: 30, tasksCompleted: 1 });
  });
});

describe('projectId filter', () => {
  it('restricts every figure to the requested project of the workspace', async () => {
    const ws = await seed.workspace('Signal team');
    const web = await seed.project(ws, 'Web App', 'web-app');
    const api = await seed.project(ws, 'API', 'api');
    const t1 = at('2026-10-19T06:00:00.000Z');
    const t2 = at('2026-10-20T06:00:00.000Z');
    await seed.usage(web, t1, { input_tokens: 10, cost_usd: 0.01, model: 'opus' });
    await seed.task(web, t1, 'completed');
    await seed.usage(api, t2, { input_tokens: 999, cost_usd: 9, model: 'haiku' });
    await seed.task(api, t2, 'failed');

    const a = await usage(ws, { projectId: web.projectId });
    expect(a.totals).toEqual({
      ...ZERO_DAY,
      inputTokens: 10,
      estimatedCostUsd: 0.01,
      reports: 1,
      tasksCompleted: 1,
    });
    expect(dayOf(a, '2026-10-20')).toEqual({ date: '2026-10-20', ...ZERO_DAY });
    expect(a.byModel.map((m) => m.model)).toEqual(['opus']);
    expect(a.byProject.map((x) => x.projectId)).toEqual([web.projectId]);
    expect(a.lastReportAt).toBe(t1.toISOString());
    expect(JSON.stringify(a)).not.toContain(api.projectId);
    expect(JSON.stringify(a)).not.toContain('haiku');
  });

  it('a project with no usage yields zeros and an empty byProject', async () => {
    const ws = await seed.workspace('Signal team');
    const web = await seed.project(ws, 'Web App', 'web-app');
    const api = await seed.project(ws, 'API', 'api');
    await seed.usage(api, at('2026-10-20T06:00:00.000Z'), { input_tokens: 5 });
    const a = await usage(ws, { projectId: web.projectId });
    expect(a.totals).toEqual(ZERO_DAY);
    expect(a.byProject).toEqual([]);
  });

  it('a foreign, unknown or malformed projectId yields the all-zero result, never an error', async () => {
    const mine = await oneProject('Team A', 'Mine', 'mine');
    const theirs = await oneProject('Team B', 'Theirs', 'theirs');
    const t = at('2026-10-20T06:00:00.000Z');
    await seed.usage(mine, t, { input_tokens: 1, model: 'opus' });
    await seed.task(mine, t, 'completed');
    await seed.usage(theirs, t, { input_tokens: 2, model: 'haiku' });
    await seed.task(theirs, t, 'failed');

    const empty: UsageAnalytics = {
      generatedAt: NOW.toISOString(),
      from: '2026-10-07',
      to: '2026-10-20',
      days: dateRange('2026-10-07', 14).map((date) => ({ date, ...ZERO_DAY })),
      byModel: [],
      byProject: [],
      totals: ZERO_DAY,
      lastReportAt: null,
    };
    for (const projectId of [theirs.projectId, randomUUID(), 'not-a-uuid', '']) {
      expect(await usage(mine, { projectId })).toEqual(empty);
    }
  });
});

describe('estimated token counts (JGR usage_delta.estimated)', () => {
  it('counts reports with estimated = true per day, in totals, by model and by project', async () => {
    const ws = await seed.workspace('Signal team');
    const web = await seed.project(ws, 'Web App', 'web-app');
    const api = await seed.project(ws, 'API', 'api');
    const d1 = at('2026-10-19T08:00:00.000Z');
    const d2 = at('2026-10-20T08:00:00.000Z');
    await seed.usage(web, d1, { input_tokens: 10, model: 'opus', estimated: true });
    await seed.usage(web, d1, { input_tokens: 10, model: 'opus', estimated: false });
    // Absent means exact (the JGR default is false).
    await seed.usage(web, d2, { input_tokens: 10, model: 'haiku' });
    await seed.usage(api, d2, { input_tokens: 100, model: 'haiku', estimated: true });
    // Only the JSON boolean true counts; a string is not the flag.
    await seed.usage(api, d2, { input_tokens: 1, estimated: 'true' });
    // The flag on a non-usage event is ignored.
    await seed.event(api, { type: 'heartbeat', receivedAt: d2, usageDelta: { estimated: true } });
    const a = await usage(ws);

    expect(dayOf(a, '2026-10-19')).toMatchObject({ reports: 2, estimatedReports: 1 });
    expect(dayOf(a, '2026-10-20')).toMatchObject({ reports: 3, estimatedReports: 1 });
    expect(dayOf(a, '2026-10-18')).toMatchObject({ reports: 0, estimatedReports: 0 });
    expect(a.totals).toMatchObject({ reports: 5, estimatedReports: 2 });
    expect(a.byModel.map((m) => [m.model, m.reports, m.estimatedReports])).toEqual([
      ['haiku', 2, 1],
      ['opus', 2, 1],
      [null, 1, 0],
    ]);
    expect(a.byProject.map((p) => [p.slug, p.reports, p.estimatedReports])).toEqual([
      ['api', 2, 1],
      ['web-app', 3, 1],
    ]);
    const sum = (rows: Array<{ estimatedReports: number }>) =>
      rows.reduce((s, r) => s + r.estimatedReports, 0);
    expect(sum(a.days)).toBe(a.totals.estimatedReports);
    expect(sum(a.byModel)).toBe(a.totals.estimatedReports);
    expect(sum(a.byProject)).toBe(a.totals.estimatedReports);
  });

  it('a project filter narrows the estimated count too', async () => {
    const ws = await seed.workspace('Signal team');
    const web = await seed.project(ws, 'Web App', 'web-app');
    const api = await seed.project(ws, 'API', 'api');
    const t = at('2026-10-20T08:00:00.000Z');
    await seed.usage(web, t, { input_tokens: 1, estimated: true });
    await seed.usage(api, t, { input_tokens: 1, estimated: true });
    await seed.usage(api, t, { input_tokens: 1, estimated: true });
    const a = await usage(ws, { projectId: web.projectId });
    expect(a.totals).toMatchObject({ reports: 1, estimatedReports: 1 });
  });
});

describe('include.byProject', () => {
  it('false skips the by-project query and returns an empty byProject; default includes it', async () => {
    const p = await oneProject();
    await seed.usage(p, ago(NOW, 5 * MIN), { input_tokens: 7 });
    const spy = vi.spyOn(ctx.db, 'execute');
    const a = await usage(p, { include: { byProject: false } });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(a.byProject).toEqual([]);
    expect(a.totals).toMatchObject({ inputTokens: 7, reports: 1 });
    expect(a.byModel).toHaveLength(1);
    spy.mockClear();
    const b = await usage(p);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(b.byProject.map((x) => x.inputTokens)).toEqual([7]);
    expect(await usage(p, { include: { byProject: true } })).toEqual(b);
  });
});

describe('workspace isolation', () => {
  it('never returns another workspace’s projects, models, numbers or times', async () => {
    const a1 = await oneProject('Team A', 'Alpha App', 'alpha-app');
    const b1 = await oneProject('Team B', 'Bravo Secret', 'bravo-secret');
    const b2 = await seed.project(b1.workspaceId, 'Bravo Two', 'bravo-two');
    await seed.usage(a1, at('2026-10-19T06:00:00.000Z'), {
      input_tokens: 11,
      output_tokens: 22,
      cost_usd: 0.33,
      model: 'model-a',
    });
    await seed.task(a1, at('2026-10-19T06:00:00.000Z'), 'completed');
    const bTime = at('2026-10-20T07:07:07.007Z');
    await seed.usage(b1, bTime, {
      input_tokens: 777_001,
      output_tokens: 777_002,
      cache_read_tokens: 777_003,
      cache_write_tokens: 777_004,
      cost_usd: 7.770_05,
      model: 'model-bravo',
    });
    await seed.usage(b2, bTime, { input_tokens: 777_006, model: 'model-bravo-2' });
    await seed.task(b1, bTime, 'failed');

    const a = await usage(a1);
    const json = JSON.stringify(a);
    for (const needle of [
      b1.workspaceId,
      b1.projectId,
      b2.projectId,
      'bravo',
      'Bravo',
      '777',
      '7.77',
      bTime.toISOString(),
    ]) {
      expect(json).not.toContain(needle);
    }
    expect(a.totals).toEqual({
      ...ZERO_DAY,
      inputTokens: 11,
      outputTokens: 22,
      estimatedCostUsd: 0.33,
      reports: 1,
      tasksCompleted: 1,
    });
    expect(a.byProject.map((x) => x.slug)).toEqual(['alpha-app']);
    expect(a.byModel.map((x) => x.model)).toEqual(['model-a']);

    // And the other way round.
    const b = await usage(b1);
    expect(b.totals).toMatchObject({ inputTokens: 1_554_007, reports: 2, tasksFailed: 1 });
    expect(JSON.stringify(b)).not.toContain('alpha');
    expect(JSON.stringify(b)).not.toContain('model-a"');
  });
});

describe('clock and query budget', () => {
  it('uses the database clock when no time is pinned', async () => {
    const p = await oneProject();
    const recent = ago(new Date(), 1 * SEC);
    await seed.usage(p, recent, { input_tokens: 4 });
    // Far in the future of any real clock: outside [from, now].
    await seed.usage(p, new Date(Date.now() + 365 * DAY), { input_tokens: 1000 });
    const before = Date.now();
    const a = await reader.usage(p.workspaceId);
    const after = Date.now();

    const generated = Date.parse(a.generatedAt);
    expect(a.generatedAt).toBe(new Date(generated).toISOString());
    // PGlite reads the same host clock; allow generous slack so this never flakes.
    expect(generated).toBeGreaterThanOrEqual(before - 60 * SEC);
    expect(generated).toBeLessThanOrEqual(after + 60 * SEC);
    expect(a.to).toBe(a.generatedAt.slice(0, 10));
    expect(a.days).toHaveLength(14);
    expect(a.totals).toMatchObject({ inputTokens: 4, reports: 1 });
    expect(a.lastReportAt).toBe(recent.toISOString());
  });

  it('issues at most 4 queries (3 with a pinned clock)', async () => {
    const p = await oneProject();
    await seed.usage(p, ago(NOW, 5 * MIN), { input_tokens: 1 });
    const spy = vi.spyOn(ctx.db, 'execute');
    await reader.usage(p.workspaceId, { now: NOW, projectId: p.projectId });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockClear();
    await reader.usage(p.workspaceId);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('rejects an invalid pinned clock', async () => {
    const ws = await seed.workspace('Clock team');
    await expect(reader.usage(ws, { now: new Date(Number.NaN) })).rejects.toThrow(/clock/);
  });
});
