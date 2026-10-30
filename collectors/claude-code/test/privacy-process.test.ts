import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detachedSpawner } from '../src/cli.ts';
import { childEnv } from '../src/child-env.ts';
import { filesUnder, leaks, makeRecoveryKey } from './privacy-fixtures.ts';

// Real `javi` processes (ADR-0018 §6, review H2, M3): the canary-first refusal leaves no file,
// the key never reaches a child's environment or argv, stdout, stderr or the spool, and the
// hidden prompt reads /dev/tty without echo. A local HTTP stub plays the receiver.
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TOKEN = `jd_it_${'K'.repeat(43)}`;
const linux = process.platform === 'linux';
const posix = process.platform !== 'win32';

let server: Server;
let endpoint: string;
let mode: 'accept' | 'reject' = 'accept';
const bodies: string[] = [];
let root: string;
let fakeBin: string;
let fixture: Awaited<ReturnType<typeof makeRecoveryKey>>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text =
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString() : raw.toString();
      bodies.push(text);
      const events = (JSON.parse(text) as { events: Array<{ event_id: string }> }).events;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          mode === 'accept'
            ? { accepted: events.length, duplicates: 0, rejected: [] }
            : {
                accepted: 0,
                duplicates: 0,
                rejected: events.map((e, index) => ({
                  index,
                  event_id: e.event_id,
                  issues: [
                    {
                      code: 'privacy_class_not_allowed',
                      path: 'privacy_class',
                      message: 'This project accepts privacy class L0 at most.',
                    },
                  ],
                })),
              },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`;
  root = await mkdtemp(join(tmpdir(), 'javi-privacy-proc-'));
  fixture = await makeRecoveryKey();
  // A fake `git` first on PATH: records its environment and argv, then fails like "not a repo".
  fakeBin = join(root, 'bin');
  await mkdir(join(root, 'git-dumps'), { recursive: true });
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, 'git'),
    `#!/bin/sh\nf="${join(root, 'git-dumps')}/$$"\nenv > "$f.env"\nprintf '%s\\n' "$@" > "$f.argv"\necho "fatal: not a git repository" >&2\nexit 128\n`,
  );
  await chmod(join(fakeBin, 'git'), 0o755);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
});

type Run = { code: number | null; stdout: string; stderr: string };
const run = (
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; stdin?: string; detached?: boolean } = {},
) =>
  new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd: opts.cwd ?? root,
      // detached → setsid: the child has no controlling terminal, so /dev/tty cannot open.
      detached: opts.detached ?? true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.stdin ?? '');
  });

let n = 0;
const dirs = async () => {
  const home = join(root, `home-${n}`);
  const projectDir = join(root, `project-${n++}`);
  await mkdir(projectDir, { recursive: true });
  return { home, projectDir };
};
const baseEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  HOME: root,
  JAVI_HOME: home,
  JAVI_INGEST_TOKEN: TOKEN,
});

describe.runIf(posix)('javi init --privacy as a real process', () => {
  it('canary refused (202 + privacy_class_not_allowed): exit 1, no file written, no key printed', async () => {
    mode = 'reject';
    const d = await dirs();
    const result = await run(
      ['init', '--project', 'shop-two', '--endpoint', endpoint, '--privacy', 'L2'],
      { ...baseEnv(d.home), JAVI_PRIVACY_KEY: fixture.key },
      { cwd: d.projectDir },
    );
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('privacy_class_not_allowed');
    expect(result.stderr).toContain('Nothing was saved: no token, key or hooks.');
    expect(await filesUnder(d.home)).toEqual([]);
    expect(await filesUnder(d.projectDir)).toEqual([]);
    expect(leaks(result.stdout + result.stderr, fixture.sentinels)).toEqual([]);
    // The canary was sent (L2, encrypted), and no request body carried the key.
    const sent = JSON.parse(bodies.at(-1)!).events[0];
    expect(sent.type).toBe('x.javi.collector.installed');
    expect(sent.privacy_class).toBe('L2');
    expect(leaks(bodies.join('\n'), fixture.sentinels)).toEqual([]);
  });

  it('no terminal and no key source: exit 2, nothing written', async () => {
    const d = await dirs();
    const result = await run(
      ['init', '--project', 'shop-two', '--endpoint', endpoint, '--privacy', 'L2'],
      baseEnv(d.home),
      { cwd: d.projectDir, detached: true },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/No terminal to read the recovery key from/);
    expect(await filesUnder(d.home)).toEqual([]);
  });

  it('accepted: key only in credentials.json; git children get an env without it; hooks too', async () => {
    mode = 'accept';
    const d = await dirs();
    const dumps = join(root, 'git-dumps');
    for (const f of await readdir(dumps)) await rm(join(dumps, f));
    const result = await run(
      ['init', '--project', 'shop-two', '--endpoint', endpoint, '--privacy', 'L2'],
      { ...baseEnv(d.home), JAVI_PRIVACY_KEY: fixture.key },
      { cwd: d.projectDir },
    );
    expect(result.code, result.stderr).toBe(0);
    // git ran (the .claude/settings.local.json exclude check) with the key absent.
    const dumped = await readdir(dumps);
    expect(dumped.filter((f) => f.endsWith('.env')).length).toBeGreaterThan(0);
    for (const f of dumped) {
      const text = await readFile(join(dumps, f), 'utf8');
      expect(text).not.toContain('JAVI_PRIVACY_KEY');
      expect(leaks(text, fixture.sentinels), f).toEqual([]);
    }
    expect(leaks(result.stdout + result.stderr, fixture.sentinels)).toEqual([]);
    const credentials = await readFile(join(d.home, 'credentials.json'), 'utf8');
    expect(credentials).toContain(fixture.key);
    for (const [path, text] of await filesUnder(d.home)) {
      if (path !== 'credentials.json') expect(leaks(text, fixture.sentinels), path).toEqual([]);
    }
    for (const [path, text] of await filesUnder(d.projectDir)) {
      expect(leaks(text, fixture.sentinels), path).toEqual([]);
    }

    // A hook process whose own environment holds the key (exported in the user's shell): the
    // event is recorded, the spool and the hook output never carry the key.
    const repo = join(d.projectDir, 'shop');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const hook = await run(
      ['hook', '--project', 'shop-two'],
      { ...baseEnv(d.home), JAVI_PRIVACY_KEY: fixture.key },
      {
        cwd: repo,
        stdin: JSON.stringify({ session_id: 's', cwd: repo, hook_event_name: 'UserPromptSubmit' }),
      },
    );
    expect(hook).toEqual({ code: 0, stdout: '', stderr: '' });
    for (const [path, text] of await filesUnder(d.home)) {
      if (path !== 'credentials.json') expect(leaks(text, fixture.sentinels), path).toEqual([]);
    }
    // The detached flush (started with childEnv: JAVI_HOME kept, key dropped) delivers both.
    const delivered = () =>
      bodies.flatMap((b) => (JSON.parse(b) as { events: Array<{ type: string }> }).events);
    for (let i = 0; i < 150 && !delivered().some((e) => e.type === 'x.javi.thread.identity'); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(delivered().map((e) => e.type)).toEqual(
      expect.arrayContaining(['heartbeat', 'x.javi.thread.identity']),
    );
    expect(leaks(bodies.join('\n'), fixture.sentinels)).toEqual([]);

    // status: class and kid, never the key.
    const status = await run(['status', '--project', 'shop-two'], baseEnv(d.home), {
      cwd: d.projectDir,
    });
    expect(status.stdout).toMatch(
      /Privacy class: L2 \(key [0-9A-Z]{8}; the key itself is never shown\)\./,
    );
    expect(leaks(status.stdout + status.stderr, fixture.sentinels)).toEqual([]);
  });
});

describe('start-up cost for L0 hooks', () => {
  it('loading cli.ts from a checkout does not load JD-M11 (it is loaded on demand)', async () => {
    const script = [
      "import { registerHooks } from 'node:module';",
      'let n = 0;',
      'registerHooks({ resolve(s, c, next) { const r = next(s, c);',
      "  if (r.url.includes('/packages/crypto/')) n++; return r; } });",
      `await import(${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)});`,
      'console.log(n);',
    ].join('\n');
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.on('close', () => resolve(text.trim()));
    });
    expect(out).toBe('0');
  });
});

describe('children never inherit the key', () => {
  it('childEnv drops JAVI_PRIVACY_KEY and keeps everything else', () => {
    const env = { JAVI_PRIVACY_KEY: fixture.key, JAVI_HOME: '/h', PATH: '/bin' };
    expect(childEnv(env)).toEqual({ JAVI_HOME: '/h', PATH: '/bin' });
    expect(env.JAVI_PRIVACY_KEY).toBe(fixture.key);
  });

  it('detachedSpawner passes an explicit env without the key and never puts it on argv', () => {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const fake = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      return { unref: () => {} };
    }) as unknown as typeof spawn;
    detachedSpawner(
      '/x/javi.mjs',
      { JAVI_PRIVACY_KEY: fixture.key, JAVI_HOME: '/h' },
      fake,
    )(['flush', '--project', 'shop-two', '--quiet']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toEqual({ JAVI_HOME: '/h' });
    expect(leaks(JSON.stringify(calls), fixture.sentinels)).toEqual([]);
  });

  it.runIf(linux)('/proc/<pid>/environ of a real detached child lacks the key', async () => {
    const probe = join(root, 'sleeper.mjs');
    await writeFile(probe, 'setTimeout(() => {}, 5000);\n');
    const child = detachedSpawner(probe, {
      ...process.env,
      JAVI_PRIVACY_KEY: fixture.key,
      JAVI_PROBE_MARK: 'present',
    })(['flush']);
    try {
      let environ = '';
      for (let i = 0; i < 50 && !environ.includes('JAVI_PROBE_MARK'); i++) {
        environ = await readFile(`/proc/${child.pid}/environ`, 'utf8').catch(() => '');
        if (!environ.includes('JAVI_PROBE_MARK')) await new Promise((r) => setTimeout(r, 50));
      }
      expect(environ).toContain('JAVI_PROBE_MARK=present');
      expect(environ).not.toContain('JAVI_PRIVACY_KEY');
      expect(leaks(environ, fixture.sentinels)).toEqual([]);
      const cmdline = await readFile(`/proc/${child.pid}/cmdline`, 'utf8');
      expect(leaks(cmdline, fixture.sentinels)).toEqual([]);
    } finally {
      child.kill();
    }
  });
});

/** Runs `command` inside a pseudo-terminal (util-linux `script`), typing `input` after `waitFor`. */
const inPty = (command: string, env: NodeJS.ProcessEnv, waitFor: string, input: string) =>
  new Promise<{ code: number | null; transcript: string }>((resolve) => {
    const child = spawn('script', ['-qec', command, '/dev/null'], { env, cwd: root });
    let transcript = '';
    let typed = false;
    child.stdout.on('data', (d) => {
      transcript += d;
      if (!typed && transcript.includes(waitFor)) {
        typed = true;
        // Typed only once the prompt (and raw mode) is up, as a person would.
        setTimeout(() => child.stdin.write(input), 100);
      }
    });
    child.stderr.on('data', (d) => (transcript += d));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, transcript });
    });
  });

const hasScript = linux && existsSync('/usr/bin/script');

describe.runIf(hasScript)('hidden prompt on /dev/tty (util-linux script as the terminal)', () => {
  it('javi init --privacy L2 reads the key from the terminal without echoing it', async () => {
    mode = 'accept';
    const d = await dirs();
    const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
    const command = [
      quote(process.execPath),
      quote(CLI),
      'init',
      '--project',
      'shop-two',
      '--endpoint',
      quote(endpoint),
      '--privacy',
      'L2',
      '--dir',
      quote(d.projectDir),
    ].join(' ');
    const { code, transcript } = await inPty(
      command,
      { ...baseEnv(d.home), TERM: 'dumb' },
      '(input hidden): ',
      `${fixture.key}\r`,
    );
    expect(transcript).toContain('Recovery key for shop-two (input hidden): ');
    expect(code, transcript).toBe(0);
    expect(transcript).toMatch(/Privacy class L2: recovery key stored in/);
    expect(leaks(transcript, fixture.sentinels)).toEqual([]);
    const credentials = JSON.parse(await readFile(join(d.home, 'credentials.json'), 'utf8'));
    expect(credentials['shop-two'].privacy).toEqual({ class: 'L2', key: fixture.key });
  });
});
