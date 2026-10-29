import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_ENV_KEYS,
  claudeUserSettingsPath,
  createState,
  main,
  type CollectorState,
  type Io,
} from '../src/index.ts';
import { createUsageReceiver, isPidAlive } from '../src/receiver.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DROPPED = 'dropped (unattributed session, project without token, or invalid)';

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

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting for the asserted state');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A real `javi receive` child for the temp JAVI_HOME; resolves once receiver.json names it. */
const realReceiver = async () => {
  const child = spawn(process.execPath, [CLI, 'receive'], {
    env: { ...process.env, JAVI_HOME: home },
    stdio: 'ignore',
  });
  try {
    await waitFor(async () => (await state.receiverInfo())?.pid === child.pid);
  } catch (e) {
    child.kill(); // never leave a receiver behind
    throw e;
  }
  return child;
};

/** A process that is alive but is not a javi receiver (e.g. a recycled pid). */
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

  it('the backup never holds javi’s secret, the messages say what happened, a full off removes it (R7 twin)', async () => {
    const port = await freePort();
    const backup = `${settings}.javi-backup`;
    // No settings file: usage on creates it, then runs again (same or new port).
    const first = io();
    expect(await main(['usage', 'on', '--port', String(port)], first.value)).toBe(0);
    expect(first.out).toContain(
      'There was no settings file before, so there was nothing to back up.',
    );
    const again = io();
    expect(await main(['usage', 'on'], again.value)).toBe(0);
    expect(
      await stat(backup).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(again.out.join('\n')).not.toMatch(/backed up|A copy of/);
    expect(again.out).toContain(`No new backup: ${settings} already holds javi's usage keys.`);
    expect(await main(['usage', 'off'], io().value)).toBe(0);

    // An existing file: one copy before the change; a full usage off removes it.
    await writeFile(settings, '{"theme":"dark"}\n');
    const on = io();
    expect(await main(['usage', 'on', '--port', String(port)], on.value)).toBe(0);
    expect(on.out).toContain(`A copy of ${settings} as it was before this change is in ${backup}.`);
    expect(await readFile(backup, 'utf8')).toBe('{"theme":"dark"}\n');
    expect(await readFile(backup, 'utf8')).not.toContain((await state.usageConfig())!.secret);
    const off = io();
    expect(await main(['usage', 'off'], off.value)).toBe(0);
    expect(off.out).toContain(`Removed the backup ${backup}: it is no longer needed.`);
    expect(
      await stat(backup).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ theme: 'dark' });
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

  // S3e review #5: usage.json is saved before the settings edit, so settings never hold keys
  // javi forgot.
  it('does not touch the settings when usage.json cannot be saved', async () => {
    await mkdir(join(home, 'usage.json', 'blocker'), { recursive: true });
    await mkdir(join(claudeHome, '.claude'), { recursive: true });
    const original = '{"model":"opus"}\n';
    await writeFile(settings, original);
    const t = io();
    const code = await main(['usage', 'on', '--port', String(await freePort())], t.value).catch(
      () => 'threw',
    );
    expect(code).toBe(1);
    expect(await readFile(settings, 'utf8')).toBe(original);
    expect(t.err.join('\n')).toContain('usage.json');
    expect(t.receivers()).toBe(0);
  });

  it('restores the previous usage.json when the settings edit is refused or fails', async () => {
    const first = await freePort();
    expect(await main(['usage', 'on', '--port', String(first)], io().value)).toBe(0);
    const before = await readFile(join(home, 'usage.json'), 'utf8');

    // Refused: a foreign OTel key appeared in the settings meanwhile.
    const edited = JSON.parse(await readFile(settings, 'utf8')) as { env: Record<string, string> };
    edited.env.OTEL_LOGS_EXPORTER = 'otlp';
    await writeFile(settings, JSON.stringify(edited));
    expect(await main(['usage', 'on', '--port', String(await freePort())], io().value)).toBe(1);
    expect(await readFile(join(home, 'usage.json'), 'utf8')).toBe(before);

    // Throws: the settings path is a directory.
    await rm(settings);
    await mkdir(settings);
    const code = await main(['usage', 'on', '--port', String(await freePort())], io().value).catch(
      () => 'threw',
    );
    expect(code).toBe('threw');
    expect(await readFile(join(home, 'usage.json'), 'utf8')).toBe(before);

    // No previous usage.json: none is left behind.
    await rm(join(home, 'usage.json'));
    expect(
      await main(['usage', 'on', '--port', String(await freePort())], io().value).catch(
        () => 'threw',
      ),
    ).toBe('threw');
    expect(await state.usageConfig()).toBeNull();
    await expect(stat(join(home, 'usage.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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
        `Usage forwarded: 0, ${DROPPED}: 0`,
        'Last usage export: never',
      ]),
    );

    // S3e review #2: a live pid that is not a confirmed javi receiver is "not running".
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
      const unconfirmed = io();
      await main(['status', '--project', 'web-app'], unconfirmed.value);
      expect(unconfirmed.out).toContain('Usage receiver: not running');
    } finally {
      child.kill();
    }

    // A confirmed receiver (in-process here, so its pid is this test's pid).
    const config = (await state.usageConfig())!;
    const receiver = createUsageReceiver({ state, port, secret: config.secret, salt: 's' });
    await receiver.listen();
    try {
      const running = io();
      await main(['status', '--project', 'web-app'], running.value);
      expect(running.out).toEqual(
        expect.arrayContaining([
          `Usage receiver: running (pid ${process.pid})`,
          `Usage forwarded: 3, ${DROPPED}: 2`,
          'Last usage export: 2026-10-28T10:00:00.000Z',
        ]),
      );
      expect(running.out.join('\n')).not.toContain(config.secret);
      expect(running.out.join('\n')).not.toMatch(/another program/);
    } finally {
      await receiver.close();
    }
  });

  it('usage off removes exactly our keys, stops the receiver and forgets usage.json', async () => {
    await mkdir(join(claudeHome, '.claude'), { recursive: true });
    await writeFile(settings, JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }));
    expect(await main(['usage', 'on', '--port', String(await freePort())], io().value)).toBe(0);
    const child = await realReceiver();
    const exited = new Promise((r) => child.once('exit', r));

    const t = io();
    try {
      expect(await main(['usage', 'off'], t.value)).toBe(0);
    } finally {
      if (isPidAlive(child.pid)) child.kill();
    }
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

  // S3e review #2: the CLI never signals a pid the probe did not confirm.
  it('usage off never signals a live pid that is not a confirmed receiver', async () => {
    expect(await main(['usage', 'on', '--port', String(await freePort())], io().value)).toBe(0);
    const child = await sleeper();
    try {
      await state.saveReceiverInfo({
        pid: child.pid!,
        port: (await state.usageConfig())!.port,
        startedAt: 'x',
        forwarded: 0,
        dropped: 0,
        lastRequestAt: null,
      });
      const t = io();
      expect(await main(['usage', 'off'], t.value)).toBe(0);
      expect(isPidAlive(child.pid)).toBe(true);
      expect(t.out).toContain('No usage receiver was running.');
      expect(await state.receiverInfo()).toBeNull();
    } finally {
      child.kill();
    }
  });

  // S3e review #1: an unreadable settings file must not end in a claimed success.
  it.each([
    ['unparsable', (text: string) => text.replace(/}\s*$/, ',}')],
    ['not an object', () => '[]'],
    ['env not an object', () => '{"env":"x"}'],
  ])(
    'usage off on a %s settings file exits 1, keeps usage.json and says what to fix',
    async (_name, breakIt) => {
      expect(await main(['usage', 'on', '--port', String(await freePort())], io().value)).toBe(0);
      const config = (await state.usageConfig())!;
      const good = await readFile(settings, 'utf8');
      const broken = breakIt(good);
      await writeFile(settings, broken);

      const t = io();
      expect(await main(['usage', 'off'], t.value)).toBe(1);
      const text = [...t.out, ...t.err].join('\n');
      expect(text).toContain(settings);
      expect(text).toMatch(/javi usage off/);
      expect(text).not.toContain(config.secret);
      expect(text).not.toMatch(/no longer export|Removed from|already off/);
      expect(await state.usageConfig()).toEqual(config);
      expect(await readFile(settings, 'utf8')).toBe(broken);

      // Fixed by the user: running usage off again removes the keys.
      await writeFile(settings, good);
      const again = io();
      expect(await main(['usage', 'off'], again.value)).toBe(0);
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({});
      expect(await state.usageConfig()).toBeNull();
    },
  );

  // S3e review #3: a port held by another program is recorded and shown, silently for hooks.
  it('receive does not call a slow own receiver a foreign program (probe timeout, live recorded pid)', async () => {
    // A listener that accepts connections but never answers: the identity probe times out, as it
    // can when our own receiver is busy on a loaded machine (CI run 40619197881).
    const slow = createHttpServer(() => {});
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const port = (slow.address() as { port: number }).port;
    try {
      await state.saveUsageConfig({ port, secret: 'cli-secret-0123456789', written: {} });
      await state.saveReceiverInfo({
        pid: process.pid,
        port,
        startedAt: new Date().toISOString(),
        forwarded: 0,
        dropped: 0,
        lastRequestAt: null,
      });
      const t = io();
      expect(await main(['receive'], t.value)).toBe(0);
      expect([...t.out, ...t.err]).toEqual([]);
      const info = (await state.receiverInfo())!;
      expect(info.portConflict).toBeUndefined();
      expect(info.pid).toBe(process.pid);
    } finally {
      slow.closeAllConnections();
      await new Promise((r) => slow.close(r));
    }
  });

  it('receive records a port held by another program; status warns; usage on clears it', async () => {
    await state.saveCredentials('web-app', {
      endpoint: 'https://x.test/api/v1/events',
      token: TOKEN,
    });
    const holder = createHttpServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const port = (holder.address() as { port: number }).port;
    try {
      await state.saveUsageConfig({ port, secret: 'cli-secret-0123456789', written: {} });
      const t = io();
      const before = Date.now();
      expect(await main(['receive'], t.value)).toBe(0);
      expect([...t.out, ...t.err]).toEqual([]);
      const info = (await state.receiverInfo())!;
      expect(info.pid).toBe(0);
      expect(Date.parse(info.portConflict!.at)).toBeGreaterThanOrEqual(before - 1_000);

      const status = io();
      await main(['status', '--project', 'web-app'], status.value);
      const text = status.out.join('\n');
      expect(text).toContain(`another program holds 127.0.0.1:${port}`);
      expect(text).toMatch(/identity/);
      expect(text).toContain('javi usage off');
      expect(text).toContain('javi usage on --port <n>');
      expect(text).not.toMatch(/\blive\b|\bsecure\b/i);
    } finally {
      await new Promise((r) => holder.close(r));
    }
    // The port is free again: usage on succeeds and forgets the conflict.
    expect(await main(['usage', 'on', '--port', String(port)], io().value)).toBe(0);
    expect((await state.receiverInfo())?.portConflict).toBeUndefined();
    const status = io();
    await main(['status', '--project', 'web-app'], status.value);
    expect(status.out.join('\n')).not.toMatch(/another program/);
  });

  it('receive exits 0 without a conflict when our own receiver holds the port', async () => {
    const port = await freePort();
    const secret = 'cli-secret-0123456789';
    await state.saveUsageConfig({ port, secret, written: {} });
    const receiver = createUsageReceiver({ state, port, secret, salt: 's' });
    await receiver.listen();
    try {
      const t = io();
      expect(await main(['receive'], t.value)).toBe(0);
      expect([...t.out, ...t.err]).toEqual([]);
      const info = (await state.receiverInfo())!;
      expect(info).toMatchObject({ pid: process.pid, port });
      expect(info.portConflict).toBeUndefined();
    } finally {
      await receiver.close();
    }
  });

  it('usage needs a sub-command; receive needs usage on', async () => {
    expect(await main(['usage'], io().value)).toBe(2);
    const r = io();
    expect(await main(['receive'], r.value)).toBe(1);
    expect(r.err.join('\n')).toMatch(/javi usage on/);
  });
});
