import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_SELF_REPORT_ALLOW,
  createState,
  gitTracking,
  main,
  mcpLauncherPath,
  registrationPath,
  settingsPath,
  type GitRunner,
  type Io,
  type Platform,
} from '../src/index.ts';

// ADR-0017 §5 registration (TEST_PLAN §S5d rows "init --self-report …" and "--allow-self-report
// …"): `javi init --self-report` / `javi uninstall` / `javi status` in-process, on temp project
// folders and a temp JAVI_HOME; bytes compared before and after.

const TOKEN = `jd_it_${'R'.repeat(43)}`;
let home: string;
let dir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-sr-home-'));
  dir = await mkdtemp(join(tmpdir(), 'javi-sr-project-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env: { JAVI_HOME: home, JAVI_INGEST_TOKEN: TOKEN, SHELL: '/bin/sh' },
    cwd: dir,
    readStdin: async () => '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: () => {},
    spawnReceiver: () => {},
  };
  return { value, out, err };
};

const platformArgs = (p: Platform) => (p === 'claude-code' ? [] : ['--platform', p]);
const init = async (p: Platform, ...extra: string[]) => {
  const t = io();
  const code = await main(
    ['init', '--project', 'web-app', '--dir', dir, '--no-verify', ...platformArgs(p), ...extra],
    t.value,
  );
  return { code, out: t.out.join('\n'), err: t.err.join('\n') };
};
const uninstall = async (p: Platform, ...extra: string[]) => {
  const t = io();
  const code = await main(
    ['uninstall', '--project', 'web-app', '--dir', dir, ...platformArgs(p), ...extra],
    t.value,
  );
  return { code, out: t.out.join('\n'), err: t.err.join('\n') };
};
const status = async (p: Platform) => {
  const t = io();
  const code = await main(
    ['status', '--project', 'web-app', '--dir', dir, ...platformArgs(p)],
    t.value,
  );
  return { code, out: t.out.join('\n') };
};

const read = (path: string) => readFile(path, 'utf8');
const readOrNull = (path: string) => readFile(path, 'utf8').catch(() => null);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });

/** javi's registered entry, parsed from the platform's file. */
const entryOf = async (p: Platform): Promise<Record<string, unknown> | undefined> => {
  const text = await readOrNull(registrationPath(p, dir));
  if (text === null) return undefined;
  if (p === 'codex-cli') {
    return (parseToml(text) as { mcp_servers?: { javi?: Record<string, unknown> } }).mcp_servers
      ?.javi;
  }
  return (JSON.parse(text) as { mcpServers?: { javi?: Record<string, unknown> } }).mcpServers?.javi;
};

const expectedEntry = (p: Platform) => ({
  command: process.execPath,
  args: ['--no-warnings', mcpLauncherPath(home), '--platform', p, '--project', 'web-app'],
});

const hooksFile = (p: Platform) =>
  p === 'gemini-cli'
    ? join(dir, '.gemini', 'settings.json')
    : p === 'codex-cli'
      ? join(dir, '.codex', 'hooks.json')
      : settingsPath(dir);

const PLATFORMS: Platform[] = ['claude-code', 'gemini-cli', 'codex-cli'];

describe.each(PLATFORMS)('init --self-report (%s)', (p) => {
  it('fresh project: entry, launcher and hooks; re-run is idempotent; uninstall removes it all', async () => {
    const first = await init(p, '--self-report');
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    const file = registrationPath(p, dir);
    expect(first.out).toContain(`Self-report MCP server "javi" registered in ${file}.`);
    expect(await entryOf(p)).toEqual(expectedEntry(p));
    // The launcher is unversioned, prints nothing itself, and runs the installed javi mcp.
    const launcher = await read(mcpLauncherPath(home));
    expect(launcher).toContain("process.argv.splice(1, 1, cli, 'mcp');");
    expect(launcher).toContain(JSON.stringify(home));
    expect(launcher).not.toMatch(/console\.|stdout/);
    // `init --self-report` installs the hooks too, and writes no token into the project.
    expect(await read(hooksFile(p))).toContain('web-app');
    expect(await read(file)).not.toContain(TOKEN);
    expect(await read(file)).not.toMatch(/env|JAVI_INGEST_TOKEN|trust|includeTools/);
    if (p === 'claude-code') {
      // No pre-approval without --allow-self-report.
      expect(await read(settingsPath(dir))).not.toContain('mcp__javi__');
    }

    const bytes = await read(file);
    const again = await init(p, '--self-report');
    expect(again.code).toBe(0);
    expect(again.out).toContain('already registered');
    expect(await read(file)).toBe(bytes);

    const removed = await uninstall(p);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(
      p === 'gemini-cli'
        ? `Removed javi's self-report MCP server from ${file}.` // the hooks file, created by hooks
        : `${file} held only javi's self-report MCP server, so the file was removed.`,
    );
    if (p === 'codex-cli') {
      // Hooks removed after the entry; javi created .codex/hooks.json too.
      expect(removed.out.indexOf('self-report')).toBeLessThan(removed.out.indexOf('hooks'));
    }
    expect(existsSync(file) && (await entryOf(p))).toBeFalsy();
    expect(existsSync(mcpLauncherPath(home))).toBe(true); // documented: the launcher stays
    const after = await readOrNull(hooksFile(p));
    expect(after === null || !after.includes('javi-collector')).toBe(true);
  });

  it('git-tracked registration file: refused without --allow-tracked-config, nothing written', async () => {
    git('init', '-q');
    const file = registrationPath(p, dir);
    await mkdir(join(file, '..'), { recursive: true });
    const original =
      p === 'codex-cli' ? '# team config\nmodel = "o4"\n' : '{\n  "mcpServers": {}\n}\n';
    await writeFile(file, original);
    git('add', '--', file);

    const refused = await init(p, '--self-report');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(file);
    expect(refused.err).toContain('tracked by git');
    expect(refused.err).toContain('--allow-tracked-config');
    expect(await read(file)).toBe(original);
    expect(await createState(home).credentials('web-app')).toBeNull();
    expect(await readOrNull(hooksFile(p))).toBe(p === 'gemini-cli' ? original : null);

    const allowed = await init(p, '--self-report', '--allow-tracked-config');
    expect(allowed.code).toBe(0);
    expect(await entryOf(p)).toEqual(expectedEntry(p));
    expect((await uninstall(p)).code).toBe(0);
    if (p !== 'gemini-cli') expect(await read(file)).toBe(original);
  });

  it('an unparsable registration file is refused before anything is written', async () => {
    const file = registrationPath(p, dir);
    await mkdir(join(file, '..'), { recursive: true });
    const broken = p === 'codex-cli' ? '[mcp_servers\nbroken = ' : '{ "mcpServers": { , }\n';
    await writeFile(file, broken);
    const refused = await init(p, '--self-report');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(file);
    expect(refused.err).toContain('Nothing was changed');
    expect(await read(file)).toBe(broken);
    expect(await createState(home).credentials('web-app')).toBeNull();
  });

  it('a javi server javi did not write is refused', async () => {
    const file = registrationPath(p, dir);
    await mkdir(join(file, '..'), { recursive: true });
    const foreign =
      p === 'codex-cli'
        ? '[mcp_servers.javi]\ncommand = "npx"\nargs = ["javi-other"]\n'
        : '{"mcpServers": {"javi": {"command": "npx", "args": ["javi-other"]}}}\n';
    await writeFile(file, foreign);
    const refused = await init(p, '--self-report');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('already has an MCP server named javi that javi did not write');
    expect(await read(file)).toBe(foreign);
    // uninstall never removes it either.
    expect((await uninstall(p)).code).toBe(0);
    expect(await read(file)).toBe(foreign);
  });

  it('status: registered, pre-approval, and a warning when the Node.js path is gone', async () => {
    expect((await init(p)).code).toBe(0);
    const before = await status(p);
    expect(before.out).toContain(`Self-report: not registered in ${registrationPath(p, dir)}`);
    expect((await init(p, '--self-report')).code).toBe(0);
    const on = await status(p);
    expect(on.out).toContain(
      `Self-report: registered in ${registrationPath(p, dir)} (MCP server javi).`,
    );
    expect(on.out).toMatch(
      p === 'codex-cli'
        ? /Self-report pre-approval: not needed/
        : /Self-report pre-approval: off \(.* asks before each report/,
    );
    expect(on.out).not.toContain('Warning: the Node.js path');

    // Node moved (a version-manager switch): the registered path no longer exists.
    const file = registrationPath(p, dir);
    const text = await read(file);
    const moved = join(dir, 'gone', 'node');
    const quoted = JSON.stringify(process.execPath);
    await writeFile(file, text.replace(quoted, JSON.stringify(moved)));
    const warn = await status(p);
    expect(warn.out).toContain(
      `Warning: the Node.js path registered for self-report (${moved}) no longer exists`,
    );
  });
});

describe('existing files with the user’s servers and formatting', () => {
  it('Claude Code .mcp.json: only javi’s entry is added, and uninstall restores the exact bytes', async () => {
    const file = join(dir, '.mcp.json');
    const original =
      '{\n    "mcpServers" : {\n        "docs":{"command":"npx","args":[ "docs-mcp" ]},\n        "db": {\n            "type": "http", "url": "http://localhost:9"\n        }\n    },\n    "other": [1,2]\n}';
    await writeFile(file, original);
    expect((await init('claude-code', '--self-report')).code).toBe(0);
    const after = await read(file);
    // Every line of the user's text is still there, verbatim, in order.
    expect(after.startsWith(original.slice(0, original.indexOf('        }\n    },') + 9))).toBe(
      true,
    );
    expect(after.endsWith('\n    },\n    "other": [1,2]\n}')).toBe(true);
    const parsed = JSON.parse(after) as { mcpServers: Record<string, unknown>; other: unknown };
    expect(Object.keys(parsed.mcpServers)).toEqual(['docs', 'db', 'javi']);
    expect(parsed.mcpServers.javi).toEqual(expectedEntry('claude-code'));
    expect((await init('claude-code', '--self-report')).code).toBe(0);
    expect(await read(file)).toBe(after);
    expect((await uninstall('claude-code')).code).toBe(0);
    expect(await read(file)).toBe(original);
  });

  it('Claude Code .mcp.json without mcpServers: javi adds and removes the container', async () => {
    const file = join(dir, '.mcp.json');
    const original = '{\n  "$schema": "x"\n}\n';
    await writeFile(file, original);
    expect((await init('claude-code', '--self-report')).code).toBe(0);
    expect(JSON.parse(await read(file))).toEqual({
      $schema: 'x',
      mcpServers: { javi: expectedEntry('claude-code') },
    });
    expect((await uninstall('claude-code')).code).toBe(0);
    expect(await read(file)).toBe(original);
  });

  it('Gemini CLI settings: user servers and keys kept; uninstall leaves the user settings', async () => {
    const file = join(dir, '.gemini', 'settings.json');
    await mkdir(join(dir, '.gemini'), { recursive: true });
    const user = {
      theme: 'Dracula',
      mcpServers: { docs: { command: 'npx', args: ['docs-mcp'], trust: false } },
    };
    await writeFile(file, JSON.stringify(user));
    expect((await init('gemini-cli', '--self-report')).code).toBe(0);
    const parsed = JSON.parse(await read(file)) as Record<string, Record<string, unknown>>;
    expect(parsed.theme).toBe('Dracula');
    expect(parsed.mcpServers).toEqual({ ...user.mcpServers, javi: expectedEntry('gemini-cli') });
    expect(parsed.hooks).toBeDefined();
    expect((await uninstall('gemini-cli')).code).toBe(0);
    expect(JSON.parse(await read(file))).toEqual(user);
  });

  const codexBlock = () =>
    [
      '# >>> javi self-report (do not edit)',
      '[mcp_servers.javi]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${expectedEntry('codex-cli')
        .args.map((a) => JSON.stringify(a))
        .join(', ')}]`,
      '# <<< javi',
      '',
    ].join('\n');

  it('Codex CLI project config.toml: marked block before the first table, comments kept, exact bytes back', async () => {
    const file = join(dir, '.codex', 'config.toml');
    await mkdir(join(dir, '.codex'), { recursive: true });
    const head = '# my project settings\nmodel = "gpt-5.5-codex"   # pinned\n\n';
    const tail = '[mcp_servers.docs]\ncommand = "npx"\nargs = ["docs-mcp"]\n';
    const original = head + tail;
    await writeFile(file, original);
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    const after = await read(file);
    // Code review L4: javi's table is followed by the user's table, never by bare keys.
    expect(after).toBe(head + codexBlock() + tail);
    const parsed = parseToml(after) as { mcp_servers: Record<string, unknown>; model: string };
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual(['docs', 'javi']);
    expect(parsed.model).toBe('gpt-5.5-codex');
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    expect(await read(file)).toBe(after);
    expect((await uninstall('codex-cli')).code).toBe(0);
    expect(await read(file)).toBe(original);
  });

  it('Codex CLI project config.toml with root keys only: marked block appended, exact bytes back', async () => {
    const file = join(dir, '.codex', 'config.toml');
    await mkdir(join(dir, '.codex'), { recursive: true });
    const original = '# my project settings\nmodel = "gpt-5.5-codex"   # pinned\n';
    await writeFile(file, original);
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    expect(await read(file)).toBe(`${original}\n${codexBlock()}`);
    expect((await uninstall('codex-cli')).code).toBe(0);
    expect(await read(file)).toBe(original);
  });

  it('Codex CLI: an inline mcp_servers table cannot take javi’s table — refused, no write', async () => {
    const file = join(dir, '.codex', 'config.toml');
    await mkdir(join(dir, '.codex'), { recursive: true });
    const original = 'mcp_servers = { docs = { command = "npx" } }\n';
    await writeFile(file, original);
    const result = await init('codex-cli', '--self-report');
    expect(result.code).toBe(1);
    expect(result.err).toContain(file);
    expect(result.err).toContain('Nothing was changed: no token saved, no hooks registered.');
    expect(await read(file)).toBe(original);
    expect(await createState(home).credentials('web-app')).toBeNull();
    expect(existsSync(join(dir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('Codex CLI: an edited javi block is left alone by uninstall (exit 1, nothing removed)', async () => {
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    const file = join(dir, '.codex', 'config.toml');
    const edited = (await read(file)).replace(/args = \[.*\]/, 'args = ["mine"]');
    await writeFile(file, edited);
    const result = await uninstall('codex-cli');
    expect(result.code).toBe(1);
    expect(result.err).toContain('was edited');
    expect(await read(file)).toBe(edited);
    expect(await read(join(dir, '.codex', 'hooks.json'))).toContain('javi-collector');
  });

  // Code review L4: in TOML a bare key below javi's block belongs to [mcp_servers.javi].
  it('Codex CLI: a bare key appended below javi’s block makes uninstall refuse (exit 1, lines named)', async () => {
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    const file = join(dir, '.codex', 'config.toml');
    const edited = `${await read(file)}\n# mine\nmodel = "o4"\n`;
    await writeFile(file, edited);
    const lineOf = edited.split('\n').indexOf('model = "o4"') + 1;
    const result = await uninstall('codex-cli');
    expect(result.code).toBe(1);
    expect(result.err).toContain(file);
    expect(result.err).toContain(`line ${lineOf}`);
    expect(result.err).toContain('[mcp_servers.javi]');
    expect(await read(file)).toBe(edited);
    expect(await read(join(dir, '.codex', 'hooks.json'))).toContain('javi-collector');
    // init refuses it too, before writing anything, with the same explanation.
    const again = await init('codex-cli', '--self-report');
    expect(again.code).toBe(1);
    expect(again.err).toContain(`line ${lineOf}`);
    expect(await read(file)).toBe(edited);
  });

  it('Codex CLI: javi’s block goes before the first table, so a key appended at the end stays the user’s', async () => {
    const file = join(dir, '.codex', 'config.toml');
    await mkdir(join(dir, '.codex'), { recursive: true });
    const original = 'model = "o4"\n\n# profile for CI\n[profiles.ci]\nmodel = "o3"\n';
    await writeFile(file, original);
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    const after = await read(file);
    expect(after.startsWith('model = "o4"\n\n# >>> javi self-report (do not edit)\n')).toBe(true);
    expect(after.endsWith('# <<< javi\n# profile for CI\n[profiles.ci]\nmodel = "o3"\n')).toBe(
      true,
    );
    // The user appends a key at the end of the file: it joins their own table, not javi's.
    const appended = `${after}approval_policy = "never"\n`;
    await writeFile(file, appended);
    const parsed = parseToml(appended) as {
      profiles: { ci: Record<string, unknown> };
      mcp_servers: { javi: Record<string, unknown> };
    };
    expect(parsed.profiles.ci).toEqual({ model: 'o3', approval_policy: 'never' });
    expect(parsed.mcp_servers.javi).toEqual(expectedEntry('codex-cli'));
    expect((await uninstall('codex-cli')).code).toBe(0);
    expect(await read(file)).toBe(`${original}approval_policy = "never"\n`);
  });
});

describe('--allow-self-report', () => {
  it('Claude Code: adds exactly the two allow rules, records them, and uninstall removes exactly them', async () => {
    const local = settingsPath(dir);
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      local,
      JSON.stringify({
        permissions: { allow: ['Bash(ls)', CLAUDE_SELF_REPORT_ALLOW[1]] },
        model: 'x',
      }),
    );
    const result = await init('claude-code', '--self-report', '--allow-self-report');
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Pre-approved in ${local}: ${CLAUDE_SELF_REPORT_ALLOW[0]}`);
    const settings = JSON.parse(await read(local)) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toEqual([
      'Bash(ls)',
      CLAUDE_SELF_REPORT_ALLOW[1],
      CLAUDE_SELF_REPORT_ALLOW[0],
    ]);
    const records = await createState(home).selfReportRegistrations();
    // The user's own rule is not javi's: only the one javi added is recorded.
    expect(records.map((r) => r.allow)).toEqual([[CLAUDE_SELF_REPORT_ALLOW[0]]]);
    expect((await status('claude-code')).out).toContain('Self-report pre-approval: on');
    // .mcp.json carries no permission at all.
    expect(await read(join(dir, '.mcp.json'))).not.toContain('allow');

    const removed = await uninstall('claude-code');
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(
      `Removed javi's self-report pre-approval from ${local}: ${CLAUDE_SELF_REPORT_ALLOW[0]}.`,
    );
    expect(JSON.parse(await read(local))).toEqual({
      permissions: { allow: ['Bash(ls)', CLAUDE_SELF_REPORT_ALLOW[1]] },
      model: 'x',
    });
  });

  it('Claude Code: a fresh settings file gets permissions.allow; re-run without the flag takes it back', async () => {
    expect((await init('claude-code', '--self-report', '--allow-self-report')).code).toBe(0);
    const local = settingsPath(dir);
    expect((JSON.parse(await read(local)) as { permissions: unknown }).permissions).toEqual({
      allow: [...CLAUDE_SELF_REPORT_ALLOW],
    });
    const again = await init('claude-code', '--self-report');
    expect(again.code).toBe(0);
    expect(again.out).toContain("Removed javi's earlier pre-approval");
    expect(JSON.parse(await read(local))).not.toHaveProperty('permissions');
    expect((await status('claude-code')).out).toContain('Self-report pre-approval: off');
  });

  it('Gemini CLI: trust and includeTools on the javi entry only', async () => {
    const file = join(dir, '.gemini', 'settings.json');
    await mkdir(join(dir, '.gemini'), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { docs: { command: 'npx' } } }));
    expect((await init('gemini-cli', '--self-report', '--allow-self-report')).code).toBe(0);
    const servers = (JSON.parse(await read(file)) as { mcpServers: Record<string, unknown> })
      .mcpServers;
    expect(servers.docs).toEqual({ command: 'npx' });
    expect(servers.javi).toEqual({
      ...expectedEntry('gemini-cli'),
      trust: true,
      includeTools: ['report_status', 'report_task'],
    });
    expect((await status('gemini-cli')).out).toContain('Self-report pre-approval: on');
    expect((await init('gemini-cli', '--self-report')).code).toBe(0);
    expect(
      (JSON.parse(await read(file)) as { mcpServers: Record<string, unknown> }).mcpServers.javi,
    ).toEqual(expectedEntry('gemini-cli'));
  });

  it('Codex CLI: nothing to write', async () => {
    const result = await init('codex-cli', '--self-report', '--allow-self-report');
    expect(result.code).toBe(0);
    expect(result.out).toContain('--allow-self-report writes nothing for Codex CLI');
    expect(await entryOf('codex-cli')).toEqual(expectedEntry('codex-cli'));
  });

  it('only applies with --self-report', async () => {
    for (const flag of ['--allow-self-report', '--allow-tracked-config']) {
      const result = await init('claude-code', flag);
      expect(result.code).toBe(2);
      expect(result.err).toContain('only apply with --self-report');
    }
    expect(await createState(home).credentials('web-app')).toBeNull();
  });
});

it('plain init leaves the registration as it is; uninstall of another project leaves it too', async () => {
  expect((await init('claude-code', '--self-report')).code).toBe(0);
  const file = join(dir, '.mcp.json');
  const bytes = await read(file);
  expect((await init('claude-code')).code).toBe(0);
  expect(await read(file)).toBe(bytes);
  const t = io();
  expect(await main(['uninstall', '--project', 'other', '--dir', dir], t.value)).toBe(0);
  expect(await read(file)).toBe(bytes);
  expect((await status('claude-code')).out).toContain('Self-report: registered');
});

// Code review M3: a git check that cannot answer must not count as "untracked".
describe('git-tracked check fails closed', () => {
  type GitResult = ReturnType<GitRunner>;
  const ok = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '', signal: null });
  /** A runner that answers rev-parse and ls-files as given, recording every call. */
  const fakeGit = (revParse: GitResult, lsFiles: GitResult = ok()) => {
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      return args.includes('rev-parse') ? revParse : lsFiles;
    };
    return { run, calls };
  };
  const initWith = async (run: GitRunner, ...extra: string[]) => {
    const t = io();
    t.value.git = run;
    const code = await main(
      ['init', '--project', 'web-app', '--dir', dir, '--no-verify', '--self-report', ...extra],
      t.value,
    );
    return { code, out: t.out.join('\n'), err: t.err.join('\n') };
  };
  const dubious = "fatal: detected dubious ownership in repository at '/x'";

  it.each<[string, GitResult, GitResult?]>([
    ['exit 128 inside a work tree', ok('true\n'), { status: 128, stdout: '', stderr: dubious }],
    ['rev-parse exit 128 (dubious ownership)', { status: 128, stdout: '', stderr: dubious }],
    [
      'git missing (ENOENT)',
      {
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('x'), { code: 'ENOENT' }),
      },
    ],
    ['git killed by a signal', { status: null, stdout: '', stderr: '', signal: 'SIGTERM' }],
    ['ls-files killed', ok('true\n'), { status: null, stdout: '', stderr: '', signal: 'SIGKILL' }],
  ])('%s: refused unless --allow-tracked-config, nothing written', async (_, revParse, lsFiles) => {
    const { run, calls } = fakeGit(revParse, lsFiles);
    const refused = await initWith(run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('could not check whether git tracks');
    expect(refused.err).toContain(join(dir, '.mcp.json'));
    expect(refused.err).toContain('--allow-tracked-config');
    expect(await createState(home).credentials('web-app')).toBeNull();
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    // Plain argument lists, never a shell command line.
    expect(calls[0]).toEqual(['-C', dir, 'rev-parse', '--is-inside-work-tree']);
    expect((await initWith(run, '--allow-tracked-config')).code).toBe(0);
  });

  it('outside any repository (git says so): allowed', async () => {
    const { run, calls } = fakeGit({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    expect((await initWith(run)).code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('inside a work tree: ls-files 0 → tracked (refused), 1 → untracked (allowed)', async () => {
    const tracked = fakeGit(ok('true\n'), ok('.mcp.json\n'));
    const refused = await initWith(tracked.run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('tracked by git');
    expect(tracked.calls[1]).toEqual(['-C', dir, 'ls-files', '--error-unmatch', '--', '.mcp.json']);
    const untracked = fakeGit(ok('true\n'), { status: 1, stdout: '', stderr: 'error: pathspec' });
    expect((await initWith(untracked.run)).code).toBe(0);
  });

  it('real git: tracked → tracked, untracked → untracked, no repository → untracked', async () => {
    const file = join(dir, '.mcp.json');
    expect(gitTracking(dir, file)).toBe('untracked');
    git('init', '-q');
    await writeFile(file, '{}\n');
    expect(gitTracking(dir, file)).toBe('untracked');
    expect((await init('claude-code', '--self-report')).code).toBe(0);
    expect((await uninstall('claude-code')).code).toBe(0);
    git('add', '--', file);
    expect(gitTracking(dir, file)).toBe('tracked');
  });
});

// Code review M2: javi never registered self-report here, so a .mcp.json it cannot parse is not
// javi's business: uninstall warns once, removes the hooks, and leaves the file as it is.
it.each([
  ['a BOM', '\uFEFF{"mcpServers": {}}\n'],
  ['garbage', 'not json at all {'],
  ['an array', '[1, 2]\n'],
])(
  'uninstall with an unparsable .mcp.json (%s) javi never wrote: warning, hooks removed, exit 0',
  async (_, broken) => {
    expect((await init('claude-code')).code).toBe(0);
    const file = join(dir, '.mcp.json');
    await writeFile(file, broken);
    const result = await uninstall('claude-code');
    expect(result.code).toBe(0);
    const mentions = `${result.out}\n${result.err}`.split('\n').filter((l) => l.includes(file));
    expect(mentions).toHaveLength(1);
    expect(result.out).toContain(`Removed javi hooks from ${settingsPath(dir)}.`);
    expect(await read(settingsPath(dir))).not.toContain('javi-collector');
    expect(await read(file)).toBe(broken);
  },
);

it('uninstall still refuses an unparsable .mcp.json in which javi recorded a registration', async () => {
  expect((await init('claude-code', '--self-report')).code).toBe(0);
  const file = join(dir, '.mcp.json');
  const broken = `\uFEFF${await read(file)}`;
  await writeFile(file, broken);
  const result = await uninstall('claude-code');
  expect(result.code).toBe(1);
  expect(result.err).toContain(file);
  expect(await read(file)).toBe(broken);
  expect(await read(settingsPath(dir))).toContain('javi-collector');
});

// Code review L2: a .mcp.json javi created in a git repository is kept out of commits the way
// .claude/settings.local.json is, and uninstall takes back only the line javi added.
describe('.mcp.json created by javi in a git repository', () => {
  const exclude = () => join(dir, '.git', 'info', 'exclude');
  const porcelain = () =>
    execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });

  it('is added to .git/info/exclude, and uninstall removes exactly that line', async () => {
    git('init', '-q');
    const before = await read(exclude());
    const result = await init('claude-code', '--self-report');
    expect(result.code).toBe(0);
    expect(result.out).toContain('/.mcp.json added to .git/info/exclude');
    expect((await read(exclude())).split('\n')).toContain('/.mcp.json');
    expect(porcelain()).not.toContain('.mcp.json');
    // A re-run adds nothing twice.
    expect((await init('claude-code', '--self-report')).code).toBe(0);
    expect((await read(exclude())).split('\n').filter((l) => l === '/.mcp.json')).toHaveLength(1);

    expect((await uninstall('claude-code')).code).toBe(0);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    const after = await read(exclude());
    expect(after.split('\n')).not.toContain('/.mcp.json');
    // Everything that was there before javi is still there, in order.
    expect(after.startsWith(before)).toBe(true);
  });

  it('a .mcp.json that existed before is not excluded (javi did not create it)', async () => {
    git('init', '-q');
    await writeFile(join(dir, '.mcp.json'), '{}\n');
    expect((await init('claude-code', '--self-report')).code).toBe(0);
    expect((await read(exclude())).split('\n')).not.toContain('/.mcp.json');
  });

  it('a line the user had already is never removed', async () => {
    git('init', '-q');
    await writeFile(exclude(), '/.mcp.json\n');
    expect((await init('claude-code', '--self-report')).code).toBe(0);
    expect((await uninstall('claude-code')).code).toBe(0);
    // The user's line stays (javi's own .claude/settings.local.json line is S3 behaviour).
    expect((await read(exclude())).split('\n')[0]).toBe('/.mcp.json');
  });
});

// Code review L3: values read from a registration file (repository content) never reach the
// terminal with control characters (ANSI CSI, OSC title/hyperlink, C1).
it('status strips control characters from values read from the registration file', async () => {
  expect((await init('claude-code')).code).toBe(0);
  const csi = '\u001b[2J\u001b[31m';
  const osc = '\u001b]0;pwned\u0007';
  const c1 = '\u009b31m';
  const planted = (project: string) => ({
    mcpServers: {
      javi: {
        command: `/nowhere/${csi}node${c1}`,
        args: [
          '--no-warnings',
          `/nowhere/${osc}launcher\r\n`,
          '--platform',
          'claude-code',
          '--project',
          project,
          `/x/javi-mcp.mjs`,
        ],
      },
    },
  });
  const file = join(dir, '.mcp.json');
  await writeFile(file, JSON.stringify(planted('web-app')));
  const same = (await status('claude-code')).out;
  await writeFile(file, JSON.stringify(planted(`other${osc}${csi}`)));
  const other = (await status('claude-code')).out;
  for (const out of [same, other]) {
    // eslint-disable-next-line no-control-regex
    expect(out.replaceAll('\n', '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  }
  expect(same).toContain(
    'Warning: the Node.js path registered for self-report (/nowhere/[2J[31mnode31m)',
  );
  expect(same).toContain('Warning: the self-report launcher /nowhere/]0;pwnedlauncher is missing');
  expect(other).toContain('for another project (other]0;pwned[2J[31m)');
});

it.skipIf(process.platform === 'win32')(
  'status never reads a planted launcher path that is not javi’s launcher file (e.g. /dev/zero)',
  async () => {
    expect((await init('claude-code')).code).toBe(0);
    const args = ['--no-warnings', '/dev/zero', '--project', 'web-app', '/x/javi-mcp.mjs'];
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { javi: { command: process.execPath, args } } }),
    );
    expect((await status('claude-code')).out).toContain(
      'Warning: javi cannot read which javi the self-report launcher /dev/zero runs.',
    );
  },
);
