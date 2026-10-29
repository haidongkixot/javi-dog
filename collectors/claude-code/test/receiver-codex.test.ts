import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_LOGS_PATH,
  CODEX_MAX_BODY_BYTES,
  codexCostEventId,
  codexTokenEventId,
  createState,
  createUsageReceiver,
  opaqueRef,
  runHook,
  type CollectorState,
  type UsageReceiver,
} from '../src/index.ts';
import {
  SENTINELS,
  costLog,
  logsBody,
  parseCodexLogs,
  tokenLog,
  toolResultLog,
} from './codex-doubles.ts';

// S5c B2 (TEST_PLAN §S5c, ADR-0016 Changes C4–C6, H3, M1, M4): the loopback receiver's Codex
// logs path over real HTTP — hook attribution → JD-C02 allowlist (local doubles of its
// documented contract until lane A is merged) → `usage.reported` in the project's spool.
vi.mock('@javis-dog/collector-adapters', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./codex-doubles.ts')).codexDoubles,
}));

const SECRET = 'codex-secret-0123456789abcdef';
const TOKEN = `jd_it_${'X'.repeat(43)}`;

const post = (
  port: number,
  opts: { path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<{ status: number; body: string }> =>
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
      { host: '127.0.0.1', port, path: opts.path ?? CODEX_LOGS_PATH, method: 'POST', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });

const spoolText = async (state: CollectorState, project = 'web-app') => {
  const dir = state.spoolDir(project);
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const texts = await Promise.all(
    names.filter((n) => n.endsWith('.json')).map((n) => readFile(join(dir, n), 'utf8')),
  );
  return texts;
};
const usageEvents = async (state: CollectorState, project = 'web-app') =>
  (await spoolText(state, project))
    .map((t) => JSON.parse(t) as Record<string, unknown>)
    .filter((e) => e.type === 'usage.reported');

let home: string;
let state: CollectorState;
let receiver: UsageReceiver;
let port: number;
let salt: string;

const codexHook = (payload: Record<string, unknown>, projectRef = 'web-app') =>
  runHook({
    state,
    projectRef,
    platform: 'codex-cli',
    stdin: JSON.stringify(payload),
    spawnFlush: () => {},
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-recv-cx-'));
  state = createState(home);
  await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
  await state.saveUsageConfig({
    port: 4319,
    secret: SECRET,
    codex: { path: '/x/config.toml', block: '', separator: '', created: false },
  });
  ({ salt } = await state.installation());
  receiver = createUsageReceiver({ state, port: 0, secret: SECRET, salt, flush: async () => {} });
  port = await receiver.listen();
});
afterEach(async () => {
  await receiver.close();
  await rm(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('receiver: Codex CLI logs path (M1)', () => {
  it('needs the bearer and the loopback Host; GET is refused', async () => {
    const body = JSON.stringify(logsBody([]));
    expect((await post(port, { body, headers: { authorization: 'Bearer nope' } })).status).toBe(
      401,
    );
    expect((await post(port, { body, headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await post(port, { body })).status).toBe(200);
  });

  it('answers 413 above 5 MiB (declared or streamed, gzip too) without reading the content', async () => {
    const big = Buffer.alloc(CODEX_MAX_BODY_BYTES + 1, 'a');
    const declared = await post(port, { body: big });
    expect(declared.status).toBe(413);
    expect(declared.body).toBe(JSON.stringify({ message: 'Body larger than 5 MiB.' }));
    const bomb = gzipSync(Buffer.alloc(CODEX_MAX_BODY_BYTES + 10, ' '));
    const gz = await post(port, { body: bomb, headers: { 'content-encoding': 'gzip' } });
    expect(gz.status).toBe(413);
    // 2 MiB is fine on the Codex path (it would be 413 on /v1/metrics).
    const padded = JSON.stringify({ ...logsBody([]), pad: 'x'.repeat(2 * 1024 * 1024) });
    expect((await post(port, { body: padded })).status).toBe(200);
    expect((await post(port, { path: '/v1/metrics', body: padded })).status).toBe(413);
    expect(parseCodexLogs).toHaveBeenCalledTimes(1);
  });

  it('constant error messages: invalid JSON and non-OTLP bodies never echo content', async () => {
    const bad = await post(port, { body: `{"x": "${SENTINELS.prompt}"` });
    expect(bad).toEqual({ status: 400, body: JSON.stringify({ message: 'Invalid JSON.' }) });
    const notLogs = await post(port, { body: JSON.stringify([SENTINELS.prompt]) });
    expect(notLogs).toEqual({
      status: 400,
      body: JSON.stringify({ message: 'Not an OTLP logs request.' }),
    });
    parseCodexLogs.mockImplementationOnce(() => {
      throw new Error(SENTINELS.prompt);
    });
    const thrown = await post(port, { body: JSON.stringify(logsBody([])) });
    expect(thrown.status).toBe(400);
    expect(thrown.body).not.toContain(SENTINELS.prompt);
  });

  it('/v1/logs and /v1/traces stay unparsed sinks', async () => {
    const body = JSON.stringify(logsBody([tokenLog({ conversationId: 's', input: 1, output: 1 })]));
    for (const path of ['/v1/logs', '/v1/traces']) {
      expect(await post(port, { path, body })).toEqual({ status: 200, body: '{}' });
    }
    expect(parseCodexLogs).not.toHaveBeenCalled();
  });
});

describe('receiver: Codex CLI usage end to end (C4–C6, H3)', () => {
  it('tokens (input minus cached and cache write) and API-key cost reach the spool; content never does', async () => {
    await codexHook({ session_id: 'sess-1', hook_event_name: 'SessionStart', source: 'startup' });
    const body = logsBody([
      tokenLog({ conversationId: 'sess-1', input: 100, cached: 40, cacheWrite: 60, output: 9 }),
      tokenLog({
        conversationId: 'sess-1',
        input: 50,
        output: 5,
        timestamp: '2026-10-29T12:00:01.000Z',
      }),
      tokenLog({ conversationId: 'sess-1', input: 1, output: 1, error: true }),
      costLog({ conversationId: 'sess-1', turnId: 'turn-1', usd: '0.0125' }),
      toolResultLog(),
    ]);
    expect((await post(port, { body: JSON.stringify(body) })).status).toBe(200);
    const events = await usageEvents(state);
    const thread = opaqueRef('cx', 'sess-1', salt);
    expect(events).toHaveLength(3);
    const tokens = events.filter((e) => !('cost_usd' in (e.usage_delta as object)));
    expect(tokens.map((e) => e.usage_delta)).toEqual(
      expect.arrayContaining([
        {
          input_tokens: 0,
          cache_read_tokens: 40,
          cache_write_tokens: 60,
          output_tokens: 9,
          model: 'gpt-5-codex',
          estimated: false,
        },
        {
          input_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 5,
          model: 'gpt-5-codex',
          estimated: false,
        },
      ]),
    );
    const cost = events.find((e) => 'cost_usd' in (e.usage_delta as object))!;
    expect(cost.usage_delta).toEqual({ cost_usd: 0.0125, estimated: false });
    expect(cost.event_id).toBe(
      codexCostEventId(
        { conversationId: 'sess-1', turnId: 'turn-1', authMode: 'ApiKey', costUsd: 0.0125 },
        salt,
      ),
    );
    for (const e of events) {
      expect(e).toMatchObject({
        thread_ref: thread,
        project_ref: 'web-app',
        attributes: { platform: 'codex-cli' },
      });
      expect(e).not.toHaveProperty('agent_ref');
    }
    expect(
      events.find((e) => (e.usage_delta as { output_tokens?: number }).output_tokens === 9)!
        .occurred_at,
    ).toBe('2026-10-29T12:00:00.000Z');
    const all = (await spoolText(state)).join('\n');
    for (const sentinel of [SENTINELS.email, SENTINELS.toolArgs, 'sess-1', 'turn-1', 'ApiKey']) {
      expect(all).not.toContain(sentinel);
    }
    const info = await state.receiverInfo();
    expect(info).toMatchObject({ forwarded: 3, dropped: 0 });
  });

  it('ChatGPT or unknown auth mode: tokens only, no cost record (a missing cost is never 0)', async () => {
    await codexHook({ session_id: 'sess-2', hook_event_name: 'SessionStart' });
    const body = logsBody([
      tokenLog({ conversationId: 'sess-2', input: 10, output: 2, authMode: 'Chatgpt' }),
      costLog({ conversationId: 'sess-2', turnId: 't', usd: '1.5', authMode: 'Chatgpt' }),
      costLog({ conversationId: 'sess-2', turnId: 'u', usd: '1.5', authMode: '' }),
    ]);
    expect((await post(port, { body: JSON.stringify(body) })).status).toBe(200);
    const events = await usageEvents(state);
    expect(events).toHaveLength(1);
    expect(events[0]!.usage_delta).not.toHaveProperty('cost_usd');
  });

  it("a sub-agent's usage counts in its parent thread with its agent_ref; unknown ids are dropped and counted", async () => {
    await codexHook({ session_id: 'root', hook_event_name: 'SessionStart' });
    await codexHook({ session_id: 'root', hook_event_name: 'SubagentStart', agent_id: 'child-1' });
    const body = logsBody([
      tokenLog({ conversationId: 'child-1', input: 20, output: 4 }),
      costLog({ conversationId: 'child-1', turnId: 'ct', usd: '0.5' }),
      tokenLog({ conversationId: 'stranger', input: 99, output: 99 }),
      tokenLog({ conversationId: 'child-2-before-its-hook', input: 7, output: 7 }),
    ]);
    expect((await post(port, { body: JSON.stringify(body) })).status).toBe(200);
    const events = await usageEvents(state);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.thread_ref).toBe(opaqueRef('cx', 'root', salt));
      expect(e.agent_ref).toBe(opaqueRef('ag', 'child-1', salt));
    }
    expect(await state.receiverInfo()).toMatchObject({ forwarded: 2, dropped: 2 });
    // The link file holds hashed refs only.
    const links = (await readdir(join(home, 'subagents'))).filter((n) => !n.startsWith('.'));
    expect(links).toEqual([`${opaqueRef('cx', 'child-1', salt)}.json`]);
    const link = await readFile(join(home, 'subagents', links[0]!), 'utf8');
    expect(link).not.toMatch(/child-1|root/);
  });

  it('ids are deterministic: a replayed record gets the same event id', async () => {
    await codexHook({ session_id: 'sess-3', hook_event_name: 'SessionStart' });
    const record = { conversationId: 'sess-3', input: 3, output: 1 };
    const body = JSON.stringify(logsBody([tokenLog(record)]));
    await post(port, { body });
    await post(port, { body });
    const ids = (await usageEvents(state)).map((e) => e.event_id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(
      codexTokenEventId(
        {
          conversationId: 'sess-3',
          model: 'gpt-5-codex',
          authMode: 'ApiKey',
          timestamp: '2026-10-29T12:00:00.000Z',
          input: 3,
          cached: 0,
          cacheWrite: 0,
          output: 1,
        },
        salt,
      ),
    );
  });

  it('a failing project spool answers 503 but keeps what was appended; existing spool files are never deleted (M4)', async () => {
    await state.saveCredentials('other', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
    await codexHook({ session_id: 'sess-a', hook_event_name: 'SessionStart' });
    await codexHook({ session_id: 'sess-b', hook_event_name: 'SessionStart' }, 'other');
    // A spool file with the same deterministic id is already there (an earlier replay that is
    // waiting for its flush): javi must never take it back.
    const a = { conversationId: 'sess-a', input: 3, output: 1 };
    const id = codexTokenEventId(
      {
        ...a,
        model: 'gpt-5-codex',
        authMode: 'ApiKey',
        timestamp: '2026-10-29T12:00:00.000Z',
        cached: 0,
        cacheWrite: 0,
      },
      salt,
    );
    const existing = join(state.spoolDir('web-app'), `${id}.json`);
    await mkdir(state.spoolDir('web-app'), { recursive: true });
    await writeFile(existing, JSON.stringify({ event_id: id, type: 'usage.reported' }));
    // The second project's spool cannot be written: its folder is a file now.
    await rm(state.spoolDir('other'), { recursive: true, force: true });
    await writeFile(state.spoolDir('other'), 'not a folder');
    const body = logsBody([
      tokenLog(a),
      tokenLog({ conversationId: 'sess-b', input: 3, output: 1 }),
    ]);
    const reply = await post(port, { body: JSON.stringify(body) });
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({ message: 'Temporarily unavailable, please retry.' });
    const kept = await usageEvents(state, 'web-app');
    expect(kept.map((e) => e.event_id)).toEqual([id]);
    expect(await readFile(existing, 'utf8')).toContain(id);
    expect(await state.receiverInfo()).toMatchObject({ forwarded: 1 });
  });

  it('a re-sent record or re-logged turn cost is not spooled again, across restarts; sequences stay contiguous (item 8)', async () => {
    await codexHook({ session_id: 'sess-r', hook_event_name: 'SessionStart' });
    const first = JSON.stringify(
      logsBody([
        tokenLog({ conversationId: 'sess-r', input: 10, output: 2 }),
        costLog({ conversationId: 'sess-r', turnId: 'turn-r', usd: '0.25' }),
      ]),
    );
    expect((await post(port, { body: first })).status).toBe(200);
    expect((await post(port, { body: first })).status).toBe(200);
    // Codex logs the same turn cost again in a later batch.
    const cost = JSON.stringify(
      logsBody([costLog({ conversationId: 'sess-r', turnId: 'turn-r', usd: '0.25' })]),
    );
    expect((await post(port, { body: cost })).status).toBe(200);
    // The accepted ids survive a receiver restart.
    await receiver.close();
    receiver = createUsageReceiver({ state, port: 0, secret: SECRET, salt, flush: async () => {} });
    port = await receiver.listen();
    expect((await post(port, { body: first })).status).toBe(200);
    const next = JSON.stringify(
      logsBody([
        tokenLog({
          conversationId: 'sess-r',
          input: 4,
          output: 1,
          timestamp: '2026-10-29T12:00:05.000Z',
        }),
      ]),
    );
    expect((await post(port, { body: next })).status).toBe(200);
    const usage = await usageEvents(state);
    expect(usage).toHaveLength(3);
    expect(new Set(usage.map((e) => e.event_id)).size).toBe(3);
    const thread = opaqueRef('cx', 'sess-r', salt);
    const all = (await spoolText(state))
      .map((t) => JSON.parse(t) as { thread_ref: string; sequence: number })
      .filter((e) => e.thread_ref === thread)
      .map((e) => e.sequence)
      .sort((x, y) => x - y);
    expect(all).toEqual(all.map((_, i) => i)); // session.started + 3 usage, no gap
    expect(all).toHaveLength(4);
    // Only HMAC-derived event ids are kept, never raw conversation or turn ids.
    const accepted = await readFile(join(home, 'accepted', 'codex-cli.json'), 'utf8');
    expect(accepted).not.toMatch(/sess-r|turn-r/);
  });

  it('a project without credentials drops its records; nothing is spooled', async () => {
    await codexHook({ session_id: 'sess-4', hook_event_name: 'SessionStart' });
    await state.removeCredentials('web-app');
    const body = logsBody([tokenLog({ conversationId: 'sess-4', input: 3, output: 1 })]);
    expect((await post(port, { body: JSON.stringify(body) })).status).toBe(200);
    expect(await usageEvents(state)).toEqual([]);
  });
});
