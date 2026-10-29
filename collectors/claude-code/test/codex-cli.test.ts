import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_BLOCK_START,
  codexBackupPath,
  codexConfigPath,
  codexHooksPath,
  codexOtelBlock,
  createState,
  installHooks,
  main,
  type CollectorState,
  type Io,
} from '../src/index.ts';

// S5c B1–B2 (TEST_PLAN §S5c): `javi … --platform codex-cli` in-process against temp JAVI_HOME,
// Codex home and project dirs (never the real ~/.codex). JD-C02 is replaced by local test
// doubles of its documented contract until lane A's implementation is merged.
vi.mock('@javis-dog/collector-adapters', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./codex-doubles.ts')).codexDoubles,
}));

const TOKEN = `jd_it_${'C'.repeat(43)}`;
let home: string;
let codexHome: string;
let claudeHome: string;
let project: string;
let quietShell: string;
let state: CollectorState;
let config: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-cx-home-'));
  codexHome = await mkdtemp(join(tmpdir(), 'javi-cx-codex-'));
  claudeHome = await mkdtemp(join(tmpdir(), 'javi-cx-claude-'));
  project = await mkdtemp(join(tmpdir(), 'javi-cx-project-'));
  quietShell = join(codexHome, 'quiet-shell.sh');
  await writeFile(quietShell, '#!/bin/sh\nexit 0\n');
  await chmod(quietShell, 0o755);
  state = createState(home);
  config = codexConfigPath(codexHome);
});
afterEach(async () => {
  for (const dir of [home, codexHome, claudeHome, project]) {
    await rm(dir, { recursive: true, force: true });
  }
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const io = (opts: { env?: NodeJS.ProcessEnv; stdin?: string; cwd?: string } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env: {
      JAVI_HOME: home,
      JAVI_CODEX_HOME: codexHome,
      JAVI_CLAUDE_HOME: claudeHome,
      SHELL: quietShell,
      ...opts.env,
    },
    cwd: opts.cwd ?? project,
    readStdin: async () => opts.stdin ?? '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: () => {},
    spawnReceiver: () => {},
  };
  return { value, out, err };
};

const run = async (argv: string[], opts: Parameters<typeof io>[0] = {}) => {
  const t = io(opts);
  const code = await main(argv, t.value);
  return { code, ...t };
};
const init = (opts: Parameters<typeof io>[0] = {}) =>
  run(['init', '--project', 'web-app', '--platform', 'codex-cli', '--no-verify'], {
    ...opts,
    env: { JAVI_INGEST_TOKEN: TOKEN, ...opts.env },
  });
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('javi init --platform codex-cli', () => {
  it('writes the launcher and appends hooks; says that approval is up to the user in Codex', async () => {
    const r = await init();
    expect(r.code).toBe(0);
    const launcher = join(home, 'bin', 'javi-hook');
    expect(await readFile(launcher, 'utf8')).toContain(' hook "$@"');
    const hooks = JSON.parse(await readFile(codexHooksPath(project), 'utf8'));
    expect(hooks.hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'command',
      command: `${launcher} --platform codex-cli --project web-app --source javi-collector`,
      commandWindows: `${launcher}.cmd --platform codex-cli --project web-app --source javi-collector`,
      timeout: 5,
    });
    expect(await state.credentials('web-app')).toMatchObject({ token: TOKEN });
    const text = r.out.join('\n');
    expect(text).toMatch(/Hooks need review/);
    expect(text).toMatch(/javi never approves hooks for you/);
    expect(text).toMatch(/waiting for approval in Codex/);
    expect(text).not.toContain(TOKEN);
    expect(r.err).toEqual([]);
    // Never writes approval state.
    expect(await exists(config)).toBe(false);
  });

  it('refuses an unparsable hooks.json before saving the token', async () => {
    await mkdir(join(project, '.codex'), { recursive: true });
    await writeFile(codexHooksPath(project), '{ nope');
    const r = await init();
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/Cannot read .*hooks\.json.*No token saved/);
    expect(await state.credentials('web-app')).toBeNull();
    expect(await readFile(codexHooksPath(project), 'utf8')).toBe('{ nope');
  });

  it('refuses a launcher path with a space, naming it; nothing changed', async () => {
    const spaced = join(home, 'with space');
    const r = await init({ env: { JAVI_HOME: spaced } });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain(`launcher path ${join(spaced, 'bin', 'javi-hook')}`);
    expect(await exists(codexHooksPath(project))).toBe(false);
    expect(await createState(spaced).credentials('web-app')).toBeNull();
  });

  it('warns about a git-tracked hooks.json, a project [hooks] table and shell startup output', async () => {
    execFileSync('git', ['init', '-q', project]);
    await mkdir(join(project, '.codex'), { recursive: true });
    await writeFile(codexHooksPath(project), '{}\n');
    await writeFile(join(project, '.codex', 'config.toml'), '[hooks]\n');
    execFileSync('git', ['-C', project, 'add', '.codex/hooks.json']);
    const loud = join(codexHome, 'loud.sh');
    await writeFile(loud, '#!/bin/sh\necho "motd PRIVATE"\n');
    await chmod(loud, 0o755);
    const r = await init({ env: { SHELL: loud } });
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toMatch(/hooks\.json is tracked by git/);
    expect(text).toMatch(/\[hooks\] table/);
    expect(text).toContain(`'${loud} -c true' printed something (stdout)`);
    expect(text).toContain(`'${loud} -lc true' printed something (stdout)`);
    expect(text).not.toContain('PRIVATE');
  });
});

describe('javi usage on|off --platform codex-cli', () => {
  const on = async (extra: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    // A free port unless one is given or another platform already fixed it.
    const port =
      extra.includes('--port') || (await state.usageConfig())
        ? []
        : ['--port', String(await freePort())];
    return run(['usage', 'on', '--platform', 'codex-cli', ...port, ...extra], { env });
  };
  const off = () => run(['usage', 'off', '--platform', 'codex-cli']);

  it('appends the block, discloses what it means, and usage off removes exactly it', async () => {
    const original = '# mine\n[mcp_servers.x]\ncommand = "x"\n';
    await writeFile(config, original);
    const port = await freePort();
    const r = await on(['--port', String(port)]);
    expect(r.code).toBe(0);
    const usage = (await state.usageConfig())!;
    expect(usage.written).toBeUndefined();
    expect(usage.codex).toEqual({
      path: config,
      block: codexOtelBlock(port, usage.secret),
      separator: '\n',
      created: false,
    });
    expect(await readFile(config, 'utf8')).toBe(
      `${original}\n${codexOtelBlock(port, usage.secret)}`,
    );
    const text = r.out.join('\n');
    expect(text).toMatch(/user-wide/);
    expect(text).toMatch(/Codex asks OpenAI for each turn's cost estimate/);
    expect(text).toMatch(/your email and tool arguments/);
    expect(text).toMatch(/keeps token counts and cost/);
    expect(text).not.toContain(usage.secret);
    expect(await readFile(codexBackupPath(config), 'utf8')).toBe(original);

    const status = await run(['status', '--project', 'web-app']);
    expect(status.out).toEqual(
      expect.arrayContaining([`Usage: on (port ${port})`, `Codex CLI usage: on (${config})`]),
    );

    const o = await off();
    expect(o.code).toBe(0);
    expect(await readFile(config, 'utf8')).toBe(original);
    expect(await exists(codexBackupPath(config))).toBe(false);
    expect(await state.usageConfig()).toBeNull();
    expect((await off()).out).toEqual(['Token usage export for Codex CLI is already off.']);
  });

  it('shares one port and secret with Claude Code; turning Codex off keeps the receiver for it', async () => {
    const port = await freePort();
    expect((await run(['usage', 'on', '--port', String(port)])).code).toBe(0);
    const claude = (await state.usageConfig())!;
    const r = await on();
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/inherits javi's Claude Code usage header/);
    const both = (await state.usageConfig())!;
    expect(both).toMatchObject({ port, secret: claude.secret, written: claude.written });
    const moved = await on(['--port', String(await freePort())]);
    expect(moved.code).toBe(1);
    expect(moved.err.join('\n')).toMatch(/one usage port for all platforms.*Claude Code/);
    const o = await off();
    expect(o.out).toContain('The usage receiver keeps running for Claude Code.');
    expect(await state.usageConfig()).toEqual({
      port,
      secret: claude.secret,
      written: claude.written,
    });
  });

  it('refuses when a proxy would carry the logs off the loopback (shell or .env); nothing changed', async () => {
    for (const [env, dotenv] of [
      [{ HTTP_PROXY: 'http://proxy:3128' }, null],
      [{ NO_PROXY: 'localhost' }, 'ALL_PROXY=socks5://p:1\n'],
    ] as const) {
      if (dotenv) await writeFile(join(codexHome, '.env'), dotenv);
      const r = await on([], env);
      expect(r.code).toBe(1);
      const text = r.err.join('\n');
      expect(text).toMatch(/proxy is set and NO_PROXY does not cover 127\.0\.0\.1/);
      expect(text).not.toMatch(/proxy:3128|socks5/);
      expect(await exists(config)).toBe(false);
      expect(await state.usageConfig()).toBeNull();
    }
    await writeFile(join(codexHome, '.env'), 'ALL_PROXY=socks5://p:1\nNO_PROXY=127.0.0.1\n');
    expect((await on()).code).toBe(0);
  });

  it('warns (does not refuse) on OTLP header variables that override the bearer', async () => {
    await writeFile(join(codexHome, '.env'), 'OTEL_EXPORTER_OTLP_LOGS_HEADERS=a=b\n');
    const r = await on([], { OTEL_EXPORTER_OTLP_HEADERS: 'x=SECRETISH' });
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('environment: OTEL_EXPORTER_OTLP_HEADERS');
    expect(text).toContain(`${join(codexHome, '.env')}: OTEL_EXPORTER_OTLP_LOGS_HEADERS`);
    expect(text).not.toContain('SECRETISH');
  });

  it('refuses an existing otel setting or an unparsable file by name only; usage.json untouched', async () => {
    await writeFile(
      config,
      '[otel]\nexporter = { otlp-http = { endpoint = "https://them.example" } }\n',
    );
    const r = await on();
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('(otel.exporter)');
    expect(r.err.join('\n')).not.toContain('them.example');
    expect(await state.usageConfig()).toBeNull();
    await writeFile(config, 'model = ');
    const u = await on();
    expect(u.code).toBe(1);
    expect(u.err.join('\n')).toMatch(/does not parse as TOML/);
    expect(await readFile(config, 'utf8')).toBe('model = ');
  });

  it('usage off leaves a changed block alone and says so', async () => {
    expect((await on()).code).toBe(0);
    const text = await readFile(config, 'utf8');
    await writeFile(config, text.replace('log_sse_deltas = false', 'log_sse_deltas = true'));
    const o = await off();
    expect(o.code).toBe(0);
    expect(o.out.join('\n')).toMatch(/was changed since usage on, so javi left the file as it is/);
    expect(await readFile(config, 'utf8')).toContain(CODEX_BLOCK_START);
  });
});

describe('javi hook / status --platform codex-cli', () => {
  const hook = (payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
    run(['hook', '--platform', 'codex-cli', '--project', 'web-app', '--source', 'javi-collector'], {
      stdin: JSON.stringify(payload),
      env,
    });
  const status = () => run(['status', '--project', 'web-app', '--platform', 'codex-cli']);

  it('status tells "project not trusted", "hooks not approved" and "approved" apart, read-only', async () => {
    expect((await init()).code).toBe(0);
    let s = await status();
    expect(s.out).toContain(
      `Codex CLI hooks: project not trusted — Codex loads ${codexHooksPath(project)} only in a trusted project (trust it when Codex asks).`,
    );
    expect(s.out).toContain(
      'Codex CLI hook events: no events yet (waiting for approval in Codex).',
    );
    const trusted = `[projects."${project}"]\ntrust_level = "trusted"\n`;
    await writeFile(config, trusted);
    s = await status();
    expect(s.out.join('\n')).toMatch(/hooks not approved \(0 of 9\)/);
    const hooksPath = codexHooksPath(project);
    const labels = [
      'session_start',
      'session_end',
      'user_prompt_submit',
      'pre_tool_use',
      'post_tool_use',
      'permission_request',
      'stop',
      'subagent_start',
      'subagent_stop',
    ];
    const approvals = labels
      .map((l) => `[hooks.state."${hooksPath}:${l}:0:0"]\ntrusted_hash = "sha256:x"\n`)
      .join('');
    await writeFile(config, `${trusted}${approvals}`);
    s = await status();
    expect(s.out).toContain('Codex CLI hooks: approved (9 of 9)');
    expect(await readFile(config, 'utf8')).toBe(`${trusted}${approvals}`);

    const h = await hook({ session_id: 's1', hook_event_name: 'SessionStart' });
    expect(h).toMatchObject({ code: 0, out: [], err: [] });
    s = await status();
    expect(s.out.join('\n')).toMatch(/Last Codex CLI hook event: \d{4}-/);
  });

  it('SessionStart records proxy, header and Claude-header warnings (names only); status shows them first; a clean start clears them', async () => {
    expect((await init()).code).toBe(0);
    const port = String(await freePort());
    expect((await run(['usage', 'on', '--port', port])).code).toBe(0); // javi's Claude header
    expect((await run(['usage', 'on', '--platform', 'codex-cli'])).code).toBe(0);
    const claudeHeader = (await state.usageConfig())!.written!.OTEL_EXPORTER_OTLP_METRICS_HEADERS!;
    await writeFile(join(codexHome, '.env'), 'OTEL_EXPORTER_OTLP_HEADERS=mine\n');
    const h = await hook(
      { session_id: 's1', hook_event_name: 'SessionStart' },
      { HTTP_PROXY: 'http://user:pw@proxy', OTEL_EXPORTER_OTLP_METRICS_HEADERS: claudeHeader },
    );
    expect(h).toMatchObject({ code: 0, out: [], err: [] });
    const warnings = await state.codexEnvWarnings();
    expect(warnings).toEqual([
      {
        project: 'web-app',
        at: expect.any(String),
        proxy: [{ source: 'environment', keys: ['HTTP_PROXY'] }],
        headers: [{ source: join(codexHome, '.env'), keys: ['OTEL_EXPORTER_OTLP_HEADERS'] }],
        claudeHeader: true,
      },
    ]);
    const files = await readFile(join(home, 'warnings', 'codex-env.web-app.json'), 'utf8');
    expect(files).not.toMatch(/pw@|Bearer|mine/);
    const s = await status();
    expect(s.out[0]).toMatch(/^WARNING: Codex CLI logs can bypass javi in project web-app/);
    expect(s.out.join('\n')).toMatch(/replace javi's receiver token/);
    expect(s.out.join('\n')).toMatch(/javi's Claude Code usage header/);

    // A SessionStart without them clears the warning.
    await rm(join(codexHome, '.env'));
    await hook({ session_id: 's2', hook_event_name: 'SessionStart' });
    expect(await state.codexEnvWarnings()).toEqual([]);
  });

  it('SubagentStart stores the link before the hook exits; other hooks stay silent', async () => {
    expect((await init()).code).toBe(0);
    const port = String(await freePort());
    expect((await run(['usage', 'on', '--platform', 'codex-cli', '--port', port])).code).toBe(0);
    await hook({ session_id: 'root', hook_event_name: 'SessionStart' });
    const sub = await hook({
      session_id: 'root',
      hook_event_name: 'SubagentStart',
      agent_id: 'child',
      prompt: 'SENTINEL',
    });
    expect(sub).toMatchObject({ code: 0, out: [], err: [] });
    const { salt } = await state.installation();
    const { opaqueRef } = await import('../src/index.ts');
    expect(await state.subagentParent(opaqueRef('cx', 'child', salt))).toEqual({
      parent: opaqueRef('cx', 'root', salt),
      agentRef: opaqueRef('ag', 'child', salt),
    });
  });
});

describe('javi uninstall --platform codex-cli', () => {
  it("removes javi's groups, lists the user's groups that shift, keeps the token for Claude Code hooks", async () => {
    expect((await init()).code).toBe(0);
    const path = codexHooksPath(project);
    const file = JSON.parse(await readFile(path, 'utf8'));
    file.hooks.Stop.push({ hooks: [{ type: 'command', command: 'mine' }] });
    await writeFile(path, JSON.stringify(file, null, 2));
    await installHooks(project, process.execPath, '/j/cli.ts', 'web-app');

    const r = await run([
      'uninstall',
      '--project',
      'web-app',
      '--platform',
      'codex-cli',
      '--forget-token',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Removed javi hooks from ${path}.`);
    expect(r.out.join('\n')).toMatch(
      /Stop: 1 of your hook group changed position.*review it again/,
    );
    expect(r.out.join('\n')).toMatch(
      /Token kept: Claude Code hooks for web-app are still installed/,
    );
    expect(await state.credentials('web-app')).not.toBeNull();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] },
    });

    const c = await run(['uninstall', '--project', 'web-app', '--forget-token']);
    expect(c.out).toContain('Token removed from this machine.');
  });
});
