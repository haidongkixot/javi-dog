import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createState, opaqueRef, runHook, type CollectorState } from '../src/index.ts';
import {
  MAX_BODY_BYTES,
  RECEIVER_FLUSH_GAP_MS,
  createUsageReceiver,
  ensureReceiver,
  type UsageReceiver,
} from '../src/receiver.ts';
import { SESSION_TTL_MS } from '../src/state.ts';

// U3 (TEST_PLAN §S3e): the local OTLP receiver over real HTTP on an ephemeral port, with the
// real file spool and state under a temp JAVI_HOME. Session attribution comes from a real hook.
const SECRET = 'test-secret-0123456789abcdef';
const TOKEN = `jd_it_${'R'.repeat(43)}`;
const IDENTITY = ['dev@example.com', 'user-abc-123', 'org-xyz-789', 'acct-uuid-456', 'iTerm.app'];

const otlpExport = (
  sessionId: string,
  opts: { startMs?: number; endMs?: number; input?: number; output?: number; cost?: number } = {},
) => {
  const endMs = opts.endMs ?? Date.now();
  const startMs = opts.startMs ?? endMs - 60_000;
  const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  const identity = [
    { key: 'user.email', value: { stringValue: 'dev@example.com' } },
    { key: 'user.id', value: { stringValue: 'user-abc-123' } },
    { key: 'organization.id', value: { stringValue: 'org-xyz-789' } },
    { key: 'user.account_uuid', value: { stringValue: 'acct-uuid-456' } },
    { key: 'terminal.type', value: { stringValue: 'iTerm.app' } },
  ];
  const point = (type: string | null, value: object) => ({
    attributes: [
      { key: 'session.id', value: { stringValue: sessionId } },
      { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
      ...(type ? [{ key: 'type', value: { stringValue: type } }] : []),
      ...identity,
    ],
    startTimeUnixNano: ns(startMs),
    timeUnixNano: ns(endMs),
    ...value,
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }, ...identity],
        },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code' },
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    point('input', { asInt: String(opts.input ?? 100) }),
                    point('output', { asInt: opts.output ?? 20 }),
                  ],
                },
              },
              {
                name: 'claude_code.cost.usage',
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [point(null, { asDouble: opts.cost ?? 0.01 })],
                },
              },
            ],
          },
        ],
      },
    ],
  };
};

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw node:http request (fetch cannot set Host). Chunked when `contentLength` is false. */
const post = (
  port: number,
  opts: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    contentLength?: boolean;
  } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const body = opts.body ?? '';
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
      ...(opts.contentLength === false
        ? {}
        : { 'content-length': String(Buffer.byteLength(body)) }),
      ...opts.headers,
    };
    // An empty override means "send without this header".
    for (const [key, value] of Object.entries(headers)) if (value === '') delete headers[key];
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? '/v1/metrics',
        method: opts.method ?? 'POST',
        headers,
      },
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
    if (opts.method === 'GET') req.end();
    else if (opts.contentLength === false) {
      // Chunked: several writes so the receiver sees a stream without a declared length.
      const buf = Buffer.from(body);
      for (let i = 0; i < buf.length; i += 64 * 1024) req.write(buf.subarray(i, i + 64 * 1024));
      req.end();
    } else req.end(body);
  });

const json = (value: unknown) => JSON.stringify(value);

/** Every file under a directory, recursively, as text. */
const allFiles = async (dir: string): Promise<Array<{ path: string; text: string }>> => {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out.push({ path, text: await readFile(path, 'utf8') });
  }
  return out;
};

const spooled = async (state: CollectorState, project: string) =>
  (await allFiles(state.spoolDir(project)).catch(() => []))
    .filter((f) => f.path.endsWith('.json'))
    .map((f) => JSON.parse(f.text) as Record<string, unknown>);

const usageEvents = async (state: CollectorState, project: string) =>
  (await spooled(state, project)).filter((e) => e.type === 'usage.reported');

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting for the asserted state');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A hook as Claude Code sends it, recorded through the real runHook. */
const hook = (state: CollectorState, sessionId: string, projectRef = 'web-app') =>
  runHook({
    state,
    projectRef,
    stdin: json({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' }),
    spawnFlush: () => {},
  });

describe('usage receiver over real HTTP', () => {
  let home: string;
  let state: CollectorState;
  let receiver: UsageReceiver;
  let port: number;
  const flushed: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'javi-recv-'));
    state = createState(home);
    await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
    expect(await hook(state, 'sess-known')).toBe('recorded');
    const { salt } = await state.installation();
    receiver = createUsageReceiver({
      state,
      port: 0,
      secret: SECRET,
      salt,
      flush: async (projectRef) => {
        flushed.push(projectRef);
      },
    });
    port = await receiver.listen();
  });
  afterAll(async () => {
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });

  const refusals: Array<[string, () => Promise<Reply>, number]> = [
    [
      'no bearer',
      () => post(port, { headers: { authorization: '' }, body: json(otlpExport('sess-known')) }),
      401,
    ],
    [
      'wrong bearer',
      () =>
        post(port, {
          headers: { authorization: 'Bearer nope-nope-nope-nope' },
          body: json(otlpExport('sess-known')),
        }),
      401,
    ],
    [
      'right secret, Basic scheme',
      () =>
        post(port, {
          headers: { authorization: `Basic ${SECRET}` },
          body: json(otlpExport('sess-known')),
        }),
      401,
    ],
    [
      'no bearer and a foreign Host (auth is checked first)',
      () =>
        post(port, {
          headers: { authorization: '', host: `evil.example:${port}` },
          body: json(otlpExport('sess-known')),
        }),
      401,
    ],
    [
      'foreign Host (DNS rebinding)',
      () =>
        post(port, {
          headers: { host: `evil.example:${port}` },
          body: json(otlpExport('sess-known')),
        }),
      403,
    ],
    [
      'loopback Host on another port',
      () =>
        post(port, {
          headers: { host: `127.0.0.1:${port + 1}` },
          body: json(otlpExport('sess-known')),
        }),
      403,
    ],
    [
      'protobuf',
      () => post(port, { headers: { 'content-type': 'application/x-protobuf' }, body: 'x' }),
      415,
    ],
    [
      'brotli',
      () =>
        post(port, { headers: { 'content-encoding': 'br' }, body: json(otlpExport('sess-known')) }),
      415,
    ],
    ['declared > 1 MiB', () => post(port, { body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20) }), 413],
    [
      'chunked > 1 MiB',
      () =>
        post(port, { body: Buffer.alloc(MAX_BODY_BYTES + 100_000, 0x20), contentLength: false }),
      413,
    ],
    [
      'gzip bomb (decoded > 1 MiB)',
      () =>
        post(port, {
          headers: { 'content-encoding': 'gzip' },
          body: gzipSync(Buffer.alloc(16 * MAX_BODY_BYTES, 0x20)),
        }),
      413,
    ],
    ['malformed JSON', () => post(port, { body: '{"resourceMetrics": [' }), 400],
    ['top-level array', () => post(port, { body: '[]' }), 400],
    ['resourceMetrics not an array', () => post(port, { body: '{"resourceMetrics": 5}' }), 400],
    [
      'invalid gzip',
      () => post(port, { headers: { 'content-encoding': 'gzip' }, body: 'not gzip' }),
      400,
    ],
    [
      'other path',
      () => post(port, { path: '/v1/traces', body: json(otlpExport('sess-known')) }),
      404,
    ],
  ];

  it.each(refusals)('refuses %s with %i and records nothing', async (_name, send, status) => {
    const before = await spooled(state, 'web-app');
    const info = await state.receiverInfo();
    const reply = await send();
    expect(reply.status).toBe(status);
    expect(reply.headers['content-type']).toBe('application/json');
    expect(await spooled(state, 'web-app')).toEqual(before);
    expect(await state.receiverInfo()).toEqual(info);
    expect(reply.body).not.toContain(SECRET);
  });

  it('answers 405 with Allow: POST for another method on the OTLP paths', async () => {
    for (const path of ['/v1/metrics', '/']) {
      const reply = await post(port, { path, method: 'GET' });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe('POST');
    }
    expect(await usageEvents(state, 'web-app')).toEqual([]);
  });

  it('forwards an attributed session: one usage.reported with the hook thread_ref', async () => {
    const start = (await spooled(state, 'web-app')).find((e) => e.type === 'session.started');
    expect(start).toBeDefined();
    const reply = await post(port, {
      body: json(otlpExport('sess-known', { input: 100, output: 20, cost: 0.01 })),
    });
    expect(reply).toMatchObject({ status: 200, body: '{}' });
    expect(reply.headers['content-type']).toBe('application/json');

    const usage = await usageEvents(state, 'web-app');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      project_ref: 'web-app',
      thread_ref: start!.thread_ref,
      usage_delta: {
        input_tokens: 100,
        output_tokens: 20,
        cost_usd: 0.01,
        model: 'claude-sonnet-4-5',
        estimated: false,
      },
    });
    expect(usage[0]!.sequence).toBe((start!.sequence as number) + 1);
    expect(await state.receiverInfo()).toMatchObject({
      forwarded: 1,
      dropped: 0,
      pid: process.pid,
      port,
    });
    await waitFor(() => flushed.includes('web-app'));
  });

  it('accepts the documented variants: path "/", Host localhost, gzip, charset', async () => {
    const before = (await usageEvents(state, 'web-app')).length;
    const t = Date.now() - 5_000;
    const replies = [
      await post(port, { path: '/', body: json(otlpExport('sess-known', { endMs: t })) }),
      await post(port, {
        headers: { host: `localhost:${port}`, 'content-type': 'application/json; charset=utf-8' },
        body: json(otlpExport('sess-known', { endMs: t + 1 })),
      }),
      await post(port, {
        headers: { 'content-encoding': 'gzip' },
        body: gzipSync(json(otlpExport('sess-known', { endMs: t + 2 }))),
      }),
    ];
    expect(replies.map((r) => [r.status, r.body])).toEqual([
      [200, '{}'],
      [200, '{}'],
      [200, '{}'],
    ]);
    expect(await usageEvents(state, 'web-app')).toHaveLength(before + 3);
  });

  it('drops and counts usage of sessions no hook attributed', async () => {
    const before = await spooled(state, 'web-app');
    const info = (await state.receiverInfo())!;
    const reply = await post(port, { body: json(otlpExport('sess-unknown')) });
    expect(reply).toMatchObject({ status: 200, body: '{}' });
    expect(await spooled(state, 'web-app')).toEqual(before);
    expect(await state.receiverInfo()).toMatchObject({
      forwarded: info.forwarded,
      dropped: info.dropped + 1,
    });
    expect((await state.receiverInfo())!.lastRequestAt).not.toBeNull();
  });

  it('never writes identity attributes, raw session ids or the secret under JAVI_HOME', async () => {
    const files = await allFiles(home);
    expect(files.length).toBeGreaterThan(3);
    for (const { path, text } of files) {
      for (const needle of [...IDENTITY, 'sess-known', 'sess-unknown', SECRET]) {
        expect(text, path).not.toContain(needle);
        expect(path).not.toContain(needle);
      }
    }
  });
});

describe('usage receiver lifecycle', () => {
  let home: string;
  let state: CollectorState;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'javi-recv-life-'));
    state = createState(home);
    await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('flushes a project at most once per 3 s', async () => {
    await hook(state, 'sess-known');
    const calls: number[] = [];
    const receiver = createUsageReceiver({
      state,
      port: 0,
      secret: SECRET,
      salt: (await state.installation()).salt,
      flush: async () => {
        calls.push(Date.now());
      },
    });
    const port = await receiver.listen();
    try {
      const t = Date.now() - 5_000;
      expect(
        (await post(port, { body: json(otlpExport('sess-known', { endMs: t })) })).status,
      ).toBe(200);
      await waitFor(() => calls.length === 1);
      expect(
        (await post(port, { body: json(otlpExport('sess-known', { endMs: t + 1 })) })).status,
      ).toBe(200);
      expect(
        (await post(port, { body: json(otlpExport('sess-known', { endMs: t + 2 })) })).status,
      ).toBe(200);
      await waitFor(() => calls.length === 2);
      expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(RECEIVER_FLUSH_GAP_MS - 50);
      expect(await usageEvents(state, 'web-app')).toHaveLength(3);
    } finally {
      await receiver.close();
    }
    expect(calls).toHaveLength(2);
  });

  it('drops attributed usage of a project whose credentials were removed', async () => {
    await hook(state, 'sess-known');
    await state.removeCredentials('web-app');
    const receiver = createUsageReceiver({
      state,
      port: 0,
      secret: SECRET,
      salt: (await state.installation()).salt,
      flush: async () => {},
    });
    const port = await receiver.listen();
    try {
      expect((await post(port, { body: json(otlpExport('sess-known')) })).status).toBe(200);
      expect(await state.receiverInfo()).toMatchObject({ forwarded: 0, dropped: 1 });
      expect(await usageEvents(state, 'web-app')).toEqual([]);
    } finally {
      await receiver.close();
    }
  });

  it('closes itself when idle, marks receiver.json stopped and keeps the counters', async () => {
    await state.saveReceiverInfo({
      pid: 0,
      port: 1,
      startedAt: 'x',
      forwarded: 4,
      dropped: 2,
      lastRequestAt: null,
    });
    const receiver = createUsageReceiver({
      state,
      port: 0,
      secret: SECRET,
      salt: 's',
      idleMs: 200,
    });
    const port = await receiver.listen();
    expect(await state.receiverInfo()).toMatchObject({
      pid: process.pid,
      port,
      forwarded: 4,
      dropped: 2,
    });
    await receiver.idle;
    expect(await state.receiverInfo()).toMatchObject({ pid: 0, port, forwarded: 4, dropped: 2 });
    await expect(post(port, { body: '{}' })).rejects.toThrow();
  });

  it('a second receiver on the same port fails with EADDRINUSE', async () => {
    const first = createUsageReceiver({ state, port: 0, secret: SECRET, salt: 's' });
    const port = await first.listen();
    try {
      const second = createUsageReceiver({ state, port, secret: SECRET, salt: 's' });
      await expect(second.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(await state.receiverInfo()).toMatchObject({ pid: process.pid, port });
    } finally {
      await first.close();
    }
  });
});

describe('usage state and hook wiring', () => {
  let home: string;
  let state: CollectorState;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'javi-usage-state-'));
    state = createState(home);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('remembers hashed session refs only, for 7 days', async () => {
    const ref = opaqueRef('cc', 'sess-1', 'salt');
    const t0 = Date.UTC(2026, 9, 1);
    expect(await state.rememberSession('sess-1', 'web-app', t0)).toBe(false);
    expect(await state.rememberSession(ref, 'web-app', t0)).toBe(true);
    expect(await state.sessionProject(ref, t0 + SESSION_TTL_MS - 1)).toBe('web-app');
    expect(await state.sessionProject('sess-1', t0)).toBeNull();
    expect(await state.sessionProject(ref, t0 + SESSION_TTL_MS)).toBeNull();
    // Stale entries are pruned when read.
    expect(await state.sessionProject(ref, t0)).toBeNull();
    const names = (await allFiles(home)).map((f) => f.path);
    expect(names.some((p) => p.includes('sess-1'))).toBe(false);
  });

  it('prunes stale sessions opportunistically when another session is remembered', async () => {
    const old = opaqueRef('cc', 'old', 'salt');
    const fresh = opaqueRef('cc', 'fresh', 'salt');
    const t0 = Date.UTC(2026, 9, 1);
    await state.rememberSession(old, 'web-app', t0);
    await state.rememberSession(fresh, 'api', t0 + SESSION_TTL_MS + 1);
    const names = await readdir(join(home, 'sessions'));
    expect(names).toContain(`${fresh}.json`);
    expect(names).not.toContain(`${old}.json`);
  });

  it('stores the usage config with mode 0600 and removes it', async () => {
    await state.saveUsageConfig({ port: 4319, secret: SECRET, written: { A: '1' } });
    expect(await state.usageConfig()).toEqual({ port: 4319, secret: SECRET, written: { A: '1' } });
    const { stat } = await import('node:fs/promises');
    if (process.platform !== 'win32') {
      expect((await stat(join(home, 'usage.json'))).mode & 0o777).toBe(0o600);
    }
    await state.removeUsageConfig();
    expect(await state.usageConfig()).toBeNull();
  });

  it('a hook asks for the receiver only when usage is on', async () => {
    await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
    let asked = 0;
    const run = () =>
      runHook({
        state,
        projectRef: 'web-app',
        stdin: json({ session_id: 'sess-h', hook_event_name: 'Stop' }),
        spawnFlush: () => {},
        ensureReceiver: () => {
          asked += 1;
        },
      });
    expect(await run()).toBe('recorded');
    expect(asked).toBe(0);
    await state.saveUsageConfig({ port: 4319, secret: SECRET, written: {} });
    expect(await run()).toBe('recorded');
    expect(asked).toBe(1);
    // A throwing ensureReceiver never costs the hook event.
    expect(
      await runHook({
        state,
        projectRef: 'web-app',
        stdin: json({ session_id: 'sess-h', hook_event_name: 'Stop' }),
        spawnFlush: () => {},
        ensureReceiver: () => {
          throw new Error('boom');
        },
      }),
    ).toBe('recorded');
    const salt = (await state.installation()).salt;
    expect(await state.sessionProject(opaqueRef('cc', 'sess-h', salt))).toBe('web-app');
  });

  it('ensureReceiver: running pid → nothing; dead pid → one spawn per 5 s', async () => {
    let spawned = 0;
    const spawnReceiver = () => {
      spawned += 1;
    };
    await state.saveReceiverInfo({
      pid: process.pid,
      port: 1,
      startedAt: 'x',
      forwarded: 0,
      dropped: 0,
      lastRequestAt: null,
    });
    expect(await ensureReceiver({ state, spawnReceiver })).toBe('running');

    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => dead.once('exit', r));
    await state.saveReceiverInfo({
      pid: dead.pid!,
      port: 1,
      startedAt: 'x',
      forwarded: 0,
      dropped: 0,
      lastRequestAt: null,
    });
    expect(await ensureReceiver({ state, spawnReceiver, now: () => 10_000 })).toBe('spawned');
    expect(await ensureReceiver({ state, spawnReceiver, now: () => 14_999 })).toBe('debounced');
    expect(await ensureReceiver({ state, spawnReceiver, now: () => 15_000 })).toBe('spawned');
    await state.saveReceiverInfo({
      pid: 0,
      port: 1,
      startedAt: 'x',
      forwarded: 0,
      dropped: 0,
      lastRequestAt: null,
    });
    expect(await ensureReceiver({ state, spawnReceiver, now: () => 30_000 })).toBe('spawned');
    expect(spawned).toBe(3);
  });
});
