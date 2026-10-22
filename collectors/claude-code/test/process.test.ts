import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createState } from '../src/index.ts';

// Real processes, as Claude Code runs them: `node cli.ts hook` with JSON on stdin, then the
// detached `javi flush` it spawns must deliver to the receiver (a local HTTP server here).
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TOKEN = `jd_it_${'P'.repeat(43)}`;

let server: Server;
let endpoint: string;
let home: string;
const received: Array<{ auth: string | undefined; types: string[] }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text =
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString() : raw.toString();
      const events = (JSON.parse(text) as { events: Array<{ type: string }> }).events;
      received.push({ auth: req.headers.authorization, types: events.map((e) => e.type) });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: events.length, duplicates: 0, rejected: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  endpoint = `http://127.0.0.1:${port}/api/v1/events`;
  home = await mkdtemp(join(tmpdir(), 'javi-proc-'));
  await createState(home).saveCredentials('web-app', { endpoint, token: TOKEN });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(home, { recursive: true, force: true });
});

const runHook = (stdin: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [CLI, 'hook', '--project', 'web-app', '--source', 'javi-collector'],
      {
        env: { ...process.env, JAVI_HOME: home },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });

const waitFor = async (check: () => boolean, ms = 15_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for delivery');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('javi hook as a real process', () => {
  it('exits 0 with empty stdout and stderr, and the detached flusher delivers', async () => {
    const result = await runHook(
      JSON.stringify({
        session_id: 'sess-proc',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs permission to run rm -rf /secret',
      }),
    );
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    await waitFor(() => received.some((r) => r.types.includes('attention.requested')));
    expect(received[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(await createState(home).lastFlush('web-app')).toMatchObject({ status: 'ok' });
  });

  it('stays neutral on garbage stdin', async () => {
    expect(await runHook('{"oops"')).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });
});
