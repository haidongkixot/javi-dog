import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';
import { createProjectRepository } from '@javis-dog/projects';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claudeUserSettingsPath,
  createState,
  main,
  type CollectorState,
  type Io,
} from '../src/index.ts';
import { createUsageReceiver, type UsageReceiver } from '../src/receiver.ts';

/** A Claude Code metrics export (OTLP JSON, delta) for one session, with identity attributes. */
const otlpExport = (sessionId: string, value: { input: number; output: number; cost: number }) => {
  const endMs = Date.now();
  const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  const attr = (key: string, v: string) => ({ key, value: { stringValue: v } });
  const point = (type: string | null, v: object) => ({
    attributes: [
      attr('session.id', sessionId),
      attr('model', 'claude-sonnet-4-5'),
      ...(type ? [attr('type', type)] : []),
      attr('user.email', 'dev@example.com'),
      attr('user.id', 'user-abc-123'),
      attr('organization.id', 'org-xyz-789'),
      attr('terminal.type', 'iTerm.app'),
    ],
    startTimeUnixNano: ns(endMs - 60_000),
    timeUnixNano: ns(endMs),
    ...v,
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [attr('service.name', 'claude-code')] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point('input', { asInt: String(value.input) }),
                    point('output', { asInt: String(value.output) }),
                  ],
                },
              },
              {
                name: 'claude_code.cost.usage',
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [point(null, { asDouble: value.cost })],
                },
              },
            ],
          },
        ],
      },
    ],
  };
};

/** POST through node:http, as Claude Code's exporter does (loopback Host, bearer, JSON). */
const post = (port: number, secret: string, body: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/metrics',
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

// U3 e2e (TEST_PLAN §S3e): Claude Code export → local receiver → spool → runFlush → real
// JD-M05 ingest handler → PGlite. A retried export must dedupe on the server.
let client: PGlite;
let token: string;
let home: string;
let claudeHome: string;
let state: CollectorState;
let fetchToHandler: typeof fetch;
let receiver: UsageReceiver | undefined;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  const projects = createProjectRepository(db);
  const ws = await projects.createWorkspace({ name: 'Usage team' });
  const p = await projects.createProject(ws.id, { name: 'Web App', platforms: ['claude-code'] });
  token = (await projects.issueToken(ws.id, p.id, 'laptop')).token;
  const handler = createIngestHandler(createIngestDeps(db));
  fetchToHandler = async (url, init) => handler(new Request(url as string, init));
  home = await mkdtemp(join(tmpdir(), 'javi-usage-e2e-'));
  claudeHome = await mkdtemp(join(tmpdir(), 'javi-usage-e2e-claude-'));
  state = createState(home);
});
afterAll(async () => {
  await receiver?.close();
  await rm(home, { recursive: true, force: true });
  await rm(claudeHome, { recursive: true, force: true });
});

const io = (stdin = '') => {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env: { JAVI_HOME: home, JAVI_CLAUDE_HOME: claudeHome },
    cwd: home,
    readStdin: async () => stdin,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: () => {},
    spawnReceiver: () => {},
    fetch: fetchToHandler,
  };
  return { value, out, err };
};

const rows = async () =>
  (
    await client.query<{
      type: string;
      thread_ref: string;
      event_id: string;
      usage_delta: unknown;
    }>('select type, thread_ref, event_id, usage_delta from events order by received_at, sequence')
  ).rows;

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting for the asserted state');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('token usage end to end', () => {
  it('init --usage verifies the connection, then turns usage on in the temp Claude home', async () => {
    const t = io(token);
    const port = await freePort();
    const code = await main(
      [
        'init',
        '--project',
        'web-app',
        '--endpoint',
        'http://localhost/api/v1/events',
        '--dir',
        home,
        '--usage',
        '--port',
        String(port),
      ],
      t.value,
    );
    expect(t.err).toEqual([]);
    expect(code).toBe(0);
    expect(t.out.join('\n')).toMatch(/Connection verified[\s\S]*Token usage export enabled/);
    const settings = await readFile(claudeUserSettingsPath(claudeHome), 'utf8');
    expect(settings).toContain(`http://127.0.0.1:${port}/v1/metrics`);
    expect((await state.usageConfig())?.port).toBe(port);
  });

  it('receiver → spool → runFlush → ingest; a retried export is a server duplicate', async () => {
    const hook = JSON.stringify({ session_id: 'sess-known', hook_event_name: 'SessionStart' });
    expect(await main(['hook', '--project', 'web-app'], io(hook).value)).toBe(0);
    expect(await main(['flush', '--project', 'web-app', '--quiet'], io().value)).toBe(0);
    const started = (await rows()).find((r) => r.type === 'session.started')!;
    expect(started).toBeDefined();

    receiver = createUsageReceiver({
      state,
      port: 0,
      secret: 'e2e-secret-0123456789',
      salt: (await state.installation()).salt,
      fetch: fetchToHandler,
    });
    const port = await receiver.listen();
    const body = JSON.stringify(
      otlpExport('sess-known', { input: 1200, output: 340, cost: 0.0421 }),
    );
    // Wait for the receiver's own flush (a new lastFlush), not the hook flush above.
    const before = (await state.lastFlush('web-app'))?.at;
    expect(await post(port, 'e2e-secret-0123456789', body)).toBe(200);
    await waitFor(async () => (await state.lastFlush('web-app'))?.at !== before);
    expect(await state.lastFlush('web-app')).toMatchObject({
      status: 'ok',
      accepted: 1,
      duplicates: 0,
    });
    const usage = (await rows()).filter((r) => r.type === 'usage.reported');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.thread_ref).toBe(started.thread_ref);
    expect(usage[0]!.usage_delta).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cost_usd: 0.0421,
      model: 'claude-sonnet-4-5',
      estimated: false,
    });

    // Claude Code retries the identical export (e.g. after a timeout).
    expect(await post(port, 'e2e-secret-0123456789', body)).toBe(200);
    await waitFor(async () => (await state.lastFlush('web-app'))?.duplicates === 1);
    expect(await state.lastFlush('web-app')).toMatchObject({
      status: 'ok',
      accepted: 0,
      duplicates: 1,
      remaining: 0,
    });
    expect((await rows()).filter((r) => r.type === 'usage.reported')).toHaveLength(1);

    const stored = JSON.stringify(await rows());
    for (const needle of [
      'sess-known',
      'dev@example.com',
      'org-xyz-789',
      'user-abc-123',
      'iTerm.app',
    ]) {
      expect(stored).not.toContain(needle);
    }
  });
});
