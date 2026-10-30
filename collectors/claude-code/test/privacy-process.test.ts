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
  opts: { cwd?: string; stdin?: string; detached?: boolean; script?: string } = {},
) =>
  new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, [opts.script ?? CLI, ...args], {
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

// Security review L7: the built bundle swaps crypto-loader.ts for crypto-loader.bundle.ts
// (scripts/build.mjs `static-crypto`). Only a run of the bundle itself exercises that path.
describe.runIf(posix)('javi init --privacy L2 from the built bundle (security review L7)', () => {
  const BUILD = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
  let bundle: string;
  let built: Run;
  beforeAll(async () => {
    const out = join(root, 'dist');
    bundle = join(out, 'javi.mjs');
    // Built into the temp dir (as test/mcp-process.test.ts does): the repo's dist/ stays as is.
    built = await new Promise<Run>((resolve) => {
      const child = spawn(process.execPath, [BUILD, '--out', out], { cwd: root });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }, 60_000);

  it('key file → canary, hook → flush → identity event that decrypts with @javis-dog/crypto', async () => {
    expect(built.code, built.stderr).toBe(0);
    // JD-M11 is inlined: no import of @javis-dog/crypto is left for node to resolve at run time.
    expect(await readFile(bundle, 'utf8')).not.toMatch(/import\(["']@javis-dog\/crypto["']\)/);
    mode = 'accept';
    const d = await dirs();
    const keyFile = join(root, `bundle-key-${n}.txt`);
    await writeFile(keyFile, `${fixture.key}\n`);
    await chmod(keyFile, 0o600);
    const before = bodies.length;

    const init = await run(
      [
        'init',
        '--project',
        'shop-two',
        '--endpoint',
        endpoint,
        '--privacy',
        'L2',
        '--privacy-key-file',
        keyFile,
      ],
      baseEnv(d.home),
      { cwd: d.projectDir, script: bundle },
    );
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toMatch(/Privacy class L2: recovery key stored in/);
    // The hooks run the installed copy of the bundle.
    const settings = await readFile(join(d.projectDir, '.claude', 'settings.local.json'), 'utf8');
    const installed = /"([^"]*\/bin\/[^"]+\/javi\.mjs)"/.exec(settings)?.[1];
    expect(installed, settings).toBeDefined();

    const repo = join(d.projectDir, 'shop');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const hook = await run(['hook', '--project', 'shop-two'], baseEnv(d.home), {
      cwd: repo,
      script: installed!,
      stdin: JSON.stringify({ session_id: 's-b', cwd: repo, hook_event_name: 'SessionStart' }),
    });
    expect(hook).toEqual({ code: 0, stdout: '', stderr: '' });
    const flush = await run(['flush', '--project', 'shop-two'], baseEnv(d.home), {
      cwd: repo,
      script: installed!,
    });
    expect(flush.code, flush.stderr).toBe(0);

    type Sent = {
      event_id: string;
      type: string;
      producer_id: string;
      thread_ref: string;
      privacy_class?: string;
      encrypted?: unknown;
    };
    const sent = (): Sent[] =>
      bodies.slice(before).flatMap((b) => (JSON.parse(b) as { events: Sent[] }).events);
    // The hook's detached flush may have delivered it first; either way it arrives once.
    for (let i = 0; i < 50 && !sent().some((e) => e.type === 'x.javi.thread.identity'); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const canary = sent().find((e) => e.type === 'x.javi.collector.installed');
    const identity = sent().find((e) => e.type === 'x.javi.thread.identity');
    expect(canary?.privacy_class).toBe('L2');
    expect(identity?.privacy_class, JSON.stringify(sent())).toBe('L2');

    const { decryptL2, deriveProjectKeys } = await import('@javis-dog/crypto');
    const keys = await deriveProjectKeys(fixture.secret, 'shop-two');
    const byKid = new Map([[keys.kid, keys.l2Key]]);
    expect(
      await decryptL2(byKid, identity!.encrypted, {
        eventId: identity!.event_id,
        slug: 'shop-two',
        producerId: identity!.producer_id,
        threadRef: identity!.thread_ref,
        type: 'x.javi.thread.identity',
      }),
    ).toEqual({ ok: true, payload: { v: 1, repo: 'shop', branch: 'main' } });
    expect(
      await decryptL2(byKid, canary!.encrypted, {
        eventId: canary!.event_id,
        slug: 'shop-two',
        producerId: canary!.producer_id,
        threadRef: canary!.thread_ref,
        type: 'x.javi.collector.installed',
      }),
    ).toEqual({ ok: true, payload: { v: 1, canary: true } });
    expect(leaks(init.stdout + init.stderr + bodies.join('\n'), fixture.sentinels)).toEqual([]);
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

/**
 * Runs `command` inside a pseudo-terminal (util-linux `script`). Once `waitFor` shows up, types
 * `input` (a string) or calls it with the transcript so far (a function, e.g. to send a signal).
 */
const inPty = (
  command: string,
  env: NodeJS.ProcessEnv,
  waitFor: string,
  input: string | ((transcript: string) => void),
) =>
  new Promise<{ code: number | null; transcript: string }>((resolve) => {
    const child = spawn('script', ['-qec', command, '/dev/null'], { env, cwd: root });
    let transcript = '';
    let typed = false;
    child.stdout.on('data', (d) => {
      transcript += d;
      if (!typed && transcript.includes(waitFor)) {
        typed = true;
        // Typed only once the prompt (and raw mode) is up, as a person would.
        setTimeout(
          () => (typeof input === 'string' ? child.stdin.write(input) : input(transcript)),
          100,
        );
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

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const initCommand = (projectDir: string) =>
  [
    shellQuote(process.execPath),
    shellQuote(CLI),
    'init',
    '--project',
    'shop-two',
    '--endpoint',
    shellQuote(endpoint),
    '--privacy',
    'L2',
    '--dir',
    shellQuote(projectDir),
  ].join(' ');

/** The terminal flags `stty -a` printed after javi exited (in the same pseudo-terminal). */
const sttyFlags = (transcript: string) => {
  const line = transcript.split(/\r?\n/).find((l) => l.startsWith('STTY:')) ?? '';
  return new Set(
    line
      .slice('STTY:'.length)
      .split(/[\s;]+/)
      .filter(Boolean),
  );
};

/**
 * javi in the pseudo-terminal through a wrapper that prints javi's pid (the inner `sh` execs
 * into node), then `stty -a` of the same terminal after javi exited, then javi's exit code.
 */
const wrapped = async (projectDir: string) => {
  const wrapper = join(root, 'wrapper.sh');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      `sh -c 'echo "JAVIPID=$$"; exec "$@"' javi "$@"`,
      'code=$?',
      'printf "STTY:%s\\n" "$(stty -a | tr "\\n" " ")"',
      'echo "JAVIEXIT=$code"',
      '',
    ].join('\n'),
  );
  return `sh ${shellQuote(wrapper)} ${initCommand(projectDir)}`;
};

const javiExit = (transcript: string) => Number(/JAVIEXIT=(\d+)/.exec(transcript)?.[1] ?? NaN);
const javiPid = (transcript: string) => Number(/JAVIPID=(\d+)/.exec(transcript)?.[1] ?? NaN);
const RUN_IT_YOURSELF =
  'Run javi init --privacy yourself in a terminal; never paste the key into an agent.';

describe.runIf(hasScript)(
  'hidden prompt refusals and terminal restore (security review M3)',
  () => {
    it.each([
      ['CLAUDECODE', '1'],
      ['CLAUDE_CODE_ENTRYPOINT', 'cli'],
      ['CODEX_THREAD_ID', '019a0000-0000-7000-8000-000000000000'],
      ['CODEX_SESSION_ID', '019a0000-0000-7000-8000-000000000000'],
      ['CODEX_SANDBOX', 'seatbelt'],
      ['CODEX_SANDBOX_NETWORK_DISABLED', '1'],
      ['GEMINI_CLI', '1'],
    ])(
      'inside a coding agent (%s=%s): no prompt, exit 2, nothing written',
      async (marker, value) => {
        const d = await dirs();
        const { code, transcript } = await inPty(
          initCommand(d.projectDir),
          { ...baseEnv(d.home), TERM: 'dumb', [marker]: value },
          '(input hidden): ',
          `${fixture.key}\r`,
        );
        expect(transcript).not.toContain('(input hidden)');
        expect(code, transcript).toBe(2);
        expect(transcript).toContain(`(${marker} is set)`);
        expect(transcript).toContain('--privacy-key-file');
        expect(transcript).toContain(RUN_IT_YOURSELF);
        expect(await filesUnder(d.home)).toEqual([]);
        expect(leaks(transcript, fixture.sentinels)).toEqual([]);
      },
    );

    it.each([
      ['stdin', '< /dev/null'],
      ['stdout', '> /dev/null'],
      ['stderr', '2> /dev/null'],
    ])('%s not a terminal (%s): no prompt, exit 2, nothing written', async (name, redirect) => {
      const d = await dirs();
      const { code, transcript } = await inPty(
        `${initCommand(d.projectDir)} ${redirect}`,
        { ...baseEnv(d.home), TERM: 'dumb' },
        '(input hidden): ',
        `${fixture.key}\r`,
      );
      expect(transcript).not.toContain('(input hidden)');
      expect(code, transcript).toBe(2);
      if (name !== 'stderr') {
        expect(transcript).toContain('No terminal to read the recovery key from');
        expect(transcript).toContain('--privacy-key-file');
        expect(transcript).toContain(RUN_IT_YOURSELF);
      }
      expect(await filesUnder(d.home)).toEqual([]);
    });

    it('Ctrl-C typed at the prompt: cancelled, exit 1, echo and line mode restored', async () => {
      const d = await dirs();
      const { transcript } = await inPty(
        await wrapped(d.projectDir),
        { ...baseEnv(d.home), TERM: 'dumb' },
        '(input hidden): ',
        'JDK1-\u0003',
      );
      expect(javiExit(transcript), transcript).toBe(1);
      expect(transcript).toMatch(/Cancelled\. Nothing was saved/);
      const flags = sttyFlags(transcript);
      expect(flags.has('echo') && flags.has('icanon'), transcript).toBe(true);
      expect(await filesUnder(d.home)).toEqual([]);
    });

    it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
      '%s while the prompt waits: cancelled, exit 1, echo and line mode restored',
      async (signal) => {
        const d = await dirs();
        const { transcript } = await inPty(
          await wrapped(d.projectDir),
          { ...baseEnv(d.home), TERM: 'dumb' },
          '(input hidden): ',
          (sofar) => process.kill(javiPid(sofar), signal),
        );
        expect(javiExit(transcript), transcript).toBe(1);
        expect(transcript).toMatch(/Cancelled\. Nothing was saved/);
        const flags = sttyFlags(transcript);
        expect(flags.has('echo') && flags.has('icanon'), transcript).toBe(true);
        expect(await filesUnder(d.home)).toEqual([]);
      },
    );
  },
);
