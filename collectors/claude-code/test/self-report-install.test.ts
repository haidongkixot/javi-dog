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
  main,
  mcpLauncherPath,
  registrationPath,
  settingsPath,
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

  it('Codex CLI project config.toml: marked block appended, comments kept, exact bytes back', async () => {
    const file = join(dir, '.codex', 'config.toml');
    await mkdir(join(dir, '.codex'), { recursive: true });
    const original =
      '# my project settings\nmodel = "gpt-5.5-codex"   # pinned\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["docs-mcp"]\n';
    await writeFile(file, original);
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    const after = await read(file);
    expect(after.startsWith(original)).toBe(true);
    expect(after.slice(original.length)).toBe(
      [
        '',
        '# >>> javi self-report (do not edit)',
        '[mcp_servers.javi]',
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${expectedEntry('codex-cli')
          .args.map((a) => JSON.stringify(a))
          .join(', ')}]`,
        '# <<< javi',
        '',
      ].join('\n'),
    );
    const parsed = parseToml(after) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(parsed.mcp_servers)).toEqual(['docs', 'javi']);
    expect((await init('codex-cli', '--self-report')).code).toBe(0);
    expect(await read(file)).toBe(after);
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
