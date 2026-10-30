import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createState } from '../src/index.ts';

// S5b B2 (TEST_PLAN §S5b): `javi hook --platform gemini-cli` as a real process, the way Gemini
// CLI runs it (synchronously: Gemini waits, then parses stdout, falling back to stderr). It
// must exit 0 with empty stdout and stderr within a time bound.
//
// One run through the real JD-C02 adapters: map, spool, sequence, detached flush. (The earlier
// stub-mapper run injected a module through `--import`; that loader added ~0.5–1 s of its own
// and made the bound measure the test harness instead of javi — CI run 40867278461.)
//
// The bound is measured on the built `javi.mjs`, the file users run. Running `src/cli.ts` makes
// Node strip the types of every source module on each start: locally 263–311 ms per hook against
// 124–139 ms for the bundle, and 1695 ms on a loaded CI runner (run 41076014566). That measured
// the dev entry point, not javi (S5d Guru finding SR-F3).
let CLI = '';
const TOKEN = `jd_it_${'H'.repeat(43)}`;
/** Gemini's default hook timeout is 60 s and javi registers 5 s; the budget here is far lower. */
const BOUND_MS = 1_500;

let server: Server;
let home: string;
let bundleDir = '';
/** Raw text of every batch the detached flushers delivered. */
const delivered: string[] = [];

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'javi-gm-bundle-'));
  const build = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
  execFileSync(process.execPath, [build, '--out', bundleDir], { stdio: 'ignore' });
  CLI = join(bundleDir, 'javi.mjs');
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text =
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString() : raw.toString();
      delivered.push(text);
      const n = (JSON.parse(text) as { events: unknown[] }).events.length;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: n, duplicates: 0, rejected: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  home = await mkdtemp(join(tmpdir(), 'javi-gm-proc-'));
  await createState(home).saveCredentials('web-app', {
    endpoint: `http://127.0.0.1:${port}/api/v1/events`,
    token: TOKEN,
  });
}, 60_000);
afterAll(async () => {
  // Give the detached flushers a moment to finish before their JAVI_HOME disappears.
  await new Promise((r) => setTimeout(r, 1_000));
  await new Promise((r) => server.close(r));
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

const runHook = (stdin: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        CLI,
        'hook',
        '--platform',
        'gemini-cli',
        '--project',
        'web-app',
        '--source',
        'javi-collector',
      ],
      { env: { ...process.env, JAVI_HOME: home } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    // Like Gemini's hookRunner: done when the process closes its pipes.
    child.on('close', (code) =>
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) }),
    );
    child.stdin.end(stdin);
  });

const payload = (event: string, extra: object = {}) =>
  JSON.stringify({
    session_id: 'gm-proc-session',
    transcript_path: '/home/dev/.gemini/tmp/x/chats/s.json',
    cwd: '/home/dev/secret-project',
    hook_event_name: event,
    timestamp: new Date().toISOString(),
    ...extra,
  });

const EVENTS: Array<[string, object]> = [
  ['SessionStart', { source: 'startup' }],
  ['BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'cat ~/.ssh/id' } }],
  ['AfterTool', { tool_name: 'run_shell_command', tool_response: { llmContent: 'SECRET' } }],
  ['BeforeAgent', { prompt: 'SECRET PROMPT' }],
  ['Notification', { notification_type: 'ToolPermission', message: 'm', details: {} }],
];

describe('javi hook --platform gemini-cli as a real process', () => {
  it(`full path with the real adapters: exit 0, empty stdout and stderr, each ≤ ${BOUND_MS} ms; events spooled`, async () => {
    const times: number[] = [];
    for (const [event, extra] of EVENTS) {
      const result = await runHook(payload(event, extra));
      expect(result, event).toMatchObject({ code: 0, stdout: '', stderr: '' });
      times.push(result.ms);
    }
    console.info(`gemini hook durations ms: ${times.join(', ')}`);
    expect(Math.max(...times)).toBeLessThanOrEqual(BOUND_MS);
    // Every mapped event is either still spooled or delivered by a detached flusher.
    const spool = createState(home).spoolDir('web-app');
    const seen = async () => {
      const files = (await readdir(spool, { recursive: true }).catch(() => [] as string[])).filter(
        (f) => f.endsWith('.json'),
      );
      const spooled = await Promise.all(files.map((f) => readFile(join(spool, f), 'utf8')));
      const types = [
        ...spooled.map((t) => (JSON.parse(t) as { type: string }).type),
        ...delivered.flatMap((t) =>
          (JSON.parse(t) as { events: Array<{ type: string }> }).events.map((e) => e.type),
        ),
      ];
      return { texts: [...spooled, ...delivered], types };
    };
    const until = Date.now() + 10_000;
    while ((await seen()).types.length < 5 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const { texts, types } = await seen();
    expect(new Set(types)).toEqual(
      new Set([
        'session.started',
        'task.started',
        'task.completed',
        'heartbeat',
        'attention.requested',
      ]),
    );
    for (const text of texts) {
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('gm-proc-session');
      expect(text).not.toContain('/home/dev');
      expect(text).not.toContain('.ssh');
    }
  });

  it('stays neutral on garbage stdin and an unknown project', async () => {
    expect(await runHook('{"oops"')).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });
});
