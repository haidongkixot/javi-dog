import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_BODY_BYTES,
  createState,
  createUsageReceiver,
  opaqueRef,
  runHook,
  type CollectorState,
  type UsageReceiver,
} from '../src/index.ts';
import {
  PRICED_MODEL,
  SENTINELS,
  geminiExport,
  geminiUsageDelta,
  parseGeminiMetrics,
} from './gemini-doubles.ts';

// S5b B2 (TEST_PLAN §S5b): the loopback receiver over real HTTP — `/v1/logs` and `/v1/traces`
// answered `200 {}` without parsing, and Gemini CLI usage end to end (hook attribution →
// cumulative baselines → `geminiUsageDelta` → spooled `usage.reported`). JD-C02 is replaced
// by local test doubles of its documented contract until lane A's implementation is merged.
vi.mock('@javis-dog/collector-adapters', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./gemini-doubles.ts')).doubles,
}));

const SECRET = 'gemini-secret-0123456789abcdef';
const TOKEN = `jd_it_${'M'.repeat(43)}`;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const post = (
  port: number,
  opts: { path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const body = opts.body ?? '';
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...opts.headers,
    };
    for (const [key, value] of Object.entries(headers)) if (value === '') delete headers[key];
    const req = request(
      { host: '127.0.0.1', port, path: opts.path ?? '/v1/metrics', method: 'POST', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });

const spooled = async (state: CollectorState, project: string) => {
  const dir = state.spoolDir(project);
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(
        async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as Record<string, unknown>,
      ),
  );
};
const usageEvents = async (state: CollectorState, project = 'web-app') =>
  (await spooled(state, project)).filter((e) => e.type === 'usage.reported');

/** A Gemini hook, recorded through the real runHook (mapper: the JD-C02 double). */
const geminiHook = (state: CollectorState, sessionId: string, projectRef = 'web-app') =>
  runHook({
    state,
    projectRef,
    platform: 'gemini-cli',
    stdin: JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart' }),
    spawnFlush: () => {},
  });

describe('receiver: Gemini CLI logs and traces sink', () => {
  let home: string;
  let state: CollectorState;
  let receiver: UsageReceiver;
  let port: number;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'javi-recv-gm-sink-'));
    state = createState(home);
    await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
    await state.saveUsageConfig({
      port: 4319,
      secret: SECRET,
      gemini: { path: '/x', written: {}, sha256: '' },
    });
    const { salt } = await state.installation();
    receiver = createUsageReceiver({ state, port: 0, secret: SECRET, salt, flush: async () => {} });
    port = await receiver.listen();
  });
  afterAll(async () => {
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });
  afterEach(() => vi.clearAllMocks());

  const logsBody = JSON.stringify({
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: SENTINELS[2] },
                attributes: [{ key: 'user.email', value: { stringValue: SENTINELS[0] } }],
              },
            ],
          },
        ],
      },
    ],
  });

  it.each([
    ['/v1/logs', 'an OTLP logs body', logsBody, {}],
    ['/v1/traces', 'malformed JSON', '{"resourceSpans": [', {}],
    [
      '/v1/logs',
      'a protobuf content type',
      'binary\u0000junk',
      { 'content-type': 'application/x-protobuf' },
    ],
    ['/v1/traces', 'a gzip header over garbage', 'not gzip', { 'content-encoding': 'gzip' }],
    ['/v1/logs', 'an empty body', '', {}],
  ])('%s with %s → 200 {}, body never parsed or kept', async (path, _name, body, headers) => {
    const info = await state.receiverInfo();
    const reply = await post(port, { path, body, headers });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{}');
    expect(reply.headers['x-javi-receiver-pid']).toBe(String(process.pid));
    expect(parseGeminiMetrics).not.toHaveBeenCalled();
    // Not an export: no counter, no "last export", nothing spooled anywhere.
    expect(await state.receiverInfo()).toEqual(info);
    expect(await spooled(state, 'web-app')).toEqual([]);
    for (const entry of await readdir(home, { recursive: true })) {
      if (!entry.endsWith('.json')) continue;
      const text = await readFile(join(home, entry), 'utf8');
      for (const s of SENTINELS) expect(text).not.toContain(s);
    }
  });

  it.each([
    ['no bearer', { authorization: '' }, 401],
    ['a wrong bearer', { authorization: 'Bearer nope-nope-nope-nope' }, 401],
    ['a foreign Host', { host: `evil.example:0` }, 403],
  ])('/v1/logs and /v1/traces with %s → %i', async (_name, headers, status) => {
    for (const path of ['/v1/logs', '/v1/traces']) {
      const reply = await post(port, { path, body: logsBody, headers });
      expect(reply.status).toBe(status);
    }
  });

  it('the 1 MiB limit still applies (declared and streamed)', async () => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
    expect((await post(port, { path: '/v1/logs', body: big })).status).toBe(413);
    const gz = gzipSync(Buffer.alloc(4 * MAX_BODY_BYTES, 0x20));
    // A small gzip body is not decompressed (never parsed), so it is simply accepted.
    expect(
      (await post(port, { path: '/v1/traces', body: gz, headers: { 'content-encoding': 'gzip' } }))
        .status,
    ).toBe(200);
  });
});

describe('receiver: Gemini CLI usage end to end', () => {
  let home: string;
  let state: CollectorState;
  let receiver: UsageReceiver;
  let port: number;
  let salt: string;
  const t0 = Date.parse('2026-10-29T10:00:00Z');

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'javi-recv-gm-usage-'));
    state = createState(home);
    await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
    await state.saveUsageConfig({
      port: 4319,
      secret: SECRET,
      gemini: { path: '/x', written: {}, sha256: '' },
    });
    expect(await geminiHook(state, 'gm-known')).toBe('recorded');
    salt = (await state.installation()).salt;
    receiver = createUsageReceiver({ state, port: 0, secret: SECRET, salt, flush: async () => {} });
    port = await receiver.listen();
  });
  afterAll(async () => {
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });

  const send = (body: unknown) => post(port, { body: JSON.stringify(body) });

  it('first cumulative point sets the baseline; the next yields one usage.reported', async () => {
    const start = t0;
    expect(
      (
        await send(
          geminiExport('gm-known', {
            startMs: start,
            endMs: t0 + 10_000,
            input: 1000,
            output: 100,
            cache: 400,
            thought: 50,
            tool: 7,
          }),
        )
      ).status,
    ).toBe(200);
    expect(await usageEvents(state)).toEqual([]);
    expect(geminiUsageDelta).not.toHaveBeenCalled();

    const reply = await send(
      geminiExport('gm-known', {
        startMs: start,
        endMs: t0 + 20_000,
        input: 1600,
        output: 160,
        cache: 700,
        thought: 80,
        tool: 9,
      }),
    );
    expect(reply.status).toBe(200);
    // The pipeline hands JD-C02 the raw deltas (input still including cache) and the end time.
    expect(geminiUsageDelta).toHaveBeenCalledTimes(1);
    expect(geminiUsageDelta).toHaveBeenCalledWith(
      { input_tokens: 600, output_tokens: 60, cache_read_tokens: 300, reasoning_tokens: 30 },
      PRICED_MODEL,
      new Date(t0 + 20_000),
    );
    const events = await usageEvents(state);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'usage.reported',
      thread_ref: opaqueRef('gm', 'gm-known', salt),
      occurred_at: new Date(t0 + 20_000).toISOString(),
      usage_delta: {
        input_tokens: 300,
        output_tokens: 60,
        cache_read_tokens: 300,
        reasoning_tokens: 30,
        cost_usd: 690 / 1_000_000,
        model: PRICED_MODEL,
        estimated: true,
      },
      attributes: { platform: 'gemini-cli' },
    });
    const raw = JSON.stringify(events);
    for (const s of [...SENTINELS, 'gm-known']) expect(raw).not.toContain(s);
    expect((await state.receiverInfo())?.forwarded).toBe(1);
  });

  it('a restart (new start time, smaller values) starts a new baseline: nothing negative', async () => {
    const before = (await usageEvents(state)).length;
    const restart = t0 + 60_000;
    await send(
      geminiExport('gm-known', { startMs: restart, endMs: restart + 10_000, input: 50, output: 5 }),
    );
    expect((await usageEvents(state)).length).toBe(before);
    await send(
      geminiExport('gm-known', { startMs: restart, endMs: restart + 20_000, input: 80, output: 9 }),
    );
    const events = await usageEvents(state);
    expect(events.length).toBe(before + 1);
    const last = events.find((e) => e.occurred_at === new Date(restart + 20_000).toISOString());
    expect(last?.usage_delta).toMatchObject({ input_tokens: 30, output_tokens: 4 });
  });

  it('an unpriced model reports tokens only, estimated: false', async () => {
    const start = t0 + 120_000;
    const model = 'gemini-unknown-9';
    await send(
      geminiExport('gm-known', { startMs: start, endMs: start + 10_000, output: 10, model }),
    );
    await send(
      geminiExport('gm-known', { startMs: start, endMs: start + 20_000, output: 25, model }),
    );
    const event = (await usageEvents(state)).find(
      (e) => (e.usage_delta as { model: string }).model === model,
    );
    expect(event?.usage_delta).toEqual({ output_tokens: 15, model, estimated: false });
  });

  it('a cache series appearing mid-session counts in full, so input − cache sees it (G5)', async () => {
    geminiUsageDelta.mockClear();
    const start = t0 + 150_000;
    const model = 'gemini-2.5-flash';
    await send(
      geminiExport('gm-known', { startMs: start, endMs: start + 10_000, input: 500, model }),
    );
    await send(
      geminiExport('gm-known', {
        startMs: start,
        endMs: start + 20_000,
        input: 900,
        cache: 300,
        model,
      }),
    );
    expect(geminiUsageDelta).toHaveBeenCalledWith(
      { input_tokens: 400, cache_read_tokens: 300 },
      model,
      new Date(start + 20_000),
    );
    const event = (await usageEvents(state)).find(
      (e) => e.occurred_at === new Date(start + 20_000).toISOString(),
    );
    expect(event?.usage_delta).toEqual({
      input_tokens: 100,
      cache_read_tokens: 300,
      model,
      estimated: false,
    });
  });

  it('usage of a session no hook saw is dropped locally', async () => {
    const before = (await usageEvents(state)).length;
    const dropped = (await state.receiverInfo())!.dropped;
    const start = t0 + 180_000;
    await send(geminiExport('gm-stranger', { startMs: start, endMs: start + 10_000, output: 1 }));
    await send(geminiExport('gm-stranger', { startMs: start, endMs: start + 20_000, output: 9 }));
    expect((await usageEvents(state)).length).toBe(before);
    expect((await state.receiverInfo())!.dropped).toBe(dropped + 1);
  });

  it('Claude Code and Gemini CLI series with the same session id never share a baseline or id', async () => {
    // Register the same raw id as a Claude Code session too.
    await runHook({
      state,
      projectRef: 'web-app',
      stdin: JSON.stringify({ session_id: 'gm-known', hook_event_name: 'SessionStart' }),
      spawnFlush: () => {},
    });
    const start = t0 + 240_000;
    const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
    const claudePoint = (value: number, endMs: number) => ({
      attributes: [
        { key: 'session.id', value: { stringValue: 'gm-known' } },
        { key: 'model', value: { stringValue: PRICED_MODEL } },
        { key: 'type', value: { stringValue: 'output' } },
      ],
      startTimeUnixNano: ns(start),
      timeUnixNano: ns(endMs),
      asInt: String(value),
    });
    const combined = (claude: number, gemini: number, endMs: number) => {
      const body = geminiExport('gm-known', { startMs: start, endMs, output: gemini });
      body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.push({
        name: 'claude_code.token.usage',
        sum: { aggregationTemporality: 2, dataPoints: [claudePoint(claude, endMs)] },
      } as never);
      return body;
    };
    const before = (await usageEvents(state)).length;
    await send(combined(1000, 10, start + 10_000)); // baselines only, one per platform
    expect((await usageEvents(state)).length).toBe(before);
    await send(combined(1300, 40, start + 20_000));
    const fresh = (await usageEvents(state)).filter(
      (e) => e.occurred_at === new Date(start + 20_000).toISOString(),
    );
    expect(fresh).toHaveLength(2);
    const byPlatform = Object.fromEntries(
      fresh.map((e) => [(e.attributes as { platform: string }).platform, e]),
    );
    expect(byPlatform['claude-code']).toMatchObject({
      thread_ref: opaqueRef('cc', 'gm-known', salt),
      usage_delta: { output_tokens: 300, estimated: false },
    });
    expect(byPlatform['gemini-cli']).toMatchObject({
      thread_ref: opaqueRef('gm', 'gm-known', salt),
      usage_delta: { output_tokens: 30 },
    });
    expect(byPlatform['claude-code']!.event_id).not.toBe(byPlatform['gemini-cli']!.event_id);
  });

  it('a throwing Gemini parser never costs Claude Code usage of the same request', async () => {
    parseGeminiMetrics.mockImplementationOnce(() => {
      throw new Error('not implemented');
    });
    const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
    const end = t0 + 300_000;
    const reply = await send({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          { key: 'session.id', value: { stringValue: 'gm-known' } },
                          { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                          { key: 'type', value: { stringValue: 'input' } },
                        ],
                        startTimeUnixNano: ns(end - 60_000),
                        timeUnixNano: ns(end),
                        asInt: '42',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(reply.status).toBe(200);
    const event = (await usageEvents(state)).find(
      (e) => e.occurred_at === new Date(end).toISOString(),
    );
    expect(event).toMatchObject({
      attributes: { platform: 'claude-code' },
      usage_delta: { input_tokens: 42, model: 'claude-sonnet-4-5', estimated: false },
    });
  });
});
