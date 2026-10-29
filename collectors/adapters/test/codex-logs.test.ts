import { describe, expect, it } from 'vitest';
import {
  CODEX_LOGS_PARSE_ERROR,
  parseCodexLogs,
  type CodexCostRecord,
  type CodexTokenRecord,
} from '../src/index.ts';

// Shapes follow the OTLP JSON encoding (ExportLogsServiceRequest, lowerCamelCase, AnyValue
// attributes; int64 as JSON string or number) and openai/codex main (fetched 2026-10-29):
// `otel/src/events/session_telemetry.rs` `sse_event_completed` (`%` Display fields → stringValue,
// i64 fields → intValue via opentelemetry-appender-tracing `record_debug` / `record_i64`),
// `see_event_completed_failed`, `record_turn_cost`, and the common `log_event!` fields in
// `otel/src/events/shared.rs` (`user.email`, `user.account_id`, …).

const CONV = '019a3c5e-7f3a-7c11-9d2e-codex-root';
const TS = '2026-10-29T19:29:00.123Z';

// Identity and content values that must never appear in the parser's output.
const IDENTITY = {
  'user.email': 'hai@example.com',
  'user.account_id': 'acct-SENTINEL-41c2',
  'app.version': '0.99.0-SENTINEL',
  originator: 'codex_cli_rs-SENTINEL',
  'terminal.type': 'SENTINEL-terminal',
  slug: 'SENTINEL-slug',
};

type Attr = { key: string; value: Record<string, unknown> };
const s = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const i = (key: string, value: string | number): Attr => ({ key, value: { intValue: value } });

const common = (overrides: Record<string, string> = {}): Attr[] =>
  Object.entries({
    'event.timestamp': TS,
    'conversation.id': CONV,
    auth_mode: 'ApiKey',
    model: 'gpt-5.5-codex',
    ...IDENTITY,
    ...overrides,
  }).map(([key, value]) => s(key, value));

/** A successful response.completed record with the wire types from M2. */
const completed = (extra: Attr[] = [], overrides: Record<string, string> = {}): Attr[] => [
  s('event.name', 'codex.sse_event'),
  s('event.kind', 'response.completed'),
  s('input_token_count', '1000'),
  s('output_token_count', '250'),
  i('cached_token_count', '400'),
  i('cache_write_token_count', '100'),
  i('reasoning_token_count', '120'),
  s('tool_token_count', '1250'),
  i('ttft_ms', '812'),
  s('service_tier', 'SENTINEL-tier'),
  ...common(overrides),
  ...extra,
];

const turnCost = (usd: string, extra: Attr[] = [], overrides: Record<string, string> = {}) => [
  s('event.name', 'codex.turn_cost'),
  s('turn.id', 'turn-7'),
  s('usage.estimated_usd', usd),
  { key: 'turn.interrupted', value: { boolValue: false } },
  s('speed', 'SENTINEL-speed'),
  ...common(overrides),
  ...extra,
];

const logRecord = (attributes: unknown[], body: unknown = { stringValue: 'SENTINEL-body' }) => ({
  timeUnixNano: '1793302140123000000',
  observedTimeUnixNano: '1793302140123000000',
  severityNumber: 9,
  severityText: 'INFO',
  body,
  attributes,
});

const request = (records: unknown[]) => ({
  resourceLogs: [
    {
      resource: {
        attributes: [
          s('service.name', 'codex_cli_rs'),
          s('host.name', 'hai-SENTINEL-laptop'),
          s('user.email', IDENTITY['user.email']),
        ],
      },
      scopeLogs: [{ scope: { name: 'codex_otel.log_only' }, logRecords: records }],
    },
  ],
});

const parse = (body: unknown) => {
  const result = parseCodexLogs(body);
  if (!result.ok) throw new Error(result.error);
  return result;
};

const TOKEN: CodexTokenRecord = {
  conversationId: CONV,
  model: 'gpt-5.5-codex',
  authMode: 'ApiKey',
  timestamp: TS,
  input: 1000,
  cached: 400,
  cacheWrite: 100,
  output: 250,
};
const COST: CodexCostRecord = {
  conversationId: CONV,
  turnId: 'turn-7',
  authMode: 'ApiKey',
  costUsd: 0.0125,
};

describe('parseCodexLogs — response.completed token records (C4, M2)', () => {
  it('keeps only the four counters, conversation.id, model, auth_mode and event.timestamp', () => {
    const result = parse(request([logRecord(completed())]));
    expect(result).toEqual({ ok: true, tokens: [TOKEN], costs: [], ignored: 0 });
  });

  it('accepts every counter as stringValue or intValue (string or number)', () => {
    const encodings: Array<(key: string, n: number) => Attr> = [
      (key, n) => s(key, String(n)),
      (key, n) => i(key, String(n)),
      (key, n) => i(key, n),
    ];
    for (const enc of encodings) {
      const attrs = [
        s('event.name', 'codex.sse_event'),
        s('event.kind', 'response.completed'),
        enc('input_token_count', 1000),
        enc('cached_token_count', 400),
        enc('cache_write_token_count', 100),
        enc('output_token_count', 250),
        ...common(),
      ];
      expect(parse(request([logRecord(attrs)])).tokens).toEqual([TOKEN]);
    }
  });

  it.each([
    ['negative intValue', i('cached_token_count', '-1')],
    ['negative number', i('cached_token_count', -1)],
    ['fractional number', i('cached_token_count', 1.5)],
    ['decimal string', s('cached_token_count', '1.0')],
    ['unsafe integer', i('cached_token_count', '9007199254740993')],
    ['unsafe number', i('cached_token_count', 2 ** 53)],
    ['doubleValue', { key: 'cached_token_count', value: { doubleValue: 400 } }],
    ['empty string', s('cached_token_count', '')],
    ['exponent', s('cached_token_count', '4e2')],
    ['signed', s('cached_token_count', '+400')],
  ])('rejects a record whose counter is a %s', (_, bad) => {
    const attrs = [bad, ...completed().filter((a) => a.key !== 'cached_token_count')];
    expect(parse(request([logRecord(attrs)]))).toMatchObject({ tokens: [], ignored: 1 });
  });

  it.each([
    'input_token_count',
    'cached_token_count',
    'cache_write_token_count',
    'output_token_count',
  ])('requires %s', (key) => {
    const attrs = completed().filter((a) => a.key !== key);
    expect(parse(request([logRecord(attrs)]))).toMatchObject({ tokens: [], ignored: 1 });
  });

  it('rejects the failure variant (same name and kind, error.message, no counters)', () => {
    const failed = [
      s('event.name', 'codex.sse_event'),
      s('event.kind', 'response.completed'),
      s('error.message', 'SENTINEL-error stream disconnected'),
      ...common(),
    ];
    // Even with counters present, an error.message makes the record a failure.
    const failedWithCounters = completed([s('error.message', 'SENTINEL-error')]);
    const result = parse(request([logRecord(failed), logRecord(failedWithCounters)]));
    expect(result).toMatchObject({ tokens: [], costs: [], ignored: 2 });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('never adds tool_token_count (= total) or reasoning_token_count', () => {
    const [record] = parse(request([logRecord(completed())])).tokens;
    expect(Object.keys(record!).sort()).toEqual(Object.keys(TOKEN).sort());
    expect(JSON.stringify(record)).not.toContain('1250');
    expect(JSON.stringify(record)).not.toContain('120');
  });

  it('ignores other sse kinds and records with the kind only in the body', () => {
    const delta = completed().map((a) =>
      a.key === 'event.kind' ? s('event.kind', 'response.output_text.delta') : a,
    );
    const noKind = completed().filter((a) => a.key !== 'event.kind');
    const result = parse(
      request([
        logRecord(delta),
        logRecord(noKind, { stringValue: 'event.kind=response.completed' }),
      ]),
    );
    expect(result).toMatchObject({ tokens: [], ignored: 2 });
  });

  it('requires conversation.id, a model ≤ 64 chars and an RFC 3339 event.timestamp', () => {
    const without = (key: string) => completed().filter((a) => a.key !== key);
    const bad = [
      without('conversation.id'),
      without('model'),
      without('event.timestamp'),
      completed([], { model: 'm'.repeat(65) }),
      completed([], { model: '' }),
      completed([], { 'event.timestamp': '2026-10-29 19:29:00' }),
      completed([], { 'event.timestamp': '2026-13-29T19:29:00Z' }),
      completed([], { 'event.timestamp': '1793302140123' }),
      completed([], { 'conversation.id': `a\0b` }),
      completed([], { 'conversation.id': 'c'.repeat(257) }),
    ];
    expect(parse(request(bad.map((a) => logRecord(a))))).toMatchObject({
      tokens: [],
      ignored: bad.length,
    });
    expect(
      parse(request([logRecord(completed([], { model: 'm'.repeat(64) }))])).tokens,
    ).toHaveLength(1);
  });

  it('keeps only an allowlisted auth_mode; any other or missing value is null', () => {
    const withAuth = (value: string | null) =>
      logRecord(
        value === null
          ? completed().filter((a) => a.key !== 'auth_mode')
          : completed([], { auth_mode: value }),
      );
    const tokens = parse(
      request([
        withAuth('ApiKey'),
        withAuth('Chatgpt'),
        withAuth('apikey'),
        withAuth('SENTINEL-mode'),
        withAuth(null),
      ]),
    ).tokens;
    expect(tokens.map((t) => t.authMode)).toEqual(['ApiKey', 'Chatgpt', null, null, null]);
  });

  it('the first attribute of a key wins (duplicates are not merged)', () => {
    const attrs = [s('input_token_count', '7'), ...completed()];
    expect(parse(request([logRecord(attrs)])).tokens[0]).toMatchObject({ input: 7 });
  });
});

describe('parseCodexLogs — codex.turn_cost cost records', () => {
  it('keeps usage.estimated_usd, turn.id, conversation.id and auth_mode', () => {
    const result = parse(request([logRecord(turnCost('0.0125'))]));
    expect(result).toEqual({ ok: true, tokens: [], costs: [COST], ignored: 0 });
  });

  it.each([
    ['0', 0],
    ['12', 12],
    ['0.000001', 0.000001],
    ['3.1415926535', 3.1415926535],
  ])('accepts %s', (usd, value) => {
    expect(parse(request([logRecord(turnCost(usd))])).costs[0]?.costUsd).toBe(value);
  });

  it.each(['', '-1', '1.', '.5', '1e-3', '1,5', ' 1', 'NaN', 'Infinity', '0x10', '1.2.3', '$1'])(
    'ignores usage.estimated_usd %j (must match ^\\d+(\\.\\d+)?$)',
    (usd) => {
      expect(parse(request([logRecord(turnCost(usd))]))).toMatchObject({ costs: [], ignored: 1 });
    },
  );

  it('ignores a non-string usage.estimated_usd and a cost record without turn.id or conversation.id', () => {
    const numeric = turnCost('1').map((a) =>
      a.key === 'usage.estimated_usd' ? { key: a.key, value: { doubleValue: 1 } } : a,
    );
    const noTurn = turnCost('1').filter((a) => a.key !== 'turn.id');
    const noConv = turnCost('1').filter((a) => a.key !== 'conversation.id');
    expect(parse(request([numeric, noTurn, noConv].map((a) => logRecord(a))))).toMatchObject({
      costs: [],
      ignored: 3,
    });
  });

  it('keeps Chatgpt and missing auth modes on the record (the cost rule drops them later)', () => {
    const chatgpt = turnCost('0.5', [], { auth_mode: 'Chatgpt' });
    const missing = turnCost('0.5').filter((a) => a.key !== 'auth_mode');
    const costs = parse(request([logRecord(chatgpt), logRecord(missing)])).costs;
    expect(costs.map((c) => c.authMode)).toEqual(['Chatgpt', null]);
  });
});

describe('parseCodexLogs — privacy allowlist', () => {
  const contentRecords = [
    logRecord([
      s('event.name', 'codex.tool_result'),
      s('tool_name', 'shell'),
      s('arguments', 'SENTINEL-arguments rm -rf /secret'),
      s('output', 'SENTINEL-output API_KEY=abc'),
      s('input_token_count', '5'),
      ...common(),
    ]),
    logRecord([
      s('event.name', 'codex.user_prompt'),
      s('prompt', 'SENTINEL-prompt my private prompt'),
      s('prompt_length', '33'),
      ...common(),
    ]),
    logRecord([s('event.name', 'codex.tool_decision'), s('decision', 'SENTINEL'), ...common()]),
    logRecord([s('event.name', 'codex.api_request'), ...common()]),
    logRecord(common()),
  ];

  it('ignores tool, prompt and every other record; identity attributes are never copied', () => {
    const result = parse(
      request([...contentRecords, logRecord(completed()), logRecord(turnCost('1'))]),
    );
    expect(result).toMatchObject({ tokens: [TOKEN], costs: [{ ...COST, costUsd: 1 }] });
    expect(result.ok && result.ignored).toBe(contentRecords.length);
    const json = JSON.stringify(result);
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain('hai@example.com');
    expect(json).not.toContain('secret');
  });

  it('reads only attributes of a log record (never body, resource or scope)', () => {
    const read = new Set<string | symbol>();
    const spy = (target: object) =>
      new Proxy(target, {
        get(t, key, receiver) {
          read.add(key);
          return Reflect.get(t, key, receiver) as unknown;
        },
      });
    const body = {
      resourceLogs: [
        spy({
          resource: { attributes: [s('user.email', IDENTITY['user.email'])] },
          scopeLogs: [
            spy({
              scope: { name: 'x' },
              logRecords: [spy(logRecord(completed())), spy(logRecord(turnCost('1')))],
            }),
          ],
        }),
      ],
    };
    parse(body);
    const allowed = new Set(['scopeLogs', 'logRecords', 'attributes']);
    for (const key of read) expect(allowed, `read ${String(key)}`).toContain(key);
  });

  it('reads the value only of allowlisted attributes; other records only their event.name', () => {
    const readValues: string[] = [];
    const watch = (attrs: Attr[]) =>
      attrs.map(
        (attr) =>
          new Proxy(attr, {
            get(t, key, receiver) {
              if (key === 'value') readValues.push(t.key);
              return Reflect.get(t, key, receiver) as unknown;
            },
          }),
      );
    const records = [
      ...contentRecords.map((r) => logRecord(watch(r.attributes as Attr[]))),
      logRecord(watch(completed())),
      logRecord(watch(turnCost('1'))),
    ];
    parse(request(records));
    const allowed = new Set([
      'event.name',
      'event.kind',
      'conversation.id',
      'model',
      'auth_mode',
      'event.timestamp',
      'input_token_count',
      'cached_token_count',
      'cache_write_token_count',
      'output_token_count',
      'turn.id',
      'usage.estimated_usd',
    ]);
    for (const key of readValues) expect(allowed, `read value of ${key}`).toContain(key);
    for (const never of [
      'user.email',
      'user.account_id',
      'tool_token_count',
      'reasoning_token_count',
      'arguments',
      'output',
      'prompt',
      'error.message',
    ]) {
      expect(readValues).not.toContain(never);
    }
  });
});

describe('parseCodexLogs — malformed bodies', () => {
  it.each([
    ['null', null],
    ['a string', '{"resourceLogs":[]}'],
    ['a number', 42],
    ['an array', [{ resourceLogs: [] }]],
    ['resourceLogs as object', { resourceLogs: { 'user.email': 'hai@example.com' } }],
    ['resourceLogs as string', { resourceLogs: 'SENTINEL-body-content' }],
  ])('%s → ok: false with a constant error that never echoes the body', (_, body) => {
    const result = parseCodexLogs(body);
    expect(result).toEqual({ ok: false, error: CODEX_LOGS_PARSE_ERROR });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(JSON.stringify(result)).not.toContain('hai@example.com');
  });

  it('treats an absent or null resourceLogs as an empty request (OTLP JSON semantics)', () => {
    for (const body of [{}, { resourceLogs: null }, { resourceLogs: [] }]) {
      expect(parseCodexLogs(body)).toEqual({ ok: true, tokens: [], costs: [], ignored: 0 });
    }
  });

  it('skips malformed nested entries without failing the request', () => {
    const body = {
      resourceLogs: [
        null,
        'x',
        { scopeLogs: 'nope' },
        {
          scopeLogs: [
            null,
            { logRecords: { not: 'a list' } },
            {
              logRecords: [
                null,
                42,
                { attributes: 'nope' },
                { attributes: [null, 'x', { key: 7 }, { key: 'event.name' }] },
                logRecord([{ key: 'event.name', value: 'codex.sse_event' }]),
                logRecord(completed()),
              ],
            },
          ],
        },
      ],
    };
    expect(parse(body)).toEqual({ ok: true, tokens: [TOKEN], costs: [], ignored: 5 });
  });
});
