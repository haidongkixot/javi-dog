import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseGeminiMetrics } from '@javis-dog/collector-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createState,
  createUsageReceiver,
  main,
  opaqueRef,
  runFlush,
  type CollectorState,
  type Io,
  type UsageReceiver,
} from '../src/index.ts';

// S5b review V1: one Gemini CLI session end to end through the REAL JD-C02 adapters (no test
// doubles): `javi init` + `usage on --platform gemini-cli` → SessionStart hook (mapGeminiHook,
// attribution) → loopback receiver over HTTP (parseGeminiMetrics, R2–R6) → spool → flush batch.
// Checks that the in-memory series id and auth type never reach the spool, state or batches.

const TOKEN = `jd_it_${'I'.repeat(43)}`;
const SESSION = 'gm-integration-session-7f3a';
const EMAIL = 'dev-integration@example.com';
const a = (key: string, value: string) => ({ key, value: { stringValue: value } });

let root: string;
let home: string;
let project: string;
let state: CollectorState;
let receiver: UsageReceiver;
let port: number;
let secret: string;
let salt: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address() as { port: number };
      s.close(() => resolve(p));
    });
  });

const io = (opts: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Io => ({
  env: {
    JAVI_HOME: home,
    JAVI_GEMINI_HOME: join(root, 'user'),
    JAVI_CLAUDE_HOME: join(root, 'claude'),
    ...opts.env,
  },
  cwd: project,
  readStdin: async () => opts.stdin ?? '',
  out: () => {},
  err: () => {},
  spawnFlush: () => {},
  spawnReceiver: () => {},
});

const post = (path: string, body: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
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

/** A Gemini export as gemini-cli sends it: common attributes on every point. */
const geminiExport = (
  startMs: number,
  endMs: number,
  points: Array<{ type: string; v: number; startOffsetMs?: number; email?: string }>,
) => {
  const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  return {
    resourceMetrics: [
      {
        resource: { attributes: [a('service.name', 'gemini-cli'), a('session.id', SESSION)] },
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
                      a('session.id', SESSION),
                      a('installation.id', 'inst-integration-1'),
                      { key: 'interactive', value: { boolValue: true } },
                      a('user.email', p.email ?? EMAIL),
                      a('auth_type', 'vertex-ai'),
                      {
                        key: 'experiments.ids',
                        value: { arrayValue: { values: [{ intValue: '42' }] } },
                      },
                      a('model', 'gemini-2.5-pro'),
                      a('type', p.type),
                    ],
                    startTimeUnixNano: ns(startMs + (p.startOffsetMs ?? 0)),
                    timeUnixNano: ns(endMs),
                    asInt: String(p.v),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
};

const filesUnder = async (dir: string) => {
  const texts: string[] = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const path = join(dir, entry);
    if ((await stat(path)).isFile()) texts.push(await readFile(path, 'utf8'));
  }
  return texts.join('\n');
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'javi-gm-int-'));
  home = join(root, 'javi');
  project = join(root, 'web-app');
  await mkdir(project, { recursive: true });
  state = createState(home);
  expect(
    await main(
      ['init', '--project', 'web-app', '--platform', 'gemini-cli', '--no-verify'],
      io({ env: { JAVI_INGEST_TOKEN: TOKEN } }),
    ),
  ).toBe(0);
  expect(
    await main(
      ['usage', 'on', '--platform', 'gemini-cli', '--port', String(await freePort())],
      io(),
    ),
  ).toBe(0);
  const config = (await state.usageConfig())!;
  secret = config.secret;
  salt = (await state.installation()).salt;
  receiver = createUsageReceiver({
    state,
    port: config.port,
    secret,
    salt,
    flush: async () => {}, // delivered explicitly below
  });
  port = await receiver.listen();
});
afterAll(async () => {
  await receiver.close();
  await rm(root, { recursive: true, force: true });
});

describe('Gemini CLI session through the real JD-C02 adapters', () => {
  it('hook → attribution → receiver → spool → batch, with no series id or auth type on disk or the wire', async () => {
    // SessionStart through the real mapper; it also registers the session for usage.
    const hook = io({
      stdin: JSON.stringify({
        session_id: SESSION,
        hook_event_name: 'SessionStart',
        source: 'startup',
        cwd: project,
      }),
    });
    expect(await main(['hook', '--platform', 'gemini-cli', '--project', 'web-app'], hook)).toBe(0);

    // The Gemini process started after the receiver (R2): its first export counts from 0.
    const start = Date.now() + 1_000;
    const first = geminiExport(start, start + 10_000, [
      { type: 'input', v: 10_000 },
      { type: 'cache', v: 4_000, startOffsetMs: 1 }, // created 1 ms later (R3)
      { type: 'output', v: 500 },
      { type: 'thought', v: 100 },
      { type: 'tool', v: 77 },
    ]);
    const second = geminiExport(start, start + 20_000, [
      { type: 'input', v: 16_000 },
      { type: 'cache', v: 9_000, startOffsetMs: 1 },
      { type: 'output', v: 900 },
      { type: 'thought', v: 150 },
      { type: 'tool', v: 99 },
      // A second output series that differs only in user.email (R4), new in this export: its
      // siblings already have baselines, so it counts from 0 (G5).
      { type: 'output', v: 40, email: 'other@example.com' },
    ]);
    for (const body of [first, second]) {
      expect(await post('/v1/metrics', JSON.stringify(body))).toEqual({ status: 200, body: '{}' });
    }
    // Logs and traces of the same session: answered, never read.
    expect((await post('/v1/logs', JSON.stringify({ resourceLogs: [EMAIL] }))).status).toBe(200);

    const spoolDir = state.spoolDir('web-app');
    const spooled = await Promise.all(
      (await readdir(spoolDir, { recursive: true }))
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => JSON.parse(await readFile(join(spoolDir, n), 'utf8'))),
    );
    const threadRef = opaqueRef('gm', SESSION, salt);
    expect(spooled.find((e) => e.type === 'session.started')).toMatchObject({
      thread_ref: threadRef,
    });
    const usage = spooled
      .filter((e) => e.type === 'usage.reported')
      .sort((x, y) => String(x.occurred_at).localeCompare(String(y.occurred_at)));
    expect(usage.map((e) => e.usage_delta)).toEqual([
      {
        // one group per export (R3): input 10000 − cache 4000; cost: vertex-ai is per-token (R6)
        input_tokens: 6_000,
        cache_read_tokens: 4_000,
        output_tokens: 500,
        reasoning_tokens: 100,
        // (6000 × 1.25 + 4000 × 0.125 + 600 × 10) / 1e6
        cost_usd: 0.014,
        model: 'gemini-2.5-pro',
        estimated: false, // R5
      },
      {
        input_tokens: 1_000, // (16000 − 10000) − (9000 − 4000)
        cache_read_tokens: 5_000,
        output_tokens: 440, // 400 + 40 from the new email series (R4)
        reasoning_tokens: 50,
        // (1000 × 1.25 + 5000 × 0.125 + 490 × 10) / 1e6
        cost_usd: 0.006775,
        model: 'gemini-2.5-pro',
        estimated: false,
      },
    ]);
    for (const e of usage) {
      expect(e).toMatchObject({ thread_ref: threadRef, attributes: { platform: 'gemini-cli' } });
    }

    // Deliver the spool and capture the batches the ingest endpoint would get.
    const batches: string[] = [];
    const result = await runFlush({
      state,
      projectRef: 'web-app',
      fetch: async (_url, init) => {
        // The SDK gzips larger batches: decode exactly what would go over the wire.
        const raw = init?.body;
        const body = typeof raw === 'string' ? raw : gunzipSync(raw as Uint8Array).toString('utf8');
        batches.push(body);
        const n = (JSON.parse(body) as { events: unknown[] }).events.length;
        return new Response(JSON.stringify({ accepted: n, duplicates: 0, rejected: [] }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(result).toMatchObject({ status: 'ok', accepted: 3 });

    // Neither the in-memory series ids nor the auth type, identity or raw session id is ever
    // written: not in ~/.javi (spool, state, receiver.json) and not in the batches.
    const seriesIds = [first, second].flatMap((body) => {
      const parsed = parseGeminiMetrics(body);
      return parsed.ok ? parsed.points.map((p) => p.seriesId!) : [];
    });
    expect(new Set(seriesIds).size).toBe(5); // input, cache, output, thought, output (email)
    const written = `${await filesUnder(home)}\n${batches.join('\n')}`;
    for (const needle of [
      ...seriesIds,
      'vertex-ai',
      'authType',
      'seriesId',
      EMAIL,
      'other@example.com',
      'inst-integration-1',
      SESSION,
    ]) {
      expect(written, needle).not.toContain(needle);
    }
  });
});
