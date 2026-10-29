import { describe, expect, it } from 'vitest';
import { GEMINI_TOKEN_METRIC, parseGeminiMetrics, type AdapterUsagePoint } from '../src/index.ts';

// Shapes follow the OTLP JSON encoding (ExportMetricsServiceRequest, lowerCamelCase, int64 as
// string or number) and gemini-cli docs/cli/telemetry.md: `gemini_cli.token.usage` with `model`
// and `type`, plus the common attributes `session.id`, `installation.id`,
// `active_approval_mode` and `user.email` on all data.

const DELTA = 1;
const CUMULATIVE = 2;
const START = '1761730000000000000';
const END = '1761730010000000000';

// Identity and other attribute values that must never appear in the parser's output.
const IDENTITY: Record<string, string> = {
  'user.email': 'hai@example.com',
  'installation.id': 'installation-id-SENTINEL-41c2',
  active_approval_mode: 'approval-mode-SENTINEL',
  auth_type: 'oauth-personal-SENTINEL',
  prompt: 'SENTINEL-prompt-in-a-metric',
};

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

const attrs = (extra: Record<string, string> = {}, sessionId: string | null = 'sess-1') =>
  Object.entries({
    ...(sessionId !== null && { 'session.id': sessionId }),
    model: 'gemini-2.5-pro',
    ...IDENTITY,
    ...extra,
  }).map(([key, value]) => str(key, value));

const point = (
  value: Record<string, unknown>,
  extra: Record<string, string> = {},
  times: Record<string, unknown> = { startTimeUnixNano: START, timeUnixNano: END },
  sessionId: string | null = 'sess-1',
) => ({ attributes: attrs(extra, sessionId), ...times, ...value });

const metric = (name: string, dataPoints: unknown[], temporality: unknown = CUMULATIVE) => ({
  name,
  unit: 'token',
  sum: { dataPoints, aggregationTemporality: temporality, isMonotonic: true },
});

const request = (metrics: unknown[], resourceSession: string | null = 'sess-resource') => ({
  resourceMetrics: [
    {
      resource: {
        attributes: [
          str('service.name', 'gemini-cli'),
          str('host.name', 'hai-SENTINEL-laptop'),
          str('user.email', IDENTITY['user.email']!),
          str('installation.id', IDENTITY['installation.id']!),
          ...(resourceSession !== null ? [str('session.id', resourceSession)] : []),
        ],
      },
      scopeMetrics: [{ scope: { name: 'gemini-cli', version: '0.67.0' }, metrics }],
    },
  ],
});

const parse = (body: unknown) => {
  const result = parseGeminiMetrics(body);
  if (!result.ok) throw new Error(result.error);
  return result;
};

const expected = (
  counter: AdapterUsagePoint['counter'],
  value: number,
  overrides: Partial<AdapterUsagePoint> = {},
): AdapterUsagePoint => ({
  sessionId: 'sess-1',
  model: 'gemini-2.5-pro',
  counter,
  value,
  startNs: START,
  endNs: END,
  temporality: 'cumulative',
  ...overrides,
});

describe('parseGeminiMetrics — type → counter mapping', () => {
  it.each([
    ['input', 'input_tokens'],
    ['output', 'output_tokens'],
    ['cache', 'cache_read_tokens'],
    ['thought', 'reasoning_tokens'],
  ] as const)('type %s → %s', (type, counter) => {
    const result = parse(
      request([metric(GEMINI_TOKEN_METRIC, [point({ asInt: '42' }, { type })])]),
    );
    expect(result).toEqual({ ok: true, points: [expected(counter, 42)], ignored: 0 });
  });

  it('ignores the tool type and unknown types, counting them', () => {
    const result = parse(
      request([
        metric(GEMINI_TOKEN_METRIC, [
          point({ asInt: '5' }, { type: 'tool' }),
          point({ asInt: '6' }, { type: 'cacheRead' }),
          point({ asInt: '7' }, { type: 'Input' }),
          point({ asInt: '8' }),
          point({ asInt: '9' }, { type: 'output' }),
        ]),
      ]),
    );
    expect(result).toEqual({ ok: true, points: [expected('output_tokens', 9)], ignored: 4 });
  });

  it('keeps the temporality enum (1 delta, 2 cumulative) and ignores others', () => {
    const at = (temporality: unknown) =>
      parse(
        request([
          metric(GEMINI_TOKEN_METRIC, [point({ asInt: 3 }, { type: 'input' })], temporality),
        ]),
      );
    expect(at(DELTA).points[0]?.temporality).toBe('delta');
    expect(at(CUMULATIVE).points[0]?.temporality).toBe('cumulative');
    for (const bad of [0, 3, '2', null]) {
      expect(at(bad)).toEqual({ ok: true, points: [], ignored: 1 });
    }
    // `metric()` defaults an undefined temporality, so build the absent case by hand.
    const absent = {
      name: GEMINI_TOKEN_METRIC,
      sum: { dataPoints: [point({ asInt: 3 }, { type: 'input' })] },
    };
    expect(parse(request([absent]))).toEqual({ ok: true, points: [], ignored: 1 });
  });
});

describe('parseGeminiMetrics — privacy allowlist', () => {
  it('copies only session.id, model and type; identity attributes never reach the output', () => {
    const body = request([
      metric(GEMINI_TOKEN_METRIC, [
        point({ asInt: '100' }, { type: 'input' }),
        point({ asInt: '20' }, { type: 'output' }),
      ]),
    ]);
    const result = parse(body);
    expect(result.points).toHaveLength(2);
    const json = JSON.stringify(result);
    for (const value of Object.values(IDENTITY)) expect(json).not.toContain(value);
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain('example.com');
    for (const p of result.points) {
      expect(Object.keys(p).sort()).toEqual(
        ['counter', 'endNs', 'model', 'sessionId', 'startNs', 'temporality', 'value'].sort(),
      );
    }
  });

  it('reads no other metric, not even gen_ai token usage or a non-Sum token metric', () => {
    const body = request([
      metric('gen_ai.client.token.usage', [point({ asInt: '1' }, { type: 'input' })]),
      metric('gemini_cli.api.request.count', [point({ asInt: '1' }), point({ asInt: '2' })]),
      {
        name: GEMINI_TOKEN_METRIC,
        gauge: { dataPoints: [point({ asInt: '1' }, { type: 'input' })] },
      },
      {
        name: 'gemini_cli.api.request.latency',
        histogram: { dataPoints: [{ count: '1' }, { count: '2' }, { count: '3' }] },
      },
    ]);
    expect(parse(body)).toEqual({ ok: true, points: [], ignored: 7 });
  });

  it('falls back to the resource session.id; the data point wins when both are set', () => {
    const fromResource = parse(
      request(
        [metric(GEMINI_TOKEN_METRIC, [point({ asInt: '4' }, { type: 'cache' }, undefined, null)])],
        'sess-resource',
      ),
    );
    expect(fromResource.points).toEqual([
      expected('cache_read_tokens', 4, { sessionId: 'sess-resource' }),
    ]);
    const pointWins = parse(
      request(
        [metric(GEMINI_TOKEN_METRIC, [point({ asInt: '4' }, { type: 'cache' })])],
        'sess-resource',
      ),
    );
    expect(pointWins.points[0]?.sessionId).toBe('sess-1');
    const none = parse(
      request(
        [metric(GEMINI_TOKEN_METRIC, [point({ asInt: '4' }, { type: 'cache' }, undefined, null)])],
        null,
      ),
    );
    expect(none).toEqual({ ok: true, points: [], ignored: 1 });
  });

  it('ignores points without a model or with a model over the JGR limit (64)', () => {
    const noModel = {
      attributes: [str('session.id', 'sess-1'), str('type', 'input')],
      startTimeUnixNano: START,
      timeUnixNano: END,
      asInt: '1',
    };
    const longModel = point({ asInt: '1' }, { type: 'input', model: `gemini-${'x'.repeat(60)}` });
    expect(parse(request([metric(GEMINI_TOKEN_METRIC, [noModel, longModel])]))).toEqual({
      ok: true,
      points: [],
      ignored: 2,
    });
  });
});

describe('parseGeminiMetrics — value and time encodings', () => {
  it.each([
    [{ asInt: '1234' }, 1234],
    [{ asInt: 1234 }, 1234],
    [{ asDouble: 1234 }, 1234],
    [{ asDouble: '1234' }, 1234],
    [{ asInt: '0' }, 0],
  ])('reads %j', (value, n) => {
    const result = parse(
      request([metric(GEMINI_TOKEN_METRIC, [point(value, { type: 'output' })])]),
    );
    expect(result.points).toEqual([expected('output_tokens', n)]);
  });

  it.each([
    [{ asInt: '-1' }],
    [{ asInt: -5 }],
    [{ asDouble: -0.5 }],
    [{ asDouble: 1.5 }],
    [{ asDouble: 'Infinity' }],
    [{ asDouble: 'NaN' }],
    [{ asInt: '12345678901234567890' }],
    [{ asInt: 1.5 }],
    [{ asInt: 'abc' }],
    [{}],
  ])('ignores invalid value %j', (value) => {
    const result = parse(
      request([metric(GEMINI_TOKEN_METRIC, [point(value, { type: 'output' })])]),
    );
    expect(result).toEqual({ ok: true, points: [], ignored: 1 });
  });

  it.each([
    [{ timeUnixNano: END }],
    [{ startTimeUnixNano: '0', timeUnixNano: END }],
    [{ startTimeUnixNano: END, timeUnixNano: START }],
    [{ startTimeUnixNano: '-1', timeUnixNano: END }],
    [{ startTimeUnixNano: START, timeUnixNano: '99999999999999999999' }],
  ])('ignores bad times %j', (times) => {
    const result = parse(
      request([metric(GEMINI_TOKEN_METRIC, [point({ asInt: '1' }, { type: 'input' }, times)])]),
    );
    expect(result).toEqual({ ok: true, points: [], ignored: 1 });
  });

  it('accepts numeric times and normalises them to decimal strings', () => {
    const result = parse(
      request([
        metric(GEMINI_TOKEN_METRIC, [
          point({ asInt: '1' }, { type: 'input' }, { startTimeUnixNano: 1000, timeUnixNano: 2000 }),
        ]),
      ]),
    );
    expect(result.points[0]).toMatchObject({ startNs: '1000', endNs: '2000' });
  });
});

describe('parseGeminiMetrics — malformed bodies', () => {
  it.each([
    [null],
    ['{"resourceMetrics":[]}'],
    [[]],
    [42],
    [{ resourceMetrics: {} }],
    [{ resourceMetrics: 'x' }],
  ])('rejects %j', (body) => {
    expect(parseGeminiMetrics(body)).toMatchObject({ ok: false });
  });

  it('treats an absent or null resourceMetrics as an empty request (OTLP JSON semantics)', () => {
    expect(parseGeminiMetrics({})).toEqual({ ok: true, points: [], ignored: 0 });
    expect(parseGeminiMetrics({ resourceMetrics: null })).toEqual({
      ok: true,
      points: [],
      ignored: 0,
    });
  });

  it('skips malformed nested entries without failing the request', () => {
    const body = {
      resourceMetrics: [
        null,
        'x',
        { scopeMetrics: 'x' },
        { scopeMetrics: [null, { metrics: [null, 7, { name: GEMINI_TOKEN_METRIC, sum: 'x' }] }] },
        { scopeMetrics: [{ metrics: [metric(GEMINI_TOKEN_METRIC, [null, 'x'])] }] },
        ...request([metric(GEMINI_TOKEN_METRIC, [point({ asInt: '2' }, { type: 'thought' })])])
          .resourceMetrics,
      ],
    };
    expect(parse(body)).toEqual({
      ok: true,
      points: [expected('reasoning_tokens', 2)],
      ignored: 2,
    });
  });
});
