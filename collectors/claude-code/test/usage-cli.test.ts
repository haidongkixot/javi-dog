import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_ENV_KEYS,
  claudeUserSettingsPath,
  createState,
  main,
  type CollectorState,
  type Io,
} from '../src/index.ts';

// U3 (TEST_PLAN §S3e): `javi usage on|off` and the `status` usage lines, in-process, against a
// temp JAVI_HOME and a temp Claude home (never the real ~/.claude).
let home: string;
let claudeHome: string;
let state: CollectorState;
let settings: string;
const TOKEN = `jd_it_${'U'.repeat(43)}`;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-usage-home-'));
  claudeHome = await mkdtemp(join(tmpdir(), 'javi-usage-claude-'));
  state = createState(home);
  settings = claudeUserSettingsPath(claudeHome);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(claudeHome, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const io = (env: NodeJS.ProcessEnv = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  let receivers = 0;
  const value: Io = {
    env: { JAVI_HOME: home, JAVI_CLAUDE_HOME: claudeHome, ...env },
    cwd: home,
    readStdin: async () => '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: () => {},
    spawnReceiver: () => {
      receivers += 1;
    },
  };
  return { value, out, err, receivers: () => receivers };
};

/** A stand-in for a running receiver process (only its pid matters to the CLI). */
const sleeper = () =>
  new Promise<ChildProcess>((resolve) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    child.once('spawn', () => resolve(child));
  });

describe('javi usage on', () => {
  it('writes the exporter env, prints key names only, saves usage.json 0600, starts the receiver', async () => {
    const port = await freePort();
    await mkdir(join(claudeHome, '.claude'), { recursive: true });
    await writeFile(settings, JSON.stringify({ theme: 'dark', env: { FOO: 'bar' } }));
    const t = io();
    expect(await main(['usage', 'on', '--port', String(port)], t.value)).toBe(0);
    expect(t.err).toEqual([]);

    const config = (await state.usageConfig())!;
    expect(config.port).toBe(port);
    expect(config.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    if (process.platform !== 'win32') {
      expect((await stat(join(home, 'usage.json'))).mode & 0o777).toBe(0o600);
    }
    const written = JSON.parse(await readFile(settings, 'utf8')) as {
      theme: string;
      env: Record<string, string>;
    };
    expect(written.theme).toBe('dark');
    expect(written.env.FOO).toBe('bar');
    expect(written.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
      `http://127.0.0.1:${port}/v1/metrics`,
    );
    expect(written.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBe(
      `Authorization=Bearer ${config.secret}`,
    );

    const text = t.out.join('\n');
    for (const key of USAGE_ENV_KEYS) expect(text).toContain(key);
    expect(text).toContain(settings);
    expect(text).toContain(`${settings}.javi-backup`);
    expect(text).toMatch(/started from now on/);
    expect(text).not.toContain(config.secret);
    expect(text).not.toMatch(/\blive\b|\bsecure\b/i);
    expect(t.receivers()).toBe(1);

    // Again: same secret, still accepted (our own values are not a conflict).
    const again = io();
    expect(await main(['usage', 'on'], again.value)).toBe(0);
    expect((await state.usageConfig())!).toMatchObject({ port, secret: config.secret });
  });

  it('refuses a foreign OTEL_ key in the settings: prints only the key name, bytes unchanged', async () => {
    await mkdir(join(claudeHome, '.claude'), { recursive: true });
    const original = `{\n  "env": { "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.corp.example/tenant-s3cr3t" }\n}\n`;
    await writeFile(settings, original);
    const t = io();
    expect(await main(['usage', 'on', '--port', String(await freePort())], t.value)).toBe(1);
    const text = [...t.out, ...t.err].join('\n');
    expect(text).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(text).not.toContain('collector.corp.example');
    expect(text).not.toContain('tenant-s3cr3t');
    expect(await readFile(settings, 'utf8')).toBe(original);
    expect(await state.usageConfig()).toBeNull();
    expect(t.receivers()).toBe(0);
  });

  it('refuses a telemetry variable from the shell, naming the key only', async () => {
    const t = io({ OTEL_METRICS_EXPORTER: 'prometheus' });
    expect(await main(['usage', 'on', '--port', String(await freePort())], t.value)).toBe(1);
    expect(t.err.join('\n')).toContain('OTEL_METRICS_EXPORTER');
    expect(t.err.join('\n')).not.toContain('prometheus');
    await expect(stat(settings)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await state.usageConfig()).toBeNull();
  });

  it('refuses a port another program holds, and an invalid port', async () => {
    const holder: Server = createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const port = (holder.address() as { port: number }).port;
    try {
      const t = io();
      expect(await main(['usage', 'on', '--port', String(port)], t.value)).toBe(1);
      expect(t.err.join('\n')).toContain(`Port ${port}`);
      await expect(stat(settings)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise((r) => holder.close(r));
    }
    for (const bad of ['80', 'abc', '70000']) {
      expect(await main(['usage', 'on', '--port', bad], io().value)).toBe(2);
    }
  });
});

describe('javi usage off and status', () => {
  it('status shows usage off, then on with receiver state and counts', async () => {
    await state.saveCredentials('web-app', {
      endpoint: 'https://x.test/api/v1/events',
      token: TOKEN,
    });
    const off = io();
    expect(await main(['status', '--project', 'web-app'], off.value)).toBe(0);
    expect(off.out).toContain('Usage: off');

    const port = await freePort();
    expect(await main(['usage', 'on', '--port', String(port)], io().value)).toBe(0);
    const notRunning = io();
    await main(['status', '--project', 'web-app'], notRunning.value);
    expect(notRunning.out).toEqual(
      expect.arrayContaining([
        `Usage: on (port ${port})`,
        'Usage receiver: not running',
        'Usage forwarded: 0, dropped (unattributed): 0',
        'Last usage export: never',
      ]),
    );

    const child = await sleeper();
    try {
      await state.saveReceiverInfo({
        pid: child.pid!,
        port,
        startedAt: new Date().toISOString(),
        forwarded: 3,
        dropped: 2,
        lastRequestAt: '2026-10-28T10:00:00.000Z',
      });
      const running = io();
      await main(['status', '--project', 'web-app'], running.value);
      expect(running.out).toEqual(
        expect.arrayContaining([
          `Usage receiver: running (pid ${child.pid})`,
          'Usage forwarded: 3, dropped (unattributed): 2',
          'Last usage export: 2026-10-28T10:00:00.000Z',
        ]),
      );
      expect(running.out.join('\n')).not.toContain((await state.usageConfig())!.secret);
    } finally {
      child.kill();
    }
  });

  it('usage off removes exactly our keys, stops the receiver and forgets usage.json', async () => {
    await mkdir(join(claudeHome, '.claude'), { recursive: true });
    await writeFile(settings, JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }));
    expect(await main(['usage', 'on', '--port', String(await freePort())], io().value)).toBe(0);
    const child = await sleeper();
    const exited = new Promise((r) => child.once('exit', r));
    await state.saveReceiverInfo({
      pid: child.pid!,
      port: 1,
      startedAt: 'x',
      forwarded: 0,
      dropped: 0,
      lastRequestAt: null,
    });

    const t = io();
    expect(await main(['usage', 'off'], t.value)).toBe(0);
    await exited;
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({
      model: 'opus',
      env: { FOO: 'bar' },
    });
    const text = t.out.join('\n');
    for (const key of USAGE_ENV_KEYS) expect(text).toContain(key);
    expect(text).toContain('Usage receiver stopped.');
    expect(await state.usageConfig()).toBeNull();
    expect(await state.receiverInfo()).toBeNull();

    const again = io();
    expect(await main(['usage', 'off'], again.value)).toBe(0);
    expect(again.out).toEqual(['Token usage export is already off.']);
    const status = io();
    await main(['status', '--project', 'none'], status.value);
    expect(status.out).toContain('Usage: off');
  });

  it('usage off leaves a key the user changed afterwards', async () => {
    expect(await main(['usage', 'on', '--port', String(await freePort())], io().value)).toBe(0);
    const edited = JSON.parse(await readFile(settings, 'utf8')) as { env: Record<string, string> };
    edited.env.OTEL_METRICS_EXPORTER = 'console';
    await writeFile(settings, JSON.stringify(edited));
    const t = io();
    expect(await main(['usage', 'off'], t.value)).toBe(0);
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({
      env: { OTEL_METRICS_EXPORTER: 'console' },
    });
    expect(t.out.join('\n')).not.toMatch(/Removed from .*OTEL_METRICS_EXPORTER[,.]/);
  });

  it('usage needs a sub-command; receive needs usage on', async () => {
    expect(await main(['usage'], io().value)).toBe(2);
    const r = io();
    expect(await main(['receive'], r.value)).toBe(1);
    expect(r.err.join('\n')).toMatch(/javi usage on/);
  });
});
