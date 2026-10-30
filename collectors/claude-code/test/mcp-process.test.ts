import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_LOG_MESSAGES, MCP_RESULT_TEXTS } from '@javis-dog/collector-mcp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTOR_VERSION, main, mcpLauncherPath, type Io } from '../src/index.ts';

// `javi mcp` as MCP clients run it (TEST_PLAN §S5d rows "stdout carries only newline-terminated
// JSON-RPC", "`javi mcp` answers isError 'not recorded'"): a real node process on pipes, from
// the TypeScript CLI and from the built bundle through the unversioned launcher.

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BUILD = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
const TOKEN = `jd_it_${'M'.repeat(43)}`;
const SENTINEL = 'SENTINEL_S5D_MCP_PROCESS_41b9';
const WIN = process.platform === 'win32';

let temp: string;
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'javi-mcp-proc-'));
});
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Starts `command args`, writes `lines` (newline-terminated), closes stdin, waits for exit. */
const session = (
  command: string,
  args: string[],
  lines: unknown[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) =>
  new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(
      lines.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join(''),
    );
  });

const HANDSHAKE = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: SENTINEL, version: '1' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'report_status', arguments: { status: 'blocked', reason: 'missing_access' } },
  },
  {
    jsonrpc: '2.0',
    id: 'four',
    method: 'tools/call',
    params: { name: 'report_status', arguments: { status: 'blocked', note: SENTINEL } },
  },
  `{"jsonrpc":"2.0","id":5,"method":"${SENTINEL}"`,
];

/** Every stdout line is one JSON-RPC 2.0 response; returns them by id. */
const responses = (run: Run) => {
  expect(run.stdout.endsWith('\n')).toBe(true);
  const lines = run.stdout.slice(0, -1).split('\n');
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const message of parsed) {
    expect(message.jsonrpc).toBe('2.0');
    expect(Object.hasOwn(message, 'id')).toBe(true);
    expect(Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error')).toBe(true);
  }
  return parsed;
};

const textOf = (message: Record<string, unknown> | undefined) =>
  (message?.result as { content: Array<{ text: string }>; isError: boolean }).content[0]!.text;

/** stderr holds only javi's fixed log strings, no request text. */
const expectFixedStderr = (stderr: string) => {
  const allowed = new Set<string>(Object.values(MCP_LOG_MESSAGES));
  const lines = stderr.split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(allowed.has(line), line).toBe(true);
};

const expectSession = (run: Run, hooks: boolean) => {
  expect(run.code).toBe(0);
  const out = responses(run);
  expect(out.map((m) => m.id)).toEqual([1, 2, 3, 'four', null]);
  expect(out[0]!.result).toMatchObject({
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'javi', version: expect.any(String) },
    capabilities: { tools: { listChanged: false } },
  });
  expect((out[1]!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual([
    'report_status',
    'report_task',
  ]);
  expect(textOf(out[2])).toBe(
    hooks ? MCP_RESULT_TEXTS.noted.report_status : MCP_RESULT_TEXTS.hooksMissing,
  );
  expect((out[2]!.result as { isError: boolean }).isError).toBe(!hooks);
  expect(textOf(out[3])).toBe(MCP_RESULT_TEXTS.invalid.report_status);
  expect(out[4]!.error).toMatchObject({ code: -32700 });
  expectFixedStderr(run.stderr);
  for (const text of [run.stdout, run.stderr]) {
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(TOKEN);
  }
};

const ioFor = (home: string, cwd: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env: { JAVI_HOME: home, JAVI_INGEST_TOKEN: TOKEN, SHELL: '/bin/sh' },
    cwd,
    readStdin: async () => '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: () => {},
    spawnReceiver: () => {},
  };
  return { value, out, err };
};

describe('javi mcp from the TypeScript CLI', () => {
  it('hooks not installed: every call answers "not recorded"; stdout is JSON-RPC only', async () => {
    const home = join(temp, 'ts-home-none');
    const run = await session(
      process.execPath,
      [CLI, 'mcp', '--platform', 'claude-code', '--project', 'web-app'],
      HANDSHAKE,
      { ...process.env, JAVI_HOME: home },
      temp,
    );
    expectSession(run, false);
    // No receiver, no flush, no spool: the MCP process only answers.
    for (const name of ['receiver.json', 'last-flush', 'spool', 'credentials.json']) {
      expect(existsSync(join(home, name))).toBe(false);
    }
  });

  it('a bad command line prints usage on stderr only, exit 2', async () => {
    const run = await session(
      process.execPath,
      [CLI, 'mcp', '--platform', 'nope', '--project', 'web-app'],
      [],
      { ...process.env, JAVI_HOME: join(temp, 'ts-home-bad') },
      temp,
    );
    expect(run).toMatchObject({ code: 2, stdout: '' });
    expect(run.stderr).toContain('Usage: javi mcp');
  });

  it.each(['claude-code', 'gemini-cli', 'codex-cli'] as const)(
    'hooks installed by init --self-report (%s): the launcher started elsewhere answers "noted"',
    async (platform) => {
      const home = join(temp, `ts-home-${platform}`);
      const project = await mkdtemp(join(temp, `project-${platform}-`));
      const t = ioFor(home, project);
      const args = ['init', '--project', 'web-app', '--no-verify', '--self-report'];
      if (platform !== 'claude-code') args.push('--platform', platform);
      expect(await main(args, t.value), t.err.join('\n')).toBe(0);
      // An MCP client's cwd is not the project folder: javi's state says where the hooks are.
      const run = await session(
        process.execPath,
        ['--no-warnings', mcpLauncherPath(home), '--platform', platform, '--project', 'web-app'],
        HANDSHAKE,
        { ...process.env, JAVI_HOME: join(temp, 'ignored-by-the-launcher') },
        tmpdir(),
      );
      expectSession(run, true);
      // Another project of the same platform: not installed.
      const other = await session(
        process.execPath,
        ['--no-warnings', mcpLauncherPath(home), '--platform', platform, '--project', 'other'],
        HANDSHAKE,
        process.env,
        tmpdir(),
      );
      expectSession(other, false);
    },
  );
});

describe('javi mcp from the built bundle', () => {
  let out: string;
  let bundle: string;
  let built: Run;
  beforeAll(async () => {
    out = join(temp, 'dist');
    bundle = join(out, 'javi.mjs');
    // Built into the temp dir: the repo's dist/ stays untouched.
    built = await session(process.execPath, [BUILD, '--out', out], [], process.env, temp);
  }, 60_000);

  it('bundles JD-C03 and JD-C02 without the MCP SDK', async () => {
    expect(built.code, built.stderr).toBe(0);
    const text = await readFile(bundle, 'utf8');
    expect(text).not.toContain('modelcontextprotocol');
    expect(text).toContain('Server not initialized'); // JD-C03's JSON_RPC_ERRORS is inlined
    expect(text).toContain('mcp__javi__'); // JD-C02's matcher is inlined
    expect(built.stdout).toContain(`${((await stat(bundle)).size / 1024).toFixed(1)} KiB`);
  });

  it('init --self-report from the bundle registers the launcher of the installed copy', async () => {
    const home = join(temp, 'bundle-home');
    const project = await mkdtemp(join(temp, 'bundle-project-'));
    const init = await new Promise<Run>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [bundle, 'init', '--project', 'web-app', '--no-verify', '--self-report'],
        { env: { ...process.env, JAVI_HOME: home, JAVI_INGEST_TOKEN: TOKEN }, cwd: project },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    expect(init.code, init.stderr).toBe(0);
    const launcher = await readFile(mcpLauncherPath(home), 'utf8');
    // The launcher names the versioned installed copy, never the build output.
    expect(launcher).toContain(
      `const cli = ${JSON.stringify(join(home, 'bin', COLLECTOR_VERSION, 'javi.mjs'))};`,
    );
    expect(launcher).not.toContain(out);
    const mcp = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8')) as {
      mcpServers: { javi: { command: string; args: string[] } };
    };
    const { command, args } = mcp.mcpServers.javi;
    const run = await session(command, args, HANDSHAKE, process.env, tmpdir());
    expectSession(run, true);
  });

  it.skipIf(WIN)(
    'the launcher itself prints nothing when javi is missing (stderr only)',
    async () => {
      const home = join(temp, 'bundle-home');
      await rm(join(home, 'bin', COLLECTOR_VERSION), { recursive: true, force: true });
      const run = await session(
        process.execPath,
        [
          '--no-warnings',
          mcpLauncherPath(home),
          '--platform',
          'claude-code',
          '--project',
          'web-app',
        ],
        [],
        process.env,
        tmpdir(),
      );
      expect(run.stdout).toBe('');
      expect(run.code).not.toBe(0);
    },
  );
});
