import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createState, type CollectorState } from '../src/index.ts';
import { isPidAlive } from '../src/receiver.ts';

// U3 process layer (TEST_PLAN §S3e): real `node cli.ts receive` / `hook` children; idle timeout
// via JAVI_RECEIVER_IDLE_MS. Every wait polls for the state it then asserts, and no assertion
// races the idle timer against process start-up (CI run 40619197881: a second instance took
// longer than the idle window on a loaded runner, so the first had already exited).
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TOKEN = `jd_it_${'Q'.repeat(43)}`;
const SECRET = 'process-secret-0123456789';
/** Long enough that the receiver cannot idle out while a test still talks to it. */
const LONG_IDLE_MS = '120000';
/** The idle-exit case: generous margin over process start-up on a loaded runner. */
const IDLE_MS = '4000';

let home: string;
let state: CollectorState;
let port: number;
let ingest: Server;
const started = new Set<number>();

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address() as { port: number };
      s.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  // A stand-in ingest endpoint so the detached flusher a hook starts has somewhere to deliver.
  ingest = createHttpServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 0, duplicates: 0, rejected: [] }));
    });
  });
  await new Promise<void>((r) => ingest.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${(ingest.address() as { port: number }).port}/api/v1/events`;
  home = await mkdtemp(join(tmpdir(), 'javi-usage-proc-'));
  state = createState(home);
  port = await freePort();
  await state.saveCredentials('web-app', { endpoint, token: TOKEN });
  await state.saveUsageConfig({ port, secret: SECRET, written: {} });
});

afterAll(async () => {
  // Never leave a receiver behind, whoever started it.
  const info = await state.receiverInfo();
  for (const pid of [...started, info?.pid ?? 0]) {
    if (isPidAlive(pid)) process.kill(pid, 'SIGTERM');
  }
  await waitFor(() => [...started, info?.pid ?? 0].every((pid) => !isPidAlive(pid)));
  await new Promise((r) => ingest.close(r));
  await rm(home, { recursive: true, force: true });
});

const env = (idleMs = IDLE_MS) => ({
  ...process.env,
  JAVI_HOME: home,
  JAVI_RECEIVER_IDLE_MS: idleMs,
});

const run = (args: string[], stdin = '', idleMs = IDLE_MS) => {
  const child = spawn(process.execPath, [CLI, ...args], { env: env(idleMs) });
  if (child.pid) started.add(child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(stdin);
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
};

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting for the asserted state');
    await new Promise((r) => setTimeout(r, 50));
  }
};

const postEmpty = () =>
  new Promise<number>((resolve, reject) => {
    const body = '{"resourceMetrics":[]}';
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/metrics',
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json',
          'content-length': body.length,
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

describe('javi receive and hooks as real processes', () => {
  it('receive serves, a second instance on the port exits 0, the first exits 0 on SIGTERM', async () => {
    const first = run(['receive'], '', LONG_IDLE_MS);
    await waitFor(async () => (await state.receiverInfo())?.pid === first.child.pid);
    expect(await state.receiverInfo()).toMatchObject({ port, pid: first.child.pid });
    expect(await postEmpty()).toBe(200);

    const second = await run(['receive']).done;
    expect(second).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((await state.receiverInfo())?.pid).toBe(first.child.pid);

    expect((await state.receiverInfo())?.portConflict).toBeUndefined();

    first.child.kill('SIGTERM');
    expect(await first.done).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await state.receiverInfo()).toMatchObject({ pid: 0, port });
  });

  it('a hook with usage on starts the receiver and stays silent', async () => {
    const hook = await run(
      ['hook', '--project', 'web-app', '--source', 'javi-collector'],
      JSON.stringify({ session_id: 'sess-proc', hook_event_name: 'SessionStart' }),
    ).done;
    expect(hook).toEqual({ code: 0, stdout: '', stderr: '' });
    await waitFor(async () => {
      const info = await state.receiverInfo();
      return !!info && info.pid > 0 && isPidAlive(info.pid);
    });
    const info = (await state.receiverInfo())!;
    started.add(info.pid);
    expect(info.port).toBe(port);
    expect(await postEmpty()).toBe(200);
    // It idles out by itself as well.
    await waitFor(() => !isPidAlive(info.pid));
    expect((await state.receiverInfo())?.pid).toBe(0);
  });
});
