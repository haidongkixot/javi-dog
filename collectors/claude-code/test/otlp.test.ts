import { describe, expect, it } from 'vitest';
import { COST_METRIC, parseOtlpMetrics, TOKEN_METRIC, type UsagePoint } from '../src/otlp.ts';

// Shapes follow the OTLP JSON encoding (ExportMetricsServiceRequest, lowerCamelCase, int64 as
// string or number) and code.claude.com/docs/en/monitoring-usage (attributes on every point).

const DELTA = 1;
const CUMULATIVE = 2;
const START = '1761638400000000000';
const END = '1761638460000000000';

// Identity values that must never appear in the parser's output.
const IDENTITY: Record<string, string> = {
  'user.email': 'hai@example.com',
  'user.id': 'user-id-6f1c0f2a',
  'user.account_uuid': 'acct-uuid-91b2c3d4',
  'organization.id': 'org-id-5e6f7a8b',
  'terminal.type': 'iTerm-secret-terminal',
  query_source: 'query-source-secret',
  speed: 'speed-secret',
  effort: 'effort-secret',
};

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

const attrs = (extra: Record<string, string> = {}) =>
  Object.entries({ 'session.id': 'sess-1', model: 'claude-sonnet-4-5', ...IDENTITY, ...extra }).map(
    ([key, value]) => str(key, value),
  );

const point = (
  value: Record<string, unknown>,
  extra: Record<string, string> = {},
  times: Record<string, unknown> = { startTimeUnixNano: START, timeUnixNano: END },
) => ({ attributes: attrs(extra), ...times, ...value });

const metric = (name: string, dataPoints: unknown[], temporality: unknown = DELTA) => ({
  name,
  unit: name === COST_METRIC ? 'USD' : 'tokens',
  sum: { dataPoints, aggregationTemporality: temporality, isMonotonic: true },
});

const request = (metrics: unknown[], scopes = 1) => ({
  resourceMetrics: [
    {
      resource: {
        attributes: [
          str('service.name', 'claude-code'),
          str('host.name', 'hai-secret-laptop'),
          str('user.email', IDENTITY['user.email']!),
        ],
      },
      scopeMetrics: Array.from({ length: scopes }, () => ({
        scope: { name: 'com.anthropic.claude_code', version: '2.0.0' },
        metrics,
      })),
    },
  ],
});

const parse = (body: unknown) => {
  const result = parseOtlpMetrics(body);
  if (!result.ok) throw new Error(result.error);
  return result;
};

const expected = (counter: UsagePoint['counter'], value: number): UsagePoint => ({
  sessionId: 'sess-1',
  model: 'claude-sonnet-4-5',
  counter,
  value,
  startNs: START,
  endNs: END,
  temporality: 'delta',
});

describe('parseOtlpMetrics — type → counter mapping', () => {
  it.each([
    ['input', 'input_tokens'],
    ['output', 'output_tokens'],
    ['cacheRead', 'cache_read_tokens'],
    ['cacheCreation', 'cache_write_tokens'],
  ] as const)('token type %s → %s', (type, counter) => {
    const result = parse(request([metric(TOKEN_METRIC, [point({ asInt: '42' }, { type })])]));
    expect(result).toEqual({ ok: true, points: [expected(counter, 42)], ignored: 0 });
  });

  it('cost metric → cost_usd (no type attribute needed)', () => {
    const result = parse(request([metric(COST_METRIC, [point({ asDouble: 0.0123 })])]));
    expect(result).toEqual({ ok: true, points: [expected('cost_usd', 0.0123)], ignored: 0 });
  });
});

describe('parseOtlpMetrics — privacy allowlist', () => {
  it('never copies identity or resource attribute values into the output', () => {
    const body = request([
      metric(TOKEN_METRIC, [point({ asInt: '10' }, { type: 'input' })]),
      metric(COST_METRIC, [point({ asDouble: 0.5 })]),
    ]);
    const result = parse(body);
    expect(result.points).toHaveLength(2);
    const out = JSON.stringify(result);
    for (const value of [...Object.values(IDENTITY), 'hai-secret-laptop', 'claude-code']) {
      expect(out).not.toContain(value);
    }
    for (const p of result.points) {
      expect(Object.keys(p).sort()).toEqual(
        ['counter', 'endNs', 'model', 'sessionId', 'startNs', 'temporality', 'value'].sort(),
      );
    }
  });

  it('does not read session.id or model from resource attributes', () => {
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [str('session.id', 'sess-1'), str('model', 'm')] },
          scopeMetrics: [
            {
              metrics: [
                metric(TOKEN_METRIC, [
                  {
                    attributes: [str('type', 'input')],
                    startTimeUnixNano: START,
                    timeUnixNano: END,
                    asInt: 1,
                  },
                ]),
              ],
            },
          ],
        },
      ],
    };
    expect(parse(body)).toEqual({ ok: true, points: [], ignored: 1 });
  });
});

describe('parseOtlpMetrics — value and time encodings', () => {
  it.each<[string, Record<string, unknown>, number]>([
    ['asInt as string', { asInt: '1234' }, 1234],
    ['asInt as number', { asInt: 1234 }, 1234],
    ['asInt zero', { asInt: '0' }, 0],
    ['asDouble integral', { asDouble: 1234 }, 1234],
    ['asDouble integral with fraction syntax', { asDouble: 1234.0 }, 1234],
    ['asDouble as numeric string', { asDouble: '1234' }, 1234],
    [
      'asInt at MAX_SAFE_INTEGER',
      { asInt: String(Number.MAX_SAFE_INTEGER) },
      Number.MAX_SAFE_INTEGER,
    ],
  ])('token value: %s', (_name, value, want) => {
    const result = parse(request([metric(TOKEN_METRIC, [point(value, { type: 'output' })])]));
    expect(result.points.map((p) => p.value)).toEqual([want]);
    expect(result.ignored).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['negative asInt', { asInt: '-5' }],
    ['negative asDouble', { asDouble: -1 }],
    ['non-integer token asDouble', { asDouble: 12.5 }],
    ['asInt above MAX_SAFE_INTEGER (string)', { asInt: '9007199254740993' }],
    ['asInt above MAX_SAFE_INTEGER (number)', { asInt: 2 ** 60 }],
    ['asInt non-numeric string', { asInt: '12abc' }],
    ['asInt fractional string', { asInt: '1.5' }],
    ['asDouble NaN string', { asDouble: 'NaN' }],
    ['asDouble Infinity string', { asDouble: 'Infinity' }],
    ['asDouble boolean', { asDouble: true }],
    ['no value', {}],
  ])('token value ignored: %s', (_name, value) => {
    const result = parse(request([metric(TOKEN_METRIC, [point(value, { type: 'input' })])]));
    expect(result).toEqual({ ok: true, points: [], ignored: 1 });
  });

  it.each<[string, Record<string, unknown>, number]>([
    ['fractional cost', { asDouble: 0.000731 }, 0.000731],
    ['zero cost', { asDouble: 0 }, 0],
    ['integer cost via asInt', { asInt: '2' }, 2],
  ])('cost value: %s', (_name, value, want) => {
    const result = parse(request([metric(COST_METRIC, [point(value)])]));
    expect(result.points.map((p) => p.value)).toEqual([want]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['negative cost', { asDouble: -0.01 }],
    ['infinite cost string', { asDouble: '-Infinity' }],
  ])('cost value ignored: %s', (_name, value) => {
    expect(parse(request([metric(COST_METRIC, [point(value)])])).ignored).toBe(1);
  });

  it('accepts times as numbers and canonicalizes them to decimal strings', () => {
    const times = { startTimeUnixNano: 1_000_000, timeUnixNano: '0002000000' };
    const result = parse(
      request([metric(TOKEN_METRIC, [point({ asInt: 1 }, { type: 'input' }, times)])]),
    );
    expect(result.points[0]).toMatchObject({ startNs: '1000000', endNs: '2000000' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['missing start', { timeUnixNano: END }],
    ['missing end', { startTimeUnixNano: START }],
    ['zero end', { startTimeUnixNano: START, timeUnixNano: '0' }],
    ['negative start', { startTimeUnixNano: '-1', timeUnixNano: END }],
    ['non-numeric end', { startTimeUnixNano: START, timeUnixNano: 'soon' }],
    ['fractional start', { startTimeUnixNano: 1.5, timeUnixNano: END }],
    ['start after end', { startTimeUnixNano: END, timeUnixNano: START }],
    ['beyond uint64', { startTimeUnixNano: START, timeUnixNano: '18446744073709551616' }],
  ])('point ignored: %s', (_name, times) => {
    const result = parse(
      request([metric(TOKEN_METRIC, [point({ asInt: 1 }, { type: 'input' }, times)])]),
    );
    expect(result).toEqual({ ok: true, points: [], ignored: 1 });
  });
});

describe('parseOtlpMetrics — temporality', () => {
  it('maps 1 → delta and 2 → cumulative', () => {
    const result = parse(
      request([
        metric(TOKEN_METRIC, [point({ asInt: 1 }, { type: 'input' })], DELTA),
        metric(TOKEN_METRIC, [point({ asInt: 2 }, { type: 'output' })], CUMULATIVE),
      ]),
    );
    expect(result.points.map((p) => p.temporality)).toEqual(['delta', 'cumulative']);
  });

  it.each([0, 3, undefined, '1', 'AGGREGATION_TEMPORALITY_DELTA'])(
    'temporality %s → all points ignored',
    (temporality) => {
      const dp = [point({ asInt: 1 }, { type: 'input' }), point({ asInt: 2 }, { type: 'output' })];
      // Built by hand: the `metric` helper's default would turn `undefined` into DELTA.
      const sum = { dataPoints: dp, isMonotonic: true, aggregationTemporality: temporality };
      if (temporality === undefined) delete (sum as Partial<typeof sum>).aggregationTemporality;
      expect(parse(request([{ name: TOKEN_METRIC, unit: 'tokens', sum }]))).toEqual({
        ok: true,
        points: [],
        ignored: 2,
      });
    },
  );
});

describe('parseOtlpMetrics — ignored points', () => {
  it.each<[string, Record<string, string>]>([
    ['unknown type', { type: 'reasoning' }],
    ['prototype key as type', { type: 'toString' }],
    ['empty session id', { 'session.id': '' }],
    ['empty model', { model: '' }],
    ['model over the JGR limit', { model: 'm'.repeat(65) }],
  ])('%s', (_name, extra) => {
    const result = parse(
      request([metric(TOKEN_METRIC, [point({ asInt: 1 }, { type: 'input', ...extra })])]),
    );
    expect(result).toEqual({ ok: true, points: [], ignored: 1 });
  });

  it('missing type on a token point is ignored', () => {
    const p = point({ asInt: 1 });
    expect(parse(request([metric(TOKEN_METRIC, [p])])).ignored).toBe(1);
  });

  it('missing session id or model attribute is ignored; non-string values do not count', () => {
    const noSession = {
      attributes: [str('model', 'm'), str('type', 'input')],
      startTimeUnixNano: START,
      timeUnixNano: END,
      asInt: 1,
    };
    const intSession = {
      attributes: [
        { key: 'session.id', value: { intValue: '7' } },
        str('model', 'm'),
        str('type', 'input'),
      ],
      startTimeUnixNano: START,
      timeUnixNano: END,
      asInt: 1,
    };
    const noModel = {
      attributes: [str('session.id', 's'), str('type', 'input')],
      startTimeUnixNano: START,
      timeUnixNano: END,
      asInt: 1,
    };
    expect(parse(request([metric(TOKEN_METRIC, [noSession, intSession, noModel])]))).toEqual({
      ok: true,
      points: [],
      ignored: 3,
    });
  });

  it('counts the data points of other metrics as ignored', () => {
    const result = parse(
      request([
        metric('claude_code.session.count', [point({ asInt: 1 })]),
        metric('claude_code.lines_of_code.count', [
          point({ asInt: 3 }, { type: 'added' }),
          point({ asInt: 1 }, { type: 'removed' }),
        ]),
        {
          name: 'claude_code.active_time.total',
          gauge: { dataPoints: [point({ asDouble: 3.2 })] },
        },
        { name: TOKEN_METRIC, gauge: { dataPoints: [point({ asInt: 9 }, { type: 'input' })] } },
        metric(TOKEN_METRIC, [point({ asInt: 5 }, { type: 'input' })]),
      ]),
    );
    expect(result.points).toEqual([expected('input_tokens', 5)]);
    expect(result.ignored).toBe(5);
  });

  it('ignores unknown fields at every level', () => {
    const body = {
      unknownTop: { a: 1 },
      resourceMetrics: [
        {
          futureField: true,
          resource: { attributes: [], droppedAttributesCount: 0, entityRefs: [] },
          schemaUrl: 'https://opentelemetry.io/schemas/1.27.0',
          scopeMetrics: [
            {
              scope: { name: 's', extra: 1 },
              metrics: [
                {
                  ...metric(TOKEN_METRIC, [
                    {
                      ...point({ asInt: '7' }, { type: 'input' }),
                      flags: 0,
                      exemplars: [],
                      novel: 'x',
                    },
                  ]),
                  description: 'Number of tokens used',
                  metadata: [],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parse(body)).toEqual({ ok: true, points: [expected('input_tokens', 7)], ignored: 0 });
  });

  it('tolerates malformed nested entries without failing the request', () => {
    const body = {
      resourceMetrics: [
        null,
        'x',
        { scopeMetrics: 'nope' },
        {
          scopeMetrics: [
            null,
            { metrics: [null, 5, { name: TOKEN_METRIC, sum: { dataPoints: 'x' } }] },
          ],
        },
        request([metric(TOKEN_METRIC, [null, point({ asInt: 3 }, { type: 'input' })])])
          .resourceMetrics[0],
      ],
    };
    expect(parse(body)).toEqual({ ok: true, points: [expected('input_tokens', 3)], ignored: 1 });
  });

  it('reads points across several resourceMetrics and scopeMetrics', () => {
    const body = request([metric(TOKEN_METRIC, [point({ asInt: 2 }, { type: 'input' })])], 2);
    body.resourceMetrics.push(body.resourceMetrics[0]!);
    expect(parse(body).points).toHaveLength(4);
  });

  it('an empty request is ok with no points', () => {
    expect(parseOtlpMetrics({ resourceMetrics: [] })).toEqual({ ok: true, points: [], ignored: 0 });
  });
});

describe('parseOtlpMetrics — malformed body', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['string', '{"resourceMetrics":[]}'],
    ['number', 42],
    ['array', [{ resourceMetrics: [] }]],
    ['empty object', {}],
    ['resourceMetrics not an array', { resourceMetrics: {} }],
    ['snake_case field name', { resource_metrics: [] }],
  ])('%s → ok:false', (_name, body) => {
    const result = parseOtlpMetrics(body);
    expect(result.ok).toBe(false);
  });
});
