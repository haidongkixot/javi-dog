import { createJgrClient, createMemorySpool } from '@javis-dog/jgr-sdk';
import { validateEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import { COLLECTOR_VERSION, mapHook } from '../src/index.ts';
import { COST_METRIC, parseOtlpMetrics, TOKEN_METRIC, type UsagePoint } from '../src/otlp.ts';
import {
  toUsageGroups,
  toUsageRecord,
  usageEventId,
  type CumulativeBaselines,
  type UsageGroup,
} from '../src/usage.ts';

const ctx = { projectRef: 'web-app', salt: 'test-salt' };
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T0 = '1761638400000000000'; // 2025-10-28T08:00:00.000Z
const T1 = '1761638460000000000'; // +60 s
const T2 = '1761638520000000000'; // +120 s
const T3 = '1761638580000000000'; // +180 s

const pt = (overrides: Partial<UsagePoint>): UsagePoint => ({
  sessionId: 'sess-1',
  model: 'claude-sonnet-4-5',
  counter: 'input_tokens',
  value: 1,
  startNs: T0,
  endNs: T1,
  temporality: 'delta',
  ...overrides,
});

const cum = (counter: UsagePoint['counter'], value: number, endNs: string, startNs = T0) =>
  pt({ counter, value, startNs, endNs, temporality: 'cumulative' });

const group = (overrides: Partial<UsageGroup> = {}): UsageGroup => ({
  sessionId: 'sess-1',
  model: 'claude-sonnet-4-5',
  startNs: T0,
  endNs: T1,
  delta: { input_tokens: 120, output_tokens: 30, cost_usd: 0.004 },
  ...overrides,
});

describe('toUsageGroups — delta points', () => {
  it('groups by (session, model, start, end) and sums counters', () => {
    const groups = toUsageGroups(
      [
        pt({ counter: 'input_tokens', value: 100 }),
        pt({ counter: 'output_tokens', value: 20 }),
        pt({ counter: 'input_tokens', value: 5 }),
        pt({ counter: 'cost_usd', value: 0.25 }),
        pt({ model: 'claude-haiku-4-5', counter: 'input_tokens', value: 7 }),
        pt({ sessionId: 'sess-2', counter: 'input_tokens', value: 9 }),
        pt({ startNs: T1, endNs: T2, counter: 'cache_read_tokens', value: 11 }),
      ],
      new Map(),
    );
    expect(groups).toEqual([
      {
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-5',
        startNs: T0,
        endNs: T1,
        delta: { input_tokens: 105, output_tokens: 20, cost_usd: 0.25 },
      },
      {
        sessionId: 'sess-1',
        model: 'claude-haiku-4-5',
        startNs: T0,
        endNs: T1,
        delta: { input_tokens: 7 },
      },
      {
        sessionId: 'sess-2',
        model: 'claude-sonnet-4-5',
        startNs: T0,
        endNs: T1,
        delta: { input_tokens: 9 },
      },
      {
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-5',
        startNs: T1,
        endNs: T2,
        delta: { cache_read_tokens: 11 },
      },
    ]);
  });

  it('sums the same group across resourceMetrics and scopeMetrics of one request', () => {
    const dp = (type: string, asInt: string) => ({
      attributes: [
        { key: 'session.id', value: { stringValue: 'sess-1' } },
        { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
        { key: 'type', value: { stringValue: type } },
      ],
      startTimeUnixNano: T0,
      timeUnixNano: T1,
      asInt,
    });
    const scope = (points: unknown[]) => ({
      metrics: [{ name: TOKEN_METRIC, sum: { dataPoints: points, aggregationTemporality: 1 } }],
    });
    const body = {
      resourceMetrics: [
        {
          scopeMetrics: [
            scope([dp('input', '100')]),
            scope([dp('input', '50'), dp('output', '3')]),
          ],
        },
        { scopeMetrics: [scope([dp('cacheCreation', '8')])] },
      ],
    };
    const parsed = parseOtlpMetrics(body);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(toUsageGroups(parsed.points, new Map())).toEqual([
      group({ delta: { input_tokens: 150, output_tokens: 3, cache_write_tokens: 8 } }),
    ]);
  });

  it('drops groups whose counters are all zero', () => {
    const groups = toUsageGroups(
      [
        pt({ counter: 'input_tokens', value: 0 }),
        pt({ counter: 'cost_usd', value: 0 }),
        pt({ sessionId: 'sess-2', counter: 'output_tokens', value: 0 }),
        pt({ sessionId: 'sess-2', counter: 'input_tokens', value: 4 }),
      ],
      new Map(),
    );
    expect(groups).toEqual([
      group({ sessionId: 'sess-2', delta: { output_tokens: 0, input_tokens: 4 } }),
    ]);
  });

  it('leaves the baselines untouched for delta points', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([pt({ value: 3 })], baselines);
    expect(baselines.size).toBe(0);
  });
});

describe('toUsageGroups — cumulative points', () => {
  it('first point only sets the baseline; growth becomes a delta; baseline updates', () => {
    const baselines: CumulativeBaselines = new Map();
    expect(toUsageGroups([cum('input_tokens', 100, T1)], baselines)).toEqual([]);
    expect(baselines.get('sess-1\0claude-sonnet-4-5\0input_tokens')).toEqual({
      startNs: T0,
      value: 100,
    });

    expect(toUsageGroups([cum('input_tokens', 150, T2)], baselines)).toEqual([
      group({ endNs: T2, delta: { input_tokens: 50 } }),
    ]);
    expect(toUsageGroups([cum('input_tokens', 175, T3)], baselines)).toEqual([
      group({ endNs: T3, delta: { input_tokens: 25 } }),
    ]);
  });

  it('unchanged value → zero delta → group dropped', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([cum('output_tokens', 40, T1)], baselines);
    expect(toUsageGroups([cum('output_tokens', 40, T2)], baselines)).toEqual([]);
  });

  it('a smaller value (reset) starts a new baseline without a delta', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([cum('input_tokens', 100, T1)], baselines);
    expect(toUsageGroups([cum('input_tokens', 30, T2)], baselines)).toEqual([]);
    expect(baselines.get('sess-1\0claude-sonnet-4-5\0input_tokens')?.value).toBe(30);
    expect(toUsageGroups([cum('input_tokens', 45, T3)], baselines)).toEqual([
      group({ endNs: T3, delta: { input_tokens: 15 } }),
    ]);
  });

  it('a new startNs starts a new baseline without a delta, even when the value grew', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([cum('input_tokens', 100, T1)], baselines);
    expect(toUsageGroups([cum('input_tokens', 500, T2, T1)], baselines)).toEqual([]);
    expect(baselines.get('sess-1\0claude-sonnet-4-5\0input_tokens')).toEqual({
      startNs: T1,
      value: 500,
    });
    expect(toUsageGroups([cum('input_tokens', 510, T3, T1)], baselines)).toEqual([
      group({ startNs: T1, endNs: T3, delta: { input_tokens: 10 } }),
    ]);
  });

  it('keeps one baseline per (session, model, counter) series', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups(
      [
        cum('input_tokens', 10, T1),
        cum('output_tokens', 5, T1),
        cum('cost_usd', 0.5, T1),
        pt({ sessionId: 'sess-2', counter: 'input_tokens', value: 1, temporality: 'cumulative' }),
      ],
      baselines,
    );
    expect(baselines.size).toBe(4);
    const groups = toUsageGroups(
      [cum('input_tokens', 12, T2), cum('output_tokens', 9, T2), cum('cost_usd', 0.75, T2)],
      baselines,
    );
    expect(groups).toEqual([
      group({ endNs: T2, delta: { input_tokens: 2, output_tokens: 4, cost_usd: 0.25 } }),
    ]);
  });

  it('processes repeated points of one series within a single call in order', () => {
    const baselines: CumulativeBaselines = new Map();
    const groups = toUsageGroups(
      [cum('input_tokens', 10, T1), cum('input_tokens', 25, T2), cum('input_tokens', 40, T3)],
      baselines,
    );
    expect(groups).toEqual([
      group({ endNs: T2, delta: { input_tokens: 15 } }),
      group({ endNs: T3, delta: { input_tokens: 15 } }),
    ]);
  });
});

describe('usageEventId', () => {
  it('is a canonical lowercase version-8 UUID', () => {
    expect(usageEventId(group(), ctx.salt)).toMatch(UUID_V8);
  });

  it('is deterministic for the same group and salt (counters do not matter)', () => {
    const a = usageEventId(group(), ctx.salt);
    expect(usageEventId(group(), ctx.salt)).toBe(a);
    expect(usageEventId(group({ delta: { output_tokens: 1 } }), ctx.salt)).toBe(a);
  });

  it.each<[string, Partial<UsageGroup>]>([
    ['different end', { endNs: T2 }],
    ['different start', { startNs: T1, endNs: T2 }],
    ['different session', { sessionId: 'sess-2' }],
    ['different model', { model: 'claude-haiku-4-5' }],
  ])('changes with a %s', (_name, overrides) => {
    const other = usageEventId(group(overrides), ctx.salt);
    expect(other).toMatch(UUID_V8);
    expect(other).not.toBe(usageEventId(group(), ctx.salt));
  });

  it('changes with the salt', () => {
    expect(usageEventId(group(), 'other-salt')).not.toBe(usageEventId(group(), ctx.salt));
  });

  it('separates key fields unambiguously', () => {
    const a = usageEventId(group({ sessionId: 'ab', model: 'c' }), ctx.salt);
    const b = usageEventId(group({ sessionId: 'a', model: 'bc' }), ctx.salt);
    expect(a).not.toBe(b);
  });

  it('sets the version and variant bits over many inputs', () => {
    for (let i = 0; i < 200; i++) {
      expect(usageEventId(group({ sessionId: `s-${i}` }), ctx.salt)).toMatch(UUID_V8);
    }
  });
});

describe('toUsageRecord', () => {
  it('builds the usage.reported record', () => {
    const g = group();
    expect(toUsageRecord(g, ctx)).toEqual({
      project_ref: 'web-app',
      thread_ref: expect.stringMatching(/^cc_[0-9a-f]{32}$/),
      type: 'usage.reported',
      event_id: usageEventId(g, ctx.salt),
      occurred_at: '2025-10-28T08:01:00.000Z',
      usage_delta: {
        input_tokens: 120,
        output_tokens: 30,
        cost_usd: 0.004,
        model: 'claude-sonnet-4-5',
        estimated: false,
      },
      attributes: { platform: 'claude-code', collector_version: COLLECTOR_VERSION },
    });
  });

  it('truncates sub-millisecond end times to the millisecond', () => {
    const record = toUsageRecord(group({ endNs: '1761638460123999999' }), ctx);
    expect(record.occurred_at).toBe('2025-10-28T08:01:00.123Z');
  });

  it('uses the same thread_ref as the hooks for the same session id', () => {
    const hook = mapHook(
      { session_id: 'sess-1', hook_event_name: 'SessionStart', source: 'startup' },
      ctx,
    );
    expect(hook).not.toBeNull();
    expect(toUsageRecord(group(), ctx).thread_ref).toBe(hook!.thread_ref);
  });

  it('carries no raw session id', () => {
    expect(
      JSON.stringify(toUsageRecord(group({ sessionId: 'raw-session-xyz' }), ctx)),
    ).not.toContain('raw-session-xyz');
  });

  it('passes validateEvent once the SDK fields are filled', () => {
    const record = toUsageRecord(group(), ctx);
    const event = {
      ...record,
      jgr: '0.1',
      producer_id: 'prod_claude-code_0123456789ab',
      sequence: 0,
    };
    const result = validateEvent(event, new Date('2025-10-28T09:00:00Z'));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.event.event_id).toBe(record.event_id);
  });

  it('records through the SDK with the deterministic event_id and end time', async () => {
    const spool = createMemorySpool();
    const client = createJgrClient({
      endpoint: 'http://127.0.0.1:1/unused',
      token: 'unused',
      producerId: 'prod_claude-code_0123456789ab',
      spool,
      now: () => new Date('2025-10-28T09:00:00Z'),
    });
    const record = toUsageRecord(group(), ctx);
    const result = await client.record(record);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      event_id: record.event_id,
      type: 'usage.reported',
      occurred_at: '2025-10-28T08:01:00.000Z',
      thread_ref: record.thread_ref,
      privacy_class: 'L0',
    });
  });

  it('end-to-end: an OTLP request becomes valid records without identity values', () => {
    const attrs = (type?: string) => [
      { key: 'user.email', value: { stringValue: 'hai@example.com' } },
      { key: 'organization.id', value: { stringValue: 'org-secret-1' } },
      { key: 'session.id', value: { stringValue: 'sess-1' } },
      { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
      ...(type ? [{ key: 'type', value: { stringValue: type } }] : []),
    ];
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'user.id', value: { stringValue: 'uid-secret-2' } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: TOKEN_METRIC,
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: attrs('input'),
                        startTimeUnixNano: T0,
                        timeUnixNano: T1,
                        asInt: '120',
                      },
                      {
                        attributes: attrs('output'),
                        startTimeUnixNano: T0,
                        timeUnixNano: T1,
                        asInt: 30,
                      },
                    ],
                  },
                },
                {
                  name: COST_METRIC,
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: attrs(),
                        startTimeUnixNano: T0,
                        timeUnixNano: T1,
                        asDouble: 0.004,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseOtlpMetrics(body);
    if (!parsed.ok) throw new Error(parsed.error);
    const records = toUsageGroups(parsed.points, new Map()).map((g) => toUsageRecord(g, ctx));
    expect(records).toHaveLength(1);
    expect(records[0]!.usage_delta).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      cost_usd: 0.004,
      model: 'claude-sonnet-4-5',
      estimated: false,
    });
    const out = JSON.stringify(records);
    for (const secret of ['hai@example.com', 'org-secret-1', 'uid-secret-2', 'sess-1']) {
      expect(out).not.toContain(secret);
    }
    // A retried export of the same body yields the same event ids.
    const again = parseOtlpMetrics(body);
    if (!again.ok) throw new Error(again.error);
    expect(toUsageGroups(again.points, new Map()).map((g) => usageEventId(g, ctx.salt))).toEqual(
      records.map((r) => r.event_id),
    );
  });
});
