import { createHmac } from 'node:crypto';
import { parseGeminiMetrics, type AdapterUsagePoint } from '@javis-dog/collector-adapters';
import { describe, expect, it } from 'vitest';
import {
  toUsageGroups,
  toUsageRecord,
  usageEventId,
  type CumulativeBaselines,
  type UsageGroup,
} from '../src/index.ts';

// S5b review V1 (ADR-0016 Changes R2–R4, R6) through the real JD-C02 parser: Gemini series
// identity, first export, grouping by export and the auth type that gates cost.
const a = (key: string, value: string) => ({ key, value: { stringValue: value } });
const S = '1000000000';
const S2 = '1001000000';
const geminiBody = (
  points: Array<{ type: string; v: number; start: string; end: string; extra?: object[] }>,
) => ({
  resourceMetrics: [
    {
      resource: { attributes: [a('session.id', 's1')] },
      scopeMetrics: [
        {
          metrics: [
            {
              name: 'gemini_cli.token.usage',
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: points.map((p) => ({
                  attributes: [
                    a('session.id', 's1'),
                    a('model', 'gemini-2.5-pro'),
                    a('type', p.type),
                    ...(p.extra ?? []),
                  ],
                  startTimeUnixNano: p.start,
                  timeUnixNano: p.end,
                  asInt: String(p.v),
                })),
              },
            },
          ],
        },
      ],
    },
  ],
});
const parsed = (body: unknown) => {
  const result = parseGeminiMetrics(body);
  if (!result.ok) throw new Error(result.error);
  return result.points;
};
const run = (
  bodies: unknown[],
  opts?: { receiverStartNs?: string },
  baselines: CumulativeBaselines = new Map(),
) => bodies.map((body) => toUsageGroups(parsed(body), baselines, 'gemini-cli', opts));

describe('Gemini usage review rules (ADR-0016 Changes R2–R4, R6)', () => {
  it('R2: a series that started at or after the receiver counts from 0 on its first export', () => {
    // One-shot `gemini -p`: a single export, every series new.
    const oneShot = geminiBody([
      { type: 'input', v: 12000, start: S, end: '2000000000' },
      { type: 'output', v: 800, start: S, end: '2000000000' },
      { type: 'cache', v: 0, start: S, end: '2000000000' },
      { type: 'thought', v: 300, start: S, end: '2000000000' },
    ]);
    const [groups] = run([oneShot], { receiverStartNs: S }); // started exactly at the boundary
    expect(groups).toHaveLength(1);
    expect(groups![0]!.delta).toEqual({
      input_tokens: 12000,
      output_tokens: 800,
      cache_read_tokens: 0,
      reasoning_tokens: 300,
    });
    // A series older than the receiver may have missed exports: baseline only (ADR-0011).
    expect(run([oneShot], { receiverStartNs: '1000000001' })).toEqual([[]]);
    expect(run([oneShot])).toEqual([[]]);
  });

  it('R3: one group per (session, model, export end), even when series start 1 ms apart', () => {
    const [first, second] = run([
      geminiBody([
        { type: 'input', v: 0, start: S, end: '2000000000' },
        { type: 'cache', v: 0, start: S2, end: '2000000000' },
      ]),
      geminiBody([
        { type: 'input', v: 100000, start: S, end: '3000000000' },
        { type: 'cache', v: 90000, start: S2, end: '3000000000' },
      ]),
    ]);
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(second![0]).toMatchObject({
      sessionId: 's1',
      model: 'gemini-2.5-pro',
      endNs: '3000000000',
      delta: { input_tokens: 100000, cache_read_tokens: 90000 },
    });
    const record = toUsageRecord(second![0]!, { projectRef: 'p', salt: 'salt' });
    expect(record.usage_delta).toMatchObject({ input_tokens: 10000, cache_read_tokens: 90000 });
  });

  it('R4: series that differ only in an identity attribute keep their own baselines', () => {
    const email = [a('user.email', 'x@y.example')];
    const [first, second, third] = run([
      geminiBody([
        { type: 'output', v: 500, start: S, end: '2000000000' },
        { type: 'output', v: 10, start: S2, end: '2000000000', extra: email },
      ]),
      geminiBody([
        { type: 'output', v: 900, start: S, end: '3000000000' },
        { type: 'output', v: 400, start: S2, end: '3000000000', extra: email },
      ]),
      geminiBody([
        { type: 'output', v: 1500, start: S, end: '4000000000' },
        { type: 'output', v: 800, start: S2, end: '4000000000', extra: email },
      ]),
    ]);
    expect(first).toEqual([]);
    expect(second!.map((g) => g.delta)).toEqual([{ output_tokens: 400 + 390 }]);
    expect(third!.map((g) => g.delta)).toEqual([{ output_tokens: 600 + 400 }]);
  });

  it('R4: baselines are keyed by the in-memory series id, never by raw attribute values', () => {
    const baselines: CumulativeBaselines = new Map();
    const body = geminiBody([
      {
        type: 'output',
        v: 5,
        start: S,
        end: '2000000000',
        extra: [a('user.email', 'x@y.example')],
      },
    ]);
    run([body], undefined, baselines);
    const [point] = parsed(body);
    expect([...baselines.keys()]).toEqual([point!.seriesId]);
    expect(JSON.stringify([...baselines])).not.toContain('x@y.example');
  });

  it('R6: different auth types never share a group; only per-token billing gets a cost', () => {
    const vertex = [a('auth_type', 'vertex-ai')];
    const login = [a('auth_type', 'oauth-personal')];
    const [, groups] = run([
      geminiBody([
        { type: 'output', v: 100, start: S, end: '2000000000', extra: vertex },
        { type: 'output', v: 100, start: S, end: '2000000000', extra: login },
      ]),
      geminiBody([
        { type: 'output', v: 1100, start: S, end: '3000000000', extra: vertex },
        { type: 'output', v: 600, start: S, end: '3000000000', extra: login },
      ]),
    ]);
    expect(groups).toHaveLength(2);
    const records = groups!.map((g) => toUsageRecord(g, { projectRef: 'p', salt: 'salt' }));
    const byTokens = Object.fromEntries(
      records.map((r) => [(r.usage_delta as { output_tokens: number }).output_tokens, r]),
    );
    expect(byTokens[1000]!.usage_delta).toEqual({
      output_tokens: 1000,
      cost_usd: 0.01,
      model: 'gemini-2.5-pro',
      estimated: false,
    });
    expect(byTokens[500]!.usage_delta).toEqual({
      output_tokens: 500,
      model: 'gemini-2.5-pro',
      estimated: false,
    });
    expect(records[0]!.event_id).not.toBe(records[1]!.event_id);
    const json = JSON.stringify(records);
    for (const s of ['vertex-ai', 'oauth-personal', 'authType', 'seriesId']) {
      expect(json).not.toContain(s);
    }
  });

  it('R3: usageEventId hashes (session, model, auth type, end) for Gemini; Claude Code is unchanged', () => {
    const gemini: UsageGroup = {
      sessionId: 's1',
      model: 'gemini-2.5-pro',
      startNs: S,
      endNs: '3000000000',
      delta: { output_tokens: 1 },
      platform: 'gemini-cli',
      authType: 'vertex-ai',
    };
    // The start time is not part of a Gemini group's identity; the auth type is.
    expect(usageEventId({ ...gemini, startNs: S2 }, 'salt')).toBe(usageEventId(gemini, 'salt'));
    expect(usageEventId({ ...gemini, authType: 'oauth-personal' }, 'salt')).not.toBe(
      usageEventId(gemini, 'salt'),
    );
    expect(usageEventId({ ...gemini, endNs: '3000000001' }, 'salt')).not.toBe(
      usageEventId(gemini, 'salt'),
    );
    // Claude Code: HMAC over session \0 model \0 start \0 end, exactly as before.
    const claude: UsageGroup = { ...gemini };
    delete claude.platform;
    delete claude.authType;
    const bytes = createHmac('sha256', 'salt')
      .update(`s1\0gemini-2.5-pro\0${S}\0${'3000000000'}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    expect(usageEventId(claude, 'salt')).toBe(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
  });
});

// S5b B2: cumulative baselines for Gemini CLI series (ADR-0011 rules + ADR-0016 Changes, QA
// finding G5: a new series of a known run has an implicit baseline of 0).
const point = (
  counter: AdapterUsagePoint['counter'],
  value: number,
  endNs: string,
  opts: { startNs?: string; sessionId?: string; model?: string } = {},
): AdapterUsagePoint => ({
  sessionId: opts.sessionId ?? 's1',
  model: opts.model ?? 'gemini-2.5-pro',
  counter,
  value,
  startNs: opts.startNs ?? '1000',
  endNs,
  temporality: 'cumulative',
});

describe('toUsageGroups for Gemini CLI (platform gemini-cli)', () => {
  it('counts a series that appears mid-run in full (cache deltas reach the input − cache rule)', () => {
    const baselines: CumulativeBaselines = new Map();
    expect(
      toUsageGroups(
        [point('input_tokens', 100, '2000'), point('output_tokens', 10, '2000')],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
    const groups = toUsageGroups(
      [
        point('input_tokens', 700, '3000'),
        point('output_tokens', 40, '3000'),
        point('cache_read_tokens', 400, '3000'), // first seen now, same startNs as its siblings
        point('reasoning_tokens', 25, '3000'),
      ],
      baselines,
      'gemini-cli',
    );
    expect(groups).toEqual([
      {
        sessionId: 's1',
        model: 'gemini-2.5-pro',
        startNs: '1000',
        endNs: '3000',
        delta: {
          input_tokens: 600,
          output_tokens: 30,
          cache_read_tokens: 400,
          reasoning_tokens: 25,
        },
        platform: 'gemini-cli',
      },
    ]);
    // From then on the new series has a real baseline.
    const next = toUsageGroups([point('cache_read_tokens', 450, '4000')], baselines, 'gemini-cli');
    expect(next[0]!.delta).toEqual({ cache_read_tokens: 50 });
  });

  it('all series new in the same request (first export) only set baselines', () => {
    const baselines: CumulativeBaselines = new Map();
    expect(
      toUsageGroups(
        [point('input_tokens', 100, '2000'), point('cache_read_tokens', 40, '2000')],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
    expect(baselines.size).toBe(2);
  });

  it('a new series whose siblings have another startNs (restart) only sets a baseline', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([point('input_tokens', 100, '2000')], baselines, 'gemini-cli');
    expect(
      toUsageGroups(
        [point('cache_read_tokens', 40, '9000', { startNs: '8000' })],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
    // From then on the new run (startNs 8000) is known: a series of it that first appears in a
    // later export is a sibling and counts from 0 (G5 / QA G21). Before R4 the input series
    // was keyed without its start, so this point read as a reset of the old run's input.
    expect(
      toUsageGroups(
        [point('input_tokens', 30, '9000', { startNs: '8000' })],
        baselines,
        'gemini-cli',
      )[0]!.delta,
    ).toEqual({ input_tokens: 30 });
    const groups = toUsageGroups(
      [
        point('input_tokens', 50, '9500', { startNs: '8000' }),
        point('output_tokens', 7, '9500', { startNs: '8000' }),
      ],
      baselines,
      'gemini-cli',
    );
    expect(groups[0]!.delta).toEqual({ input_tokens: 20, output_tokens: 7 });
  });

  it('a new series of another session or model is not a sibling', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([point('input_tokens', 100, '2000')], baselines, 'gemini-cli');
    expect(
      toUsageGroups(
        [
          point('output_tokens', 5, '3000', { sessionId: 's2' }),
          point('output_tokens', 5, '3000', { model: 'gemini-2.5-flash' }),
        ],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
  });

  it('Claude Code groups keep the plain rule: a new series only sets a baseline', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([point('input_tokens', 100, '2000')], baselines);
    expect(toUsageGroups([point('output_tokens', 5, '3000')], baselines)).toEqual([]);
  });
});
